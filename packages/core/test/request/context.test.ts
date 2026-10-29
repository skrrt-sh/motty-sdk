import { expect, spyOn, test } from 'bun:test';
import { motty } from '../../src/chain/motty.ts';
import { contractOf } from '../../src/chain/run.ts';
import type { RequestRecord } from '../../src/contract.ts';
import {
  Aborted,
  LimitReached,
  MottyError,
  TimedOut,
  UpstreamFailed,
} from '../../src/data/errors.ts';
import { answer } from '../../src/request/answer.ts';
import {
  admitted,
  beginAfterResponse,
  counted,
  current,
  endPhase,
  enter,
  hosted,
  openCall,
  phaseStopper,
  running,
} from '../../src/request/context.ts';
import { stubHost } from '../stub-host.ts';

test('outside a request there is no current state', () => {
  expect(() => current()).toThrow('outside a request');
});

test('outside a request nothing is running', () => {
  expect(running()).toBeUndefined();
});

test('hosted gives the caller, the storage and the settings the host supplied, and the signal in force', () => {
  const host = stubHost(
    {},
    {
      caller: { id: 'user_1' },
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      },
      settings: { tiers: { deep: 'acme/large' } },
      limits: { calls: 3 },
      record: () => {},
    },
  );

  const [supplied, state] = enter(host, () => [hosted(), current()] as const);

  expect(supplied.caller).toBe(host.caller);
  expect(supplied.settings).toBe(host.settings);
  expect(supplied.signal).toBe(state.signal);
  expect(Object.keys(supplied)).toEqual([
    'caller',
    'storage',
    'settings',
    'signal',
  ]);
});

test('a host that supplied a decision call that is no function is entered, and admitting it throws a plain error', () => {
  expect(() =>
    enter({ ...stubHost(), decisions: JSON.parse('true') }, () => admitted()),
  ).toThrow('The host must supply decisions as a function');
});

test('the storage hosted gives asks a storage that is an instance of a class to increment as its own method', async () => {
  class Counters {
    total = 5;
    async get() {
      return this.total;
    }
    async set() {}
    async delete() {}
    async increment(_key: string, by: number) {
      this.total += by;
      return this.total;
    }
  }
  const host = stubHost({}, { storage: new Counters() });

  expect(
    await enter(host, () => hosted().storage?.increment?.('spent', 2)),
  ).toBe(7);
});

test('the storage hosted gives has no increment when the storage of the host has none', () => {
  const host = stubHost(
    {},
    {
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
      },
    },
  );

  expect(enter(host, () => hosted().storage?.increment)).toBeUndefined();
});

test('a storage call that never resolves ends with Aborted once the signal fires', async () => {
  const stop = new AbortController();
  const host = stubHost(
    {},
    {
      signal: stop.signal,
      storage: {
        get: () => new Promise(() => {}),
        set: () => new Promise(() => {}),
        delete: () => new Promise(() => {}),
      },
    },
  );

  const reads = enter(host, () => {
    const { storage } = hosted();
    return Promise.allSettled([
      storage?.get('tier'),
      storage?.set('tier', 1),
      storage?.delete('tier'),
    ]);
  });
  stop.abort();

  expect(
    (await reads).map((read) =>
      read.status === 'rejected' ? read.reason instanceof Aborted : read,
    ),
  ).toEqual([true, true, true]);
});

test('inside a request the state gives the host and its limits, and a signal the stop signal of the host fires', () => {
  const stop = new AbortController();
  const host = stubHost(
    {},
    { signal: stop.signal, limits: { calls: 3, afterResponse: 45_000 } },
  );
  const state = enter(host, () => current());
  const before = state.signal.aborted;
  stop.abort(new TimedOut('The host gave the request two minutes'));

  expect(state.host).toBe(host);
  expect(state.limits).toEqual({ calls: 3, afterResponse: 45_000 });
  expect([before, state.signal.aborted]).toEqual([false, true]);
  expect(state.signal.reason).toBe(stop.signal.reason);
});

