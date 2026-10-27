import { expect, spyOn, test } from 'bun:test';
import {
  Aborted,
  Blocked,
  MottyError,
  TimedOut,
  UpstreamFailed,
} from '../../src/data/errors.ts';
import {
  clock,
  onAbort,
  ownSignal,
  reader,
  readToEnd,
  reasonOf,
  stepUnder,
  wait,
} from '../../src/request/wait.ts';

test('what is no promise is given back as it is, with no wait', () => {
  const signal = AbortSignal.abort();
  const plain = { chunks: () => [] };

  expect(wait(plain, signal)).toBe(plain);
  expect(wait(undefined, signal)).toBeUndefined();
  expect(wait('standard', signal)).toBe('standard');
});

test('a wait begun once the signal has fired still gives the code its turn, then ends with the stop', async () => {
  const phase = ownSignal();
  phase.stop();

  expect(await wait(Promise.resolve('recovered'), phase.signal)).toBe(
    'recovered',
  );
  await expect(
    wait(new Promise(() => {}), phase.signal),
  ).rejects.toBeInstanceOf(Aborted);
});

test('code that follows the signal itself ends the way it says, not with the plain stop', async () => {
  const phase = ownSignal();
  const own = new Aborted('The request was stopped', {
    cause: new UpstreamFailed('The first model was down'),
  });
  const itself = new Promise((_resolve, reject) => {
    phase.signal.addEventListener('abort', async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      reject(own);
    });
  });
  const waiting = wait(itself, phase.signal);
  phase.stop();

  await expect(waiting).rejects.toBe(own);
});

test('an SDK error given as the reason of the stop is the error raised, and any other reason is Aborted', async () => {
  const limit = ownSignal();
  const left = ownSignal();
  const reason = new TimedOut('The host gave the request two minutes');
  const waits = [
    wait(new Promise(() => {}), limit.signal),
    wait(new Promise(() => {}), left.signal),
  ];
  limit.stop(reason);
  left.stop('the caller hung up');

  expect(await Promise.allSettled(waits)).toEqual([
    { status: 'rejected', reason },
    { status: 'rejected', reason: expect.any(Aborted) },
  ]);
});

test('stopping a signal of the core makes no error, and a stop with no reason is an AbortError', () => {
  let made = 0;
  const plain = globalThis.Error;
  const counting = new Proxy(plain, {
    construct(target, given, madeAs) {
      made += 1;
      return Reflect.construct(target, given, madeAs);
    },
  });
  globalThis.Error = counting;
  Object.setPrototypeOf(MottyError, counting);
  const phase = ownSignal();
  phase.stop();
  globalThis.Error = plain;
  Object.setPrototypeOf(MottyError, plain);

  expect(phase.signal.aborted).toBe(true);
  expect(phase.signal.reason).toHaveProperty('name', 'AbortError');
  expect(made).toBe(0);
  expect(ownSignal().signal.aborted).toBe(false);
});

test('waits under a signal of the core put no listener on it, however many', async () => {
  const phase = ownSignal();
  const added = spyOn(phase.signal, 'addEventListener');

  await Promise.all(
    Array.from({ length: 1000 }, (_, at) =>
      wait(Promise.resolve(at), phase.signal),
    ),
  );
  const silent = wait(new Promise(() => {}), phase.signal);
  phase.stop();

  await expect(silent).rejects.toBeInstanceOf(Aborted);
  expect(added).toHaveBeenCalledTimes(0);
});

test('a signal the core did not make is heard by one listener however many wait, dropped when nobody waits', async () => {
  const foreign = new AbortController();
  const added = spyOn(foreign.signal, 'addEventListener');
  const removed = spyOn(foreign.signal, 'removeEventListener');
  const gates = [0, 1, 2].map(() => Promise.withResolvers<string>());

  const waits = gates.map((gate) => wait(gate.promise, foreign.signal));
  const during = [added.mock.calls.length, removed.mock.calls.length];
  for (const gate of gates) gate.resolve('done');
  await Promise.all(waits);
  const silent = wait(new Promise(() => {}), foreign.signal);
  foreign.abort();

  await expect(silent).rejects.toBeInstanceOf(Aborted);
  expect(during).toEqual([1, 0]);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
  expect(removed.mock.calls.length).toBeGreaterThan(0);
  expect(added).toHaveBeenCalledTimes(2);
});

