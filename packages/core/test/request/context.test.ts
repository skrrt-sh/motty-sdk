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

test('outside a request nothing is hosted', () => {
  expect(() => hosted()).toThrow('outside a request');
});

test('outside a request nothing is running', () => {
  expect(running()).toBeUndefined();
});

test('inside a request running gives the current state', () => {
  enter(stubHost(), () => {
    expect(running()).toBe(current());
  });
});

test('the mistake of calling outside a request is a plain error', () => {
  expect(() => current()).not.toThrow(LimitReached);
});

test('enter returns what the run returned', () => {
  expect(enter(stubHost(), () => 'done')).toBe('done');
});

test('a request starts with no calls and no count in the totals', () => {
  expect(enter(stubHost(), () => current().calls)).toEqual({
    made: [],
    total: {},
  });
});

test('the state is the same across awaits and nested async calls', async () => {
  const seen = await enter(stubHost(), async () => {
    const first = current();
    await Bun.sleep(1);
    const nested = await (async () => {
      await Promise.resolve();
      return current();
    })();
    return [first, current(), nested];
  });
  expect(seen[1]).toBe(seen[0]);
  expect(seen[2]).toBe(seen[0]);
});

test('a timer started in a request still belongs to it after enter returned', async () => {
  const fired = Promise.withResolvers<ReturnType<typeof running>>();
  const state = enter(stubHost(), () => {
    setTimeout(() => fired.resolve(running()), 1);
    return current();
  });

  expect(running()).toBeUndefined();
  expect(await fired.promise).toBe(state);
});