test('a counted call resolves with its result and is recorded with its name, its time and the usage read from the result', async () => {
  const [reply, calls] = await enter(
    stubHost(),
    async () =>
      [
        await counted(
          'typesafe/jev',
          async () => {
            await Bun.sleep(5);
            return {
              noul: 0.02,
              usage: {
                input: 3,
                output: 2,
                cached: 1,
                cacheWrite: 5,
                reasoning: 0,
              },
            };
          },
          (result) => result.usage,
        ),
        current().calls,
      ] as const,
  );

  expect(reply.noul).toBe(0.02);
  expect(calls.made).toEqual([
    {
      model: 'typesafe/jev',
      input: 3,
      output: 2,
      cached: 1,
      cacheWrite: 5,
      reasoning: 0,
      time: { total: expect.any(Number) },
    },
  ]);
  expect(calls.made[0]?.time.total).toBeGreaterThanOrEqual(4);
  expect(Object.isFrozen(calls.made[0]?.time)).toBe(true);
  expect(calls.total).toEqual({
    input: 3,
    output: 2,
    cached: 1,
    cacheWrite: 5,
    reasoning: 0,
  });
});

test('a counted call with no way to read usage records no count and adds nothing', async () => {
  const calls = await enter(stubHost(), async () => {
    await counted('typesafe/jev', async () => ({ usage: { input: 3 } }));
    return current().calls;
  });

  expect(calls.made).toStrictEqual([
    { model: 'typesafe/jev', time: { total: expect.any(Number) } },
  ]);
  expect(calls.total).toStrictEqual({});
});

test('a count the call did not report stays absent, and a reported zero is kept', async () => {
  const calls = await enter(stubHost(), async () => {
    await counted(
      'acme/small',
      async () => ({ input: 3, reasoning: 0 }),
      (usage) => usage,
    );
    return current().calls;
  });

  expect(calls.made).toStrictEqual([
    {
      model: 'acme/small',
      input: 3,
      reasoning: 0,
      time: { total: expect.any(Number) },
    },
  ]);
  expect(calls.total).toStrictEqual({ input: 3, reasoning: 0 });
});

test('the totals sum the usage of every call, and an optional count joins once any call reported it', async () => {
  const total = await enter(stubHost(), async () => {
    await counted(
      'acme/small',
      async () => ({ input: 3, output: 2 }),
      (usage) => usage,
    );
    await counted(
      'acme/large',
      async () => ({ input: 10, output: 20, cacheWrite: 1 }),
      (usage) => usage,
    );
    return current().calls.total;
  });

  expect(total).toStrictEqual({ input: 13, output: 22, cacheWrite: 1 });
});

test('a call that says its first event arrived and how it failed is recorded with both, the first arrival alone timed', async () => {
  const made = await enter(stubHost(), async () => {
    await counted(
      'acme/small',
      async (_signal, arrived) => {
        await Bun.sleep(5);
        arrived();
        await Bun.sleep(5);
        arrived();
        return 'cut short';
      },
      () => ({ output: 2, code: 'overloaded' }),
    );
    return current().calls.made;
  });

  expect(made).toStrictEqual([
    {
      model: 'acme/small',
      output: 2,
      code: 'overloaded',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
    },
  ]);
  expect(made[0]?.time.firstEvent).toBeGreaterThanOrEqual(4);
  expect(made[0]?.time.firstEvent).toBeLessThan(9);
  expect(made[0]?.time.total).toBeGreaterThanOrEqual(9);
});

test('a counted call that rejects is counted with the code of its failure and rejects with what it threw', async () => {
  const failure = new UpstreamFailed('The decision model is down');

  const [thrown, made] = await enter(
    stubHost(),
    async () =>
      [
        await counted('typesafe/jev', () => Promise.reject(failure)).catch(
          (caught: unknown) => caught,
        ),
        current().calls.made,
      ] as const,
  );

  expect(thrown).toBe(failure);
  expect(made).toStrictEqual([
    {
      model: 'typesafe/jev',
      code: 'upstream_failed',
      message: 'The decision model is down',
      time: { total: expect.any(Number) },
    },
  ]);
});