test('a wait that is over leaves no timer behind once the signal fires', async () => {
  const phase = ownSignal();
  await wait(Promise.resolve('done'), phase.signal);
  const timers = spyOn(globalThis, 'setTimeout');
  phase.stop();
  const set = timers.mock.calls.length;
  timers.mockRestore();

  expect(set).toBe(0);
});

test('a signal follows another by one listener, which is dropped when it fires or when its owner lets go', () => {
  const host = new AbortController();
  const added = spyOn(host.signal, 'addEventListener');
  const removed = spyOn(host.signal, 'removeEventListener');
  const reason = new TimedOut('The host gave the request two minutes');

  const kept = ownSignal(host.signal);
  const freed = ownSignal(host.signal);
  freed.unfollow();
  const during = [added.mock.calls.length, removed.mock.calls.length];
  host.abort(reason);
  kept.unfollow();

  expect([kept.signal.aborted, freed.signal.aborted]).toEqual([true, false]);
  expect(kept.signal.reason).toBe(reason);
  expect(during).toEqual([1, 0]);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
});

test('whoever asked to be told after the turn is told once, a turn after the signal fires, unless it let go first', async () => {
  const phase = ownSignal();
  const told: string[] = [];
  const unwatch = onAbort(
    phase.signal,
    () => told.push('finished'),
    'afterTurn',
  );
  onAbort(phase.signal, () => told.push('open'), 'afterTurn');
  unwatch();
  phase.stop();
  const atOnce = [...told];
  await Bun.sleep(1);

  expect(atOnce).toEqual([]);
  expect(told).toEqual(['open']);
});

test('whoever asked to be told at once is told as the signal fires, ahead of any who wait for the turn, unless it let go first', () => {
  const phase = ownSignal();
  const told: string[] = [];
  const unfollow = onAbort(phase.signal, () => told.push('gone'), 'atOnce');
  onAbort(phase.signal, () => told.push('later'), 'afterTurn');
  onAbort(phase.signal, () => told.push('now'), 'atOnce');
  unfollow();
  phase.stop();

  expect(told).toEqual(['now']);
});

test('on a signal that has already fired, at once is at the asking and after the turn is still a turn later', async () => {
  const told: string[] = [];
  const signal = AbortSignal.abort();
  const added = spyOn(signal, 'addEventListener');

  onAbort(signal, () => told.push('now'), 'atOnce');
  onAbort(signal, () => told.push('later'), 'afterTurn');
  const atOnce = [...told];
  await Bun.sleep(1);

  expect(atOnce).toEqual(['now']);
  expect(told).toEqual(['now', 'later']);
  expect(added).toHaveBeenCalledTimes(0);
});

test('a stop with no reason has none to give, and a stop with a reason gives it', () => {
  const ended = ownSignal();
  const limited = ownSignal();
  const reason = new TimedOut('The host gave the request two minutes');
  ended.stop();
  limited.stop(reason);

  expect(reasonOf(ended.signal)).toBeUndefined();
  expect(reasonOf(limited.signal)).toBe(reason);
  expect(reasonOf(ownSignal().signal)).toBeUndefined();
});

test('a step is not run once the signal has fired, and its result is waited on under the signal otherwise', async () => {
  const phase = ownSignal();
  const ran: string[] = [];
  const plain = stepUnder(
    phase.signal,
    (name: string) => ran.push(name),
    'derive',
  );
  const silent = stepUnder(
    phase.signal,
    (name: string) => {
      ran.push(name);
      return new Promise<never>(() => {});
    },
    'handle',
  );
  phase.stop();

  expect(plain).toBe(1);
  await expect(silent).rejects.toBeInstanceOf(Aborted);
  expect(() =>
    stepUnder(phase.signal, (name: string) => ran.push(name), 'afterHandle'),
  ).toThrow(Aborted);
  expect(ran).toEqual(['derive', 'handle']);
});