test('outside a request no call can be counted', async () => {
  await expect(counted('acme/small', async () => 'Hi')).rejects.toThrow(
    'outside a request',
  );
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

test('hosted gives the decision call the host supplied, which passes the input and the result on unchanged', async () => {
  const asked: unknown[] = [];
  const host = stubHost(
    {},
    {
      decisions: async (model, input, signal) => {
        asked.push(model, input, signal);
        return { answers: { software: { type: 'noul', noul: 0.97 } } };
      },
    },
  );
  const input = { state: 'What does git stash do?', questions: {} };

  const [result, signal] = await enter(host, async () => {
    const { decisions } = hosted();
    return [
      await counted('typesafe/jev', async (signal) =>
        decisions?.('typesafe/jev', input, signal),
      ),
      current().signal,
    ] as const;
  });

  expect(result).toEqual({
    answers: { software: { type: 'noul', noul: 0.97 } },
  });
  expect(asked).toEqual(['typesafe/jev', input, signal]);
  expect(asked[1]).toBe(input);
});

test('a host that supplied a decision call that is no function is entered, and admitting it throws a plain error', () => {
  expect(() =>
    enter({ ...stubHost(), decisions: JSON.parse('true') }, () => admitted()),
  ).toThrow('The host must supply decisions as a function');
});

test('hosted leaves out what the host did not supply', () => {
  expect(Object.keys(enter(stubHost(), () => hosted()))).toEqual(['signal']);
});

test('what hosted gives is read-only by type', () => {
  enter(
    stubHost({}, { caller: { id: 'user_1' }, settings: { tiers: {} } }),
    () => {
      const supplied = hosted();
      // @ts-expect-error
      supplied.caller = { id: 'user_2' };
      // @ts-expect-error
      if (supplied.caller !== undefined) supplied.caller.id = 'user_2';
      const group: string = 'tiers';
      // @ts-expect-error
      if (supplied.settings !== undefined) supplied.settings[group] = 1;
      // @ts-expect-error
      supplied.signal = AbortSignal.abort();
      expect(supplied.caller?.id).toBe('user_2');
    },
  );
});

test('the storage hosted gives cannot be given other methods by type, its methods are called as they are, and data that is read-only is stored', async () => {
  const stored: unknown[] = [];

  const read = await enter(
    stubHost(
      {},
      {
        storage: {
          get: async () => 'deep',
          set: async (_key, value) => {
            stored.push(value);
          },
          delete: async () => {},
        },
      },
    ),
    async () => {
      const { storage } = hosted();
      if (storage === undefined) return undefined;
      // @ts-expect-error
      storage.get = async () => 'fast';
      await storage.set('tiers', { order: ['deep', 'fast'] } as const);
      return storage.get('tier');
    },
  );

  expect(read).toBe('fast');
  expect(stored).toEqual([{ order: ['deep', 'fast'] }]);
});

test('a handler of a running motty reads what the host supplied', async () => {
  const host = stubHost(
    {},
    {
      caller: { id: 'user_1' },
      settings: { tiers: { deep: 'acme/large' } },
      limits: { calls: 3 },
    },
  );
  const seen = [];

  for await (const event of contractOf(
    motty({ name: 'coder' }).handle(() => {
      const { caller, settings } = hosted();
      return answer(JSON.stringify({ caller, settings }));
    }),
  ).run(
    {
      id: 'req_1',
      model: 'motty/coder',
      messages: [{ role: 'user', text: 'Hello' }],
      tools: [],
      options: {},
      headers: new Headers(),
    },
    host,
  )) {
    seen.push(event);
  }

  expect(seen).toEqual([
    {
      type: 'text',
      text: '{"caller":{"id":"user_1"},"settings":{"tiers":{"deep":"acme/large"}}}',
    },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
});

test('the signal hosted gives is the one in force when read: the answering one in a handler, the after-response one after', async () => {
  const read = Promise.withResolvers<boolean[]>();
  const signals: AbortSignal[] = [];

  for await (const _ of contractOf(
    motty({ name: 'coder' })
      .handle(({ signal }) => {
        signals.push(hosted().signal, signal);
        return answer('Hi');
      })
      .afterResponse(({ signal }) => {
        signals.push(hosted().signal, signal);
        read.resolve(signals.map((held) => held.aborted));
      }),
  ).run(
    {
      id: 'req_1',
      model: 'motty/coder',
      messages: [{ role: 'user', text: 'Hello' }],
      tools: [],
      options: {},
      headers: new Headers(),
    },
    stubHost(),
  )) {
  }

  expect(await read.promise).toEqual([true, true, false, false]);
  expect(signals[0]).toBe(signals[1]);
  expect(signals[2]).toBe(signals[3]);
  expect(signals[2]).not.toBe(signals[0]);
});

test('the storage hosted gives passes each call on to the storage of the host', async () => {
  const stored = new Map<string, string>();
  const host = stubHost(
    {},
    {
      storage: {
        get: async (key) => stored.get(key),
        set: async (key, value, options) => {
          stored.set(key, JSON.stringify([value, options]));
        },
        delete: async (key) => {
          stored.delete(key);
        },
      },
    },
  );

  const read = await enter(host, async () => {
    const { storage } = hosted();
    await storage?.set('tier', 'deep', { ttl: 60 });
    const kept = await storage?.get('tier');
    await storage?.set('gone', 'soon');
    await storage?.delete('gone');
    return kept;
  });

  expect(read).toBe('["deep",{"ttl":60}]');
  expect([...stored.keys()]).toEqual(['tier']);
});

test('the storage hosted gives passes an increment on to the storage of the host, and gives back its total', async () => {
  const added: unknown[] = [];
  const host = stubHost(
    {},
    {
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        increment: async (...given) => {
          added.push(given);
          return 7;
        },
      },
    },
  );

  const total = await enter(host, () =>
    hosted().storage?.increment?.('spent', 2, { ttl: 60 }),
  );

  expect(total).toBe(7);
  expect(added).toEqual([['spent', 2, { ttl: 60 }]]);
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

test('an increment that never resolves ends with Aborted once the signal fires', async () => {
  const stop = new AbortController();
  const host = stubHost(
    {},
    {
      signal: stop.signal,
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        increment: () => new Promise(() => {}),
      },
    },
  );

  const added = enter(host, () => hosted().storage?.increment?.('spent', 1));
  stop.abort();

  await expect(added).rejects.toBeInstanceOf(Aborted);
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

test('a storage that throws when asked rejects the call with what it threw', async () => {
  const host = stubHost(
    {},
    {
      storage: {
        get: () => {
          throw new Error('redis down');
        },
        set: async () => {},
        delete: async () => {},
      },
    },
  );

  await expect(
    enter(host, () => hosted().storage?.get('tier')),
  ).rejects.toThrow('redis down');
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

test('a host with no limits gives the request none of its own', () => {
  expect(enter(stubHost(), () => current().limits)).toEqual({});
});

test('two concurrent requests have distinct states and counts', async () => {
  const [one, two] = await Promise.all([
    enter(stubHost(), async () => {
      await counted(
        'acme/small',
        async () => {
          await Bun.sleep(2);
          return { input: 1, output: 1 };
        },
        (usage) => usage,
      );
      return current();
    }),
    enter(stubHost(), async () => {
      await Bun.sleep(1);
      await counted(
        'acme/large',
        async () => ({ input: 5, output: 7 }),
        (usage) => usage,
      );
      return current();
    }),
  ]);
  expect(one).not.toBe(two);
  expect(one.calls.made.map((call) => call.model)).toEqual(['acme/small']);
  expect(two.calls.made.map((call) => call.model)).toEqual(['acme/large']);
  expect(two.calls.total).toEqual({ input: 5, output: 7 });
});

test('a second request on the same host starts with fresh counts', async () => {
  const host = stubHost();
  await enter(host, () => counted('acme/small', async () => 'Hi'));
  expect(enter(host, () => current().calls.made)).toEqual([]);
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
      latencyMs: expect.any(Number),
    },
  ]);
  expect(calls.made[0]?.latencyMs).toBeGreaterThanOrEqual(4);
  expect(calls.total).toEqual({
    input: 3,
    output: 2,
    cached: 1,
    cacheWrite: 5,
    reasoning: 0,
  });
});

test('a counted call is given the signal in force', async () => {
  const [given, state] = await enter(
    stubHost(),
    async () =>
      [
        await counted('typesafe/jev', async (signal) => signal),
        current(),
      ] as const,
  );

  expect(given).toBe(state.signal);
});

test('a counted call with no way to read usage records no count and adds nothing', async () => {
  const calls = await enter(stubHost(), async () => {
    await counted('typesafe/jev', async () => ({ usage: { input: 3 } }));
    return current().calls;
  });

  expect(calls.made).toStrictEqual([
    { model: 'typesafe/jev', latencyMs: expect.any(Number) },
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
      latencyMs: expect.any(Number),
    },
  ]);
  expect(calls.total).toStrictEqual({ input: 3, reasoning: 0 });
});

test('a count a call reports that is not a whole number is dropped, and the totals stay numbers', async () => {
  const calls = await enter(stubHost(), async () => {
    await counted(
      'typesafe/jev',
      async () => JSON.parse('{"input":"3","output":2,"cached":1.5}'),
      (usage) => usage,
    );
    await counted(
      'typesafe/jev',
      async () => ({ input: 4, output: 1 }),
      (usage) => usage,
    );
    return current().calls;
  });

  expect(calls.made).toStrictEqual([
    { model: 'typesafe/jev', output: 2, latencyMs: expect.any(Number) },
    {
      model: 'typesafe/jev',
      input: 4,
      output: 1,
      latencyMs: expect.any(Number),
    },
  ]);
  expect(calls.total).toStrictEqual({ input: 4, output: 3 });
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

test('the totals sum the cost each call reported, and hold none when no call reported one', async () => {
  const totals = await enter(stubHost(), async () => {
    await counted(
      'acme/small',
      async () => ({ input: 3 }),
      (usage) => usage,
    );
    const before = current().calls.total;
    await counted(
      'acme/small',
      async () => ({ input: 3, cost: 0.25 }),
      (usage) => usage,
    );
    await counted(
      'acme/large',
      async () => ({ input: 10, cost: 0.5 }),
      (usage) => usage,
    );
    return { before, total: current().calls.total, made: current().calls.made };
  });

  expect(totals.before).toStrictEqual({ input: 3 });
  expect(totals.total).toStrictEqual({ input: 16, cost: 0.75 });
  expect(totals.made[1]).toStrictEqual({
    model: 'acme/small',
    input: 3,
    cost: 0.25,
    latencyMs: expect.any(Number),
  });
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
      firstEventMs: expect.any(Number),
      code: 'overloaded',
      latencyMs: expect.any(Number),
    },
  ]);
  expect(made[0]?.firstEventMs).toBeGreaterThanOrEqual(4);
  expect(made[0]?.firstEventMs).toBeLessThan(9);
  expect(made[0]?.latencyMs).toBeGreaterThanOrEqual(9);
});

test('a call given up at the stop keeps the time to its first event', async () => {
  const stop = new AbortController();

  const made = await enter(stubHost({}, { signal: stop.signal }), async () => {
    const call = counted('acme/small', (_signal, arrived) => {
      arrived();
      return new Promise(() => {});
    });
    stop.abort();
    await call.catch(() => {});
    return current().calls.made;
  });

  expect(made).toStrictEqual([
    {
      model: 'acme/small',
      firstEventMs: expect.any(Number),
      code: 'aborted',
      message: 'The work was stopped',
      latencyMs: expect.any(Number),
    },
  ]);
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
      latencyMs: expect.any(Number),
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
      latencyMs: expect.any(Number),
    },
  ]);
});