test('a counted call that throws when asked is counted as an internal failure, with nothing of what was thrown', async () => {
  const made = await enter(stubHost(), async () => {
    await counted('typesafe/jev', () => {
      throw new TypeError('decide is not a function');
    }).catch(() => {});
    return current().calls.made;
  });

  expect(made).toStrictEqual([
    {
      model: 'typesafe/jev',
      code: 'internal',
      message: 'Internal error',
      time: { total: expect.any(Number) },
    },
  ]);
});

test('the calls view read before a call grows as calls are made', async () => {
  await enter(stubHost(), async () => {
    const { calls } = current();
    await counted(
      'acme/small',
      async () => ({ input: 3, output: 2 }),
      (usage) => usage,
    );
    expect(current().calls).toBe(calls);
    expect(calls.made).toHaveLength(1);
    expect(calls.total.input).toBe(3);
  });
});

test('what calls gives out is frozen, and replaced when a call settles', async () => {
  await enter(stubHost(), async () => {
    const { calls } = current();
    const { made, total } = calls;
    await counted(
      'acme/small',
      async () => ({ input: 3, output: 2 }),
      (usage) => usage,
    );

    expect(made).toEqual([]);
    expect(total).toEqual({});
    expect(calls.made).toBe(calls.made);
    expect(calls.total).toBe(calls.total);
    expect(
      [calls, made, total, calls.made, calls.made[0], calls.total].map(
        Object.isFrozen,
      ),
    ).not.toContain(false);
  });
});

test('the call past the limit rejects with LimitReached, is not asked and is not counted', async () => {
  const asked: string[] = [];

  await enter(stubHost({}, { limits: { calls: 2 } }), async () => {
    await counted('acme/small', async () => asked.push('first'));
    await counted('acme/small', async () => asked.push('second'));
    await expect(
      counted('acme/large', async () => asked.push('third')),
    ).rejects.toBeInstanceOf(LimitReached);
    expect(current().calls.made.map((call) => call.model)).toEqual([
      'acme/small',
      'acme/small',
    ]);
  });

  expect(asked).toEqual(['first', 'second']);
});

test('calls still in flight count toward the limit, and a refused call leaves the limit where it was', async () => {
  const gate = Promise.withResolvers<string>();

  await enter(stubHost({}, { limits: { calls: 1 } }), async () => {
    const call = counted('acme/small', () => gate.promise);
    await expect(
      counted('acme/large', async () => 'Hi'),
    ).rejects.toBeInstanceOf(LimitReached);
    gate.resolve('Hi');
    await call;
    await expect(
      counted('acme/large', async () => 'Hi'),
    ).rejects.toBeInstanceOf(LimitReached);
    expect(current().calls.made).toHaveLength(1);
  });
});

test('a call begun once the signal has fired rejects with the stop, is not asked and takes no slot of the limit', async () => {
  const asked: string[] = [];
  const host = stubHost(
    {},
    { signal: AbortSignal.abort(), limits: { calls: 0 } },
  );

  const thrown = await enter(host, () =>
    counted('acme/small', async () => asked.push('asked')).catch(
      (caught: unknown) => caught,
    ),
  );

  expect(thrown).toBeInstanceOf(Aborted);
  expect(asked).toEqual([]);
  expect(enter(host, () => current().calls.made)).toEqual([]);
});

test('a counted call that never settles ends with the stop once the signal fires, and is counted as aborted', async () => {
  const stop = new AbortController();

  const [thrown, made] = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      const call = counted('typesafe/jev', () => new Promise(() => {}));
      stop.abort();
      return [
        await call.catch((caught: unknown) => caught),
        current().calls.made,
      ] as const;
    },
  );

  expect(thrown).toBeInstanceOf(Aborted);
  expect(made).toStrictEqual([
    {
      model: 'typesafe/jev',
      code: 'aborted',
      message: 'The work was stopped',
      time: { total: expect.any(Number) },
    },
  ]);
});