test('a timer is held at the longest delay a timer takes, and none is set with no delay', () => {
  const timers = spyOn(globalThis, 'setTimeout');
  const none = clock(() => {});
  const long = clock(() => {}, 2 ** 40);
  clearTimeout(long);
  const delays = timers.mock.calls.map(([, ms]) => ms);
  timers.mockRestore();

  expect(none).toBeUndefined();
  expect(delays).toEqual([2 ** 31 - 1]);
});

test('a stream is read through one watch: whoever reads it is told a turn after the signal fires, and no read begins after it', async () => {
  const phase = ownSignal();
  let asked = 0;
  let closed = 0;
  let gaveUp = 0;
  const source = reader(
    {
      next: () => {
        asked += 1;
        return asked === 1
          ? Promise.resolve({ done: false, value: 'Half' })
          : new Promise(() => {});
      },
      return: () => {
        closed += 1;
        return new Promise(() => {});
      },
    },
    phase.signal,
    () => {
      gaveUp += 1;
    },
  );
  const read = () =>
    new Promise<IteratorResult<unknown>>((took, threw) =>
      source.read(took, threw),
    );

  const first = await read();
  read();
  phase.stop();
  const atOnce = gaveUp;
  await Bun.sleep(1);
  const afterTurn = gaveUp;
  read();
  source.end(false);

  expect(first).toEqual({ done: false, value: 'Half' });
  expect([atOnce, afterTurn, gaveUp]).toEqual([0, 1, 2]);
  expect([asked, closed]).toEqual([2, 1]);
});

test('a stream whose read throws when asked fails that read with what it threw', async () => {
  const failure = new RangeError('The socket closed');
  const source = reader(
    {
      next: () => {
        throw failure;
      },
    },
    ownSignal().signal,
    () => {},
  );

  expect(
    await new Promise((took, threw) => source.read(took, threw)).catch(
      (thrown: unknown) => thrown,
    ),
  ).toBe(failure);
});

test('a stream given up while it is readToEnd resolves as not read out, makes no error and is closed', async () => {
  const phase = ownSignal();
  let closed = 0;
  let made = 0;
  const plain = globalThis.Error;
  const counting = new Proxy(plain, {
    construct(target, given, madeAs) {
      made += 1;
      return Reflect.construct(target, given, madeAs);
    },
  });
  globalThis.Error = counting;
  Object.setPrototypeOf(MottyError, counting);

  const draining = readToEnd(
    {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise(() => {}),
        return: async () => {
          closed += 1;
          return { done: true, value: undefined };
        },
      }),
    },
    phase.signal,
    () => {},
  );
  phase.stop();
  const readOut = await draining.finally(() => {
    globalThis.Error = plain;
    Object.setPrototypeOf(MottyError, plain);
  });

  expect(readOut).toBe(false);
  expect(made).toBe(0);
  expect(closed).toBe(1);
});

test('a stream readToEnd to its end hands on every item and is not closed', async () => {
  let closed = 0;
  const items = ['One', 'Two'];
  const taken: unknown[] = [];

  const readOut = await readToEnd(
    {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          const value = items.shift();
          return value === undefined
            ? { done: true, value: undefined }
            : { done: false, value };
        },
        return: async () => {
          closed += 1;
          return { done: true, value: undefined };
        },
      }),
    },
    ownSignal().signal,
    (item) => taken.push(item),
  );

  expect(readOut).toBe(true);
  expect(taken).toEqual(['One', 'Two']);
  expect(closed).toBe(0);
});

test('a stream whose item is refused where it is taken fails with that and is closed', async () => {
  let closed = 0;
  const refusal = new Blocked('Not a chunk');

  const thrown = await readToEnd(
    {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: 'Bad' }),
        return: async () => {
          closed += 1;
          return { done: true, value: undefined };
        },
      }),
    },
    undefined,
    () => {
      throw refusal;
    },
  ).catch((caught: unknown) => caught);

  expect(thrown).toBe(refusal);
  expect(closed).toBe(1);
});