test('a call is not recorded until it ends', async () => {
  const gate = Promise.withResolvers<string>();

  await enter(stubHost(), async () => {
    const call = counted('acme/small', () => gate.promise);
    expect(current().calls).toEqual({ made: [], total: {} });
    gate.resolve('Hi');
    await call;
    expect(current().calls.made).toHaveLength(1);
  });
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

test('nothing assigned through a widened view of calls changes the counts', () => {
  enter(stubHost(), () => {
    const { calls } = current();
    const view: { made: unknown; total: unknown } = calls;
    const total: { input?: number } = calls.total;

    expect(() => {
      view.made = [{ model: 'acme/free', latencyMs: 0 }];
    }).toThrow(TypeError);
    expect(() => {
      view.total = { input: 1_000_000, output: 0 };
    }).toThrow(TypeError);
    expect(() => {
      total.input = 1_000_000;
    }).toThrow(TypeError);
    expect(calls).toEqual({ made: [], total: {} });
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

test('a limit of zero refuses the first call', async () => {
  await enter(stubHost({}, { limits: { calls: 0 } }), async () => {
    await expect(
      counted('acme/small', async () => 'Hi'),
    ).rejects.toBeInstanceOf(LimitReached);
    expect(current().calls.made).toEqual([]);
  });
});

test('no limit means no cap', async () => {
  const made = await enter(stubHost(), async () => {
    for (let count = 0; count < 100; count += 1) {
      await counted('acme/small', async () => 'Hi');
    }
    return current().calls.made;
  });
  expect(made).toHaveLength(100);
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
      latencyMs: expect.any(Number),
    },
  ]);
});

test('the error a host gave as the reason of its stop is the one a stopped call rejects with', async () => {
  const stop = new AbortController();
  const reason = new TimedOut('The host gave the request two minutes');

  const [thrown, made] = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      const call = counted('typesafe/jev', () => new Promise(() => {}));
      stop.abort(reason);
      return [
        await call.catch((caught: unknown) => caught),
        current().calls.made,
      ] as const;
    },
  );

  expect(thrown).toBe(reason);
  expect(made.map((call) => call.code)).toEqual(['timed_out']);
});

test('a counted call that follows the signal itself ends the way it says', async () => {
  const stop = new AbortController();

  const [reply, made] = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      const call = counted(
        'typesafe/jev',
        (signal) =>
          new Promise<{ usage: { input: number } }>((resolve) =>
            signal.addEventListener('abort', () =>
              resolve({ usage: { input: 40 } }),
            ),
          ),
        (result) => result.usage,
      );
      stop.abort();
      return [await call, current().calls.made] as const;
    },
  );

  expect(reply).toEqual({ usage: { input: 40 } });
  expect(made).toStrictEqual([
    { model: 'typesafe/jev', input: 40, latencyMs: expect.any(Number) },
  ]);
});