test('with a call limit that is a fraction the request is entered, and admitting it throws a plain error naming the limit', () => {
  const failure = enter(stubHost({}, { limits: { calls: 1.5 } }), () => {
    try {
      admitted();
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  });

  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(MottyError);
  expect(failure).toHaveProperty(
    'message',
    'limits.calls must be a whole number of zero or more',
  );
});

test('with an after-response limit that is infinite the request is entered, and admitting it throws a plain error naming the limit', () => {
  expect(() =>
    enter(
      stubHost({}, { limits: { afterResponse: Number.POSITIVE_INFINITY } }),
      () => admitted(),
    ),
  ).toThrow('limits.afterResponse must be a finite number of zero or more');
});

test('a host that supplied no stop signal is entered with a signal of its own, and admitting it throws a plain error', () => {
  const [signal, failure] = enter(
    { ...stubHost(), signal: JSON.parse('null') },
    () => {
      try {
        admitted();
      } catch (thrown) {
        return [current().signal, thrown] as const;
      }
      return [current().signal, undefined] as const;
    },
  );

  expect(signal.aborted).toBe(false);
  expect(failure).not.toBeInstanceOf(MottyError);
  expect(failure).toHaveProperty(
    'message',
    'The host must supply signal, an AbortSignal',
  );
});

test('a host that supplied what it should is admitted', () => {
  expect(
    enter(stubHost({}, { limits: { calls: 0, afterResponse: 0 } }), () => {
      admitted();
      return current().limits;
    }),
  ).toEqual({ calls: 0, afterResponse: 0 });
});

test('limits given as null are no limits', () => {
  expect(
    enter({ ...stubHost(), limits: JSON.parse('null') }, () => {
      admitted();
      return current().limits;
    }),
  ).toEqual({});
});

test('a host that changes its limits after the request started does not change the request', async () => {
  const limits = { calls: 1, afterResponse: 45_000 };
  await enter(stubHost({}, { limits }), async () => {
    limits.calls = Number.NaN;
    limits.afterResponse = 0;
    expect(current().limits).toEqual({ calls: 1, afterResponse: 45_000 });
    expect(current().limits).not.toBe(limits);
    await counted('acme/small', async () => 'Hi');
    await expect(
      counted('acme/small', async () => 'Hi'),
    ).rejects.toBeInstanceOf(LimitReached);
  });
});

test('the phase in force is stopped by whoever was given its stop, with the reason given', () => {
  const reason = new TimedOut('After-response work passed its time limit');

  const [closed, limited] = enter(stubHost(), () => {
    const answering = current().signal;
    phaseStopper()();
    const afterResponse = beginAfterResponse().signal;
    phaseStopper()(reason);
    return [answering, afterResponse];
  });

  expect(closed?.aborted).toBe(true);
  expect(limited?.reason).toBe(reason);
});

test('ending a phase the host already stopped leaves the reason of the host', async () => {
  const stop = new AbortController();
  const reason = new TimedOut('The host gave the request two minutes');

  const signal = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      stop.abort(reason);
      await endPhase();
      return current().signal;
    },
  );

  expect(signal.reason).toBe(reason);
});

test('ending a phase cancels the calls still open and goes on only when each has settled, so the counts are whole', async () => {
  const cancelled: unknown[] = [];

  const [calls, rejected] = await enter(stubHost(), async () => {
    const silent = counted('acme/large', (signal) => {
      signal.addEventListener('abort', () => cancelled.push(signal.reason));
      return new Promise(() => {});
    }).catch((thrown: unknown) => thrown);
    const reporting = counted(
      'acme/small',
      (signal) =>
        new Promise<{ input: number }>((resolve) =>
          signal.addEventListener('abort', () => resolve({ input: 7 })),
        ),
      (usage) => usage,
    );
    await endPhase();
    return [current().calls, [await silent, await reporting]] as const;
  });

  expect(cancelled).toHaveLength(1);
  expect(rejected[0]).toBeInstanceOf(Aborted);
  expect(rejected[1]).toEqual({ input: 7 });
  expect(calls.made).toEqual([
    { model: 'acme/small', input: 7, time: { total: expect.any(Number) } },
    {
      model: 'acme/large',
      code: 'aborted',
      message: 'The work was stopped',
      time: { total: expect.any(Number) },
    },
  ]);
  expect(calls.total).toEqual({ input: 7 });
});

test('a phase with no call open ends without a timer or a turn of the event loop', async () => {
  const timers = spyOn(globalThis, 'setTimeout');

  await enter(stubHost(), async () => {
    await counted('acme/small', async () => 'Hi');
    await endPhase();
  });
  const set = timers.mock.calls.length;
  timers.mockRestore();

  expect(set).toBe(0);
});

test('detaching gives the request a new signal, which the stop signal of the host does not fire', () => {
  const stop = new AbortController();
  enter(stubHost({}, { signal: stop.signal }), () => {
    const state = current();
    const answering = state.signal;
    const signal = beginAfterResponse().signal;
    stop.abort();

    expect(answering.aborted).toBe(true);
    expect(signal.aborted).toBe(false);
    expect(state.signal).toBe(signal);
    expect(current()).toBe(state);
  });
});

test('a call begun after detaching follows the new signal and still counts against the same limit', async () => {
  await enter(stubHost({}, { limits: { calls: 2 } }), async () => {
    await counted('acme/small', async () => 'Hi');
    await endPhase();
    const afterResponse = beginAfterResponse().signal;

    expect(await counted('acme/small', async (signal) => signal)).toBe(
      afterResponse,
    );
    await expect(
      counted('acme/small', async () => 'Hi'),
    ).rejects.toBeInstanceOf(LimitReached);
  });
});

test('a counted call nobody awaits is stopped when its phase ends and raises no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const heard = (thrown: unknown) => unhandled.push(thrown);
  process.on('unhandledRejection', heard);
  const over = Promise.withResolvers<RequestRecord>();

  await Array.fromAsync(
    contractOf(
      motty({ name: 'coder' }).handle(() => {
        counted('jev/never', () => new Promise(() => {}));
        return answer('Hi');
      }),
    ).run(
      {
        id: 'req_1',
        model: 'motty/coder',
        messages: [{ role: 'user', text: 'Why does this deadlock?' }],
        tools: [],
        options: {},
        headers: new Headers(),
      },
      stubHost({}, { record: over.resolve }),
    ),
  );
  const { calls } = await over.promise;
  await Bun.sleep(1);
  process.off('unhandledRejection', heard);

  expect(calls.map((call) => [call.model, call.code])).toEqual([
    ['jev/never', 'aborted'],
  ]);
  expect(unhandled).toEqual([]);
});

test('usage added to a call that has closed replaces its entry and the total, and what was read before stays as it was', () => {
  const outcome = enter(stubHost(), () => {
    const stopped = openCall('acme/slow');
    openCall('acme/fast').close({ input: 1, output: 1 });
    stopped.close({ code: 'aborted' });
    const calls = current().calls;
    const before = { made: calls.made, total: calls.total };
    stopped.addUsage({ input: 40, output: -2, cost: 0.5 });
    return { before, made: calls.made, total: calls.total };
  });

  expect(outcome.before.made[1]).toEqual({
    model: 'acme/slow',
    time: { total: expect.any(Number) },
    code: 'aborted',
  });
  expect(outcome.before.total).toEqual({ input: 1, output: 1 });
  expect(outcome.made[0]).toBe(outcome.before.made[0]);
  expect(outcome.made[1]).toEqual({
    model: 'acme/slow',
    input: 40,
    cost: 0.5,
    time: { total: expect.any(Number) },
    code: 'aborted',
  });
  expect(outcome.total).toEqual({ input: 41, output: 1, cost: 0.5 });
  expect([
    Object.isFrozen(outcome.made),
    Object.isFrozen(outcome.made[1]),
    Object.isFrozen(outcome.total),
  ]).toEqual([true, true, true]);
});

test('usage added to a call that has not closed is not counted', () => {
  const calls = enter(stubHost(), () => {
    const open = openCall('acme/small');
    open.addUsage({ input: 40 });
    open.close();
    return current().calls;
  });

  expect(calls.made).toEqual([
    { model: 'acme/small', time: { total: expect.any(Number) } },
  ]);
  expect(calls.total).toEqual({});
});