test('a call ended after enter returned still counts into its request', async () => {
  const gate = Promise.withResolvers<{ input: number; output: number }>();
  const held = enter(stubHost(), () => ({
    call: counted(
      'acme/small',
      () => gate.promise,
      (usage) => usage,
    ),
    calls: current().calls,
  }));

  gate.resolve({ input: 3, output: 2 });
  await held.call;

  expect(held.calls.made).toHaveLength(1);
  expect(held.calls.total).toEqual({ input: 3, output: 2 });
});

test.each([
  ['null', JSON.parse('null')],
  ['not a number', Number.NaN],
  ['a fraction', 1.5],
  ['text', JSON.parse('"3"')],
  ['negative', -1],
  ['infinite', Number.POSITIVE_INFINITY],
])(
  'with a call limit that is %s the request is entered, and admitting it throws a plain error naming the limit',
  (_name, calls) => {
    const failure = enter(stubHost({}, { limits: { calls } }), () => {
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
  },
);

test.each([
  ['null', JSON.parse('null')],
  ['not a number', Number.NaN],
  ['a fraction', 0.5],
  ['text', JSON.parse('"30000"')],
  ['negative', -1],
])(
  'with an after-response limit that is %s the request is entered, and admitting it throws a plain error naming the limit',
  (_name, afterResponse) => {
    expect(() =>
      enter(stubHost({}, { limits: { afterResponse } }), () => admitted()),
    ).toThrow('limits.afterResponse must be a whole number of zero or more');
  },
);

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

test('the limits a request holds cannot be changed from inside it', () => {
  enter(stubHost({}, { limits: { calls: 1 } }), () => {
    const { limits } = current();
    expect(() => {
      // @ts-expect-error the limits a request holds are read-only
      limits.calls = 9;
    }).toThrow(TypeError);
    expect(current().limits.calls).toBe(1);
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

test('ending a phase fires its signal', async () => {
  const signal = await enter(stubHost(), async () => {
    const held = current().signal;
    await endPhase();
    return held;
  });

  expect(signal.aborted).toBe(true);
  expect(signal.reason).toHaveProperty('name', 'AbortError');
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
    { model: 'acme/small', input: 7, latencyMs: expect.any(Number) },
    {
      model: 'acme/large',
      code: 'aborted',
      message: 'The work was stopped',
      latencyMs: expect.any(Number),
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

test('no call can be begun in a phase that is over', async () => {
  const thrown = await enter(stubHost(), async () => {
    await endPhase();
    return counted('acme/small', async () => 'Hi').catch(
      (caught: unknown) => caught,
    );
  });

  expect(thrown).toBeInstanceOf(Aborted);
});

test('outside a request there is nothing to detach', () => {
  expect(() => beginAfterResponse().signal).toThrow('outside a request');
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

test('a request detached after it was stopped is no longer stopped', () => {
  enter(stubHost({}, { signal: AbortSignal.abort() }), () => {
    expect(beginAfterResponse().signal.aborted).toBe(false);
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

test('detaching leaves the calls, the limits and the host as they were', async () => {
  const host = stubHost({}, { limits: { calls: 3 } });
  await enter(host, async () => {
    await counted(
      'acme/small',
      async () => ({ input: 2, output: 1 }),
      (usage) => usage,
    );
    const before = current();
    beginAfterResponse();

    expect(current().host).toBe(host);
    expect(current().limits).toEqual({ calls: 3 });
    expect(current().calls).toBe(before.calls);
    expect(current().calls.total).toEqual({ input: 2, output: 1 });
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
    latencyMs: expect.any(Number),
    code: 'aborted',
  });
  expect(outcome.before.total).toEqual({ input: 1, output: 1 });
  expect(outcome.made[0]).toBe(outcome.before.made[0]);
  expect(outcome.made[1]).toEqual({
    model: 'acme/slow',
    input: 40,
    cost: 0.5,
    latencyMs: expect.any(Number),
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
    { model: 'acme/small', latencyMs: expect.any(Number) },
  ]);
  expect(calls.total).toEqual({});
});

test('usage added to a closed call does not reopen it: ending the phase waits for nothing', async () => {
  const total = await enter(stubHost(), async () => {
    const open = openCall('acme/small');
    open.close({ code: 'aborted' });
    open.addUsage({ input: 40 });
    await endPhase();
    return current().calls.total;
  });

  expect(total).toEqual({ input: 40 });
}, 1_000);
