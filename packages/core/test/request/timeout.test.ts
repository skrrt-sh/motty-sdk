import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import {
  Aborted,
  Overloaded,
  TimedOut,
  UnknownModel,
} from '../../src/data/errors.ts';
import type { StreamEvent } from '../../src/data/event.ts';
import { current, enter } from '../../src/request/context.ts';
import {
  callable,
  callOf,
  type Model,
  model,
} from '../../src/request/model.ts';
import { retry } from '../../src/request/retry.ts';
import { fallback } from '../../src/request/switching.ts';
import { timeout } from '../../src/request/timeout.ts';
import { stubHost } from '../stub-host.ts';

afterEach(() => {
  jest.useRealTimers();
});

// Fake timers leave setImmediate real, so this lets every promise already
// due run without moving the clock.
function settled(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

// Under fake timers a promise that never settles would stall its test, so
// one that is due fails the test here when it is still pending.
async function due<Value>(pending: Promise<Value>): Promise<Value> {
  const first = await Promise.race([
    pending.then((value) => ({ value })),
    settled().then(() => undefined),
  ]);
  if (first === undefined) throw new Error('Still pending when it was due');
  return first.value;
}

function paused(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Reaches the host at once, then holds its first chunk back until the wait
// ends or the call is cancelled.
function held(inner: Model, ms: number, signals: AbortSignal[] = []): Model {
  return callable(async (prompt, signal) => {
    signals.push(signal);
    const events = await callOf(inner)(prompt, signal);
    await paused(ms, signal);
    return events;
  });
}

// Never gets a first chunk: it fails with Aborted once its signal fires.
function hung(signals: AbortSignal[] = []): Model {
  return callable((_prompt, signal) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      const stopped = () => reject(new Aborted('The call was stopped'));
      if (signal.aborted) stopped();
      else signal.addEventListener('abort', stopped);
    });
  });
}

// Resolves at once, then leaves a gap before each later event.
function spaced(inner: Model, gapMs: number, signals: AbortSignal[] = []) {
  return callable(async (prompt, signal) => {
    signals.push(signal);
    const events = await callOf(inner)(prompt, signal);
    return (async function* () {
      for await (const event of events) {
        yield event;
        if (event.type !== 'finish' && event.type !== 'error') {
          await paused(gapMs, signal);
        }
      }
    })();
  });
}

// A regression that hangs settles as 'hung' here instead of stalling the run.
async function orHung<Value>(pending: Promise<Value>): Promise<Value | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(resolve, 100, 'hung');
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Never settles and ignores its signal.
function deaf(signals: AbortSignal[] = []): Model {
  return callable((_prompt, signal) => {
    signals.push(signal);
    return new Promise(() => {});
  });
}

// A hand-written stream that ignores its signal: the events, then a pull that
// never settles. It logs each iterator taken from it and each close.
function scripted(
  events: StreamEvent[],
  log: string[] = [],
  closed = async () => ({ done: true as const, value: undefined }),
): Model {
  return callable(async () => ({
    [Symbol.asyncIterator]: () => {
      log.push('iterator');
      const left = events.values();
      return {
        next: async () => {
          const next = left.next();
          return next.done ? new Promise<never>(() => {}) : next;
        },
        return: () => {
          log.push('return');
          return closed();
        },
      };
    },
  }));
}

test('a negative or non-finite count of retries or milliseconds is a mistake at load', () => {
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => retry(model('acme/small'), amount)).toThrow(Error);
    expect(() => timeout(model('acme/small'), amount)).toThrow(Error);
    expect(() => timeout(model('acme/small'), { firstMs: amount })).toThrow(
      Error,
    );
    expect(() => timeout(model('acme/small'), { stallMs: amount })).toThrow(
      Error,
    );
  }
});

test('timeout passes a fast model through and leaves its stream alone', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await timeout(model('acme/small'), 5).complete({
      messages: [],
    });
    await Bun.sleep(10);
    return reply.text();
  });

  expect(text).toBe('Hello');
});

test('timeout fails a hung model with TimedOut and cancels it', async () => {
  const host = stubHost({
    'acme/hung': [
      { type: 'text', text: 'Late' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 4, output: 4, cached: 0, reasoning: 0 },
      },
    ],
  });
  const signals: AbortSignal[] = [];

  const calls = await enter(host, async () => {
    await expect(
      timeout(held(model('acme/hung'), 1000, signals), 5).complete({
        messages: [],
      }),
    ).rejects.toBeInstanceOf(TimedOut);
    await Bun.sleep(1);
    return current().calls;
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  expect(calls.made.map((made) => made.model)).toEqual(['acme/hung']);
});

test('timeout with no limit returns the model untouched', () => {
  const inner = model('acme/small');

  expect(timeout(inner, {})).toBe(inner);
});

test('timeout rejects with TimedOut exactly when the first chunk is late, and gives the call up', async () => {
  jest.useFakeTimers();
  const signals: AbortSignal[] = [];

  await enter(stubHost(), async () => {
    const pending = callOf(timeout(hung(signals), { firstMs: 5 }))(
      { messages: [] },
      current().signal,
    );
    const failed = pending.catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(4);
    await settled();
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
    jest.advanceTimersByTime(1);
    expect(await due(failed)).toBeInstanceOf(TimedOut);
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout stays timed out when the request is stopped afterwards', async () => {
  jest.useFakeTimers();
  const request = new AbortController();

  await enter(stubHost({}, { signal: request.signal }), async () => {
    const failed = timeout(hung(), 5)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(5);
    expect(await due(failed)).toBeInstanceOf(TimedOut);
    request.abort();
    await settled();
  });

  expect(jest.getTimerCount()).toBe(0);
});

test('timeout rejects with the call’s own failure before the first chunk and leaves no timer', async () => {
  jest.useFakeTimers();

  await enter(stubHost(), async () =>
    expect(
      await due(
        timeout(model('acme/missing'), { firstMs: 1000, stallMs: 1000 })
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown),
      ),
    ).toBeInstanceOf(UnknownModel),
  );

  expect(jest.getTimerCount()).toBe(0);
});

test('timeout rejects with Aborted when the request is stopped before the first chunk', async () => {
  jest.useFakeTimers();
  const request = new AbortController();

  await enter(stubHost({}, { signal: request.signal }), async () => {
    const failed = timeout(hung(), { firstMs: 1000, stallMs: 1000 })
      .complete({
        messages: [],
      })
      .catch((thrown: unknown) => thrown);
    await settled();
    request.abort();
    expect(await due(failed)).toBeInstanceOf(Aborted);
  });

  expect(jest.getTimerCount()).toBe(0);
});

test('timeout with only a first-chunk limit lets later events take their time', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/slow': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await due(
      timeout(spaced(model('acme/slow'), 1000), {
        firstMs: 5,
      }).complete({ messages: [] }),
    );
    await settled();
    jest.advanceTimersByTime(1000);
    await settled();
    jest.advanceTimersByTime(1000);
    return due(reply.text());
  });

  expect(text).toBe('Hello');
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout with only a stall limit lets the first chunk take its time', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const text = await enter(host, async () => {
    const pending = timeout(held(model('acme/small'), 1000), {
      stallMs: 5,
    }).complete({ messages: [] });
    await settled();
    jest.advanceTimersByTime(1000);
    const reply = await due(pending);
    return due(reply.text());
  });

  expect(text).toBe('Hello');
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout restarts its stall clock at each event and stops it at the terminal one', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/steady': [
      { type: 'text', text: 'One' },
      { type: 'text', text: 'Two' },
      { type: 'text', text: 'Three' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 3 } },
    ],
  });

  const events = await enter(host, async () => {
    const stream = await due(
      callOf(
        timeout(spaced(model('acme/steady'), 30), { firstMs: 50, stallMs: 50 }),
      )({ messages: [] }, current().signal),
    );
    const reading = Array.fromAsync(stream);
    for (const _ of [1, 2, 3]) {
      await settled();
      jest.advanceTimersByTime(30);
    }
    return due(reading);
  });

  expect(events).toEqual([
    { type: 'text', text: 'One' },
    { type: 'text', text: 'Two' },
    { type: 'text', text: 'Three' },
    { type: 'finish', reason: 'stop', usage: { input: 1, output: 3 } },
  ]);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout ends a stalled stream with a TimedOut error after the events it had, and gives the call up', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const host = stubHost(
    {
      'acme/stalling': [
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
      ],
    },
    { signal: request.signal },
  );
  const signals: AbortSignal[] = [];

  const [events, after, calls, stopped] = await enter(host, async () => {
    const stream = await due(
      callOf(
        timeout(spaced(model('acme/stalling'), 1000, signals), { stallMs: 50 }),
      )({ messages: [] }, current().signal),
    );
    const reader = stream[Symbol.asyncIterator]();
    const first = await due(reader.next());
    const second = reader.next();
    await settled();
    jest.advanceTimersByTime(49);
    await settled();
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
    jest.advanceTimersByTime(1);
    const events = [first.value, (await due(second)).value];
    await settled();
    const calls = current().calls.made.map((made) => made.model);
    const stopped = signals.map((signal) => signal.aborted);
    request.abort();
    await settled();
    return [events, await due(reader.next()), calls, stopped];
  });

  expect(events).toEqual([
    { type: 'text', text: 'Hel' },
    {
      type: 'error',
      error: {
        code: 'timed_out',
        status: 504,
        message: expect.stringContaining('50 ms'),
        retryable: true,
      },
    },
  ]);
  expect(after.done).toBe(true);
  expect(stopped).toEqual([true]);
  expect(calls).toEqual(['acme/stalling']);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout makes a stalled answer fail with TimedOut where it is read', async () => {
  const host = stubHost({
    'acme/stalling': [
      { type: 'text', text: 'Hel' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  await enter(host, async () => {
    const reply = await timeout(spaced(model('acme/stalling'), 1000), {
      firstMs: 5,
      stallMs: 5,
    }).complete({ messages: [] });
    await expect(reply.text()).rejects.toBeInstanceOf(TimedOut);
  });
});

test('an answer a time limit ended by itself names no model', async () => {
  const host = stubHost({
    'acme/stalling': [
      { type: 'text', text: 'Hel' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  await enter(host, async () => {
    const reply = await timeout(spaced(model('acme/stalling'), 1000), {
      stallMs: 5,
    }).complete({ messages: [] });
    await expect(reply.finish()).rejects.toBeInstanceOf(TimedOut);
    expect(await reply.model()).toBeUndefined();
  });
});

test('timeout does not count a slow reader as a stall', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });

  const types = await enter(host, async () => {
    const stream = await callOf(timeout(model('acme/small'), { stallMs: 3 }))(
      { messages: [] },
      current().signal,
    );
    const types: string[] = [];
    for await (const event of stream) {
      types.push(event.type);
      await Bun.sleep(9);
    }
    return types;
  });

  expect(types).toEqual(['text', 'text', 'finish']);
});

test('timeout gives the call up and clears its clock when the reader stops early', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/slow': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });
  const signals: AbortSignal[] = [];

  const calls = await enter(host, async () => {
    const stream = await due(
      callOf(
        timeout(spaced(model('acme/slow'), 1000, signals), { stallMs: 5000 }),
      )({ messages: [] }, current().signal),
    );
    for await (const _ of stream) break;
    await settled();
    return current().calls;
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  expect(calls.made.map((made) => made.model)).toEqual(['acme/slow']);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout gives the call up when its stream is returned before it was read', async () => {
  const host = stubHost({
    'acme/slow': [
      { type: 'text', text: 'Hel' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const signals: AbortSignal[] = [];

  await enter(host, async () => {
    const stream = await callOf(
      timeout(spaced(model('acme/slow'), 1000, signals), { stallMs: 5000 }),
    )({ messages: [] }, current().signal);
    await stream[Symbol.asyncIterator]().return?.();
    await Bun.sleep(1);
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('timeout passes on the upstream’s own ending when the request is stopped mid-stream', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const host = stubHost(
    {
      'acme/slow': [
        { type: 'text', text: 'Hel' },
        { type: 'text', text: 'lo' },
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
      ],
    },
    { signal: request.signal },
  );

  const events = await enter(host, async () => {
    const stream = await due(
      callOf(timeout(spaced(model('acme/slow'), 1000), { stallMs: 5000 }))(
        { messages: [] },
        current().signal,
      ),
    );
    const reading = Array.fromAsync(stream);
    await settled();
    request.abort();
    return due(reading);
  });

  expect(events).toEqual([
    { type: 'text', text: 'Hel' },
    { type: 'error', error: expect.objectContaining({ code: 'aborted' }) },
  ]);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout ends where an upstream stream ends without a terminal event', async () => {
  jest.useFakeTimers();

  const events = await enter(stubHost(), async () => {
    const stream = await due(
      callOf(
        timeout(
          callable(async () =>
            (async function* () {
              yield { type: 'text' as const, text: 'Cut' };
            })(),
          ),
          { firstMs: 50, stallMs: 50 },
        ),
      )({ messages: [] }, current().signal),
    );
    return due(Array.fromAsync(stream));
  });

  expect(events).toEqual([{ type: 'text', text: 'Cut' }]);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout closes the upstream at its terminal event, though the reader never reads past it', async () => {
  jest.useFakeTimers();
  const closed: string[] = [];

  const last = await enter(stubHost(), async () => {
    const stream = await due(
      callOf(
        timeout(
          callable(async () =>
            (async function* () {
              try {
                yield { type: 'text' as const, text: 'Hel' };
                yield {
                  type: 'error' as const,
                  error: { code: 'overloaded', status: 503, message: 'Busy' },
                };
              } finally {
                closed.push('upstream');
              }
            })(),
          ),
          { stallMs: 50 },
        ),
      )({ messages: [] }, current().signal),
    );
    const reader = stream[Symbol.asyncIterator]();
    await due(reader.next());
    const last = await due(reader.next());
    await settled();
    return last;
  });

  expect(last.value).toEqual({
    type: 'error',
    error: { code: 'overloaded', status: 503, message: 'Busy' },
  });
  expect(closed).toEqual(['upstream']);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout holds a limit above the longest timer delay instead of timing out at once', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });

  const [first, both] = await enter(host, async () => {
    const first = await timeout(
      held(model('acme/small'), 10),
      2 ** 31,
    ).complete({ messages: [] });
    const both = await timeout(spaced(held(model('acme/small'), 10), 10), {
      firstMs: 2 ** 40,
      stallMs: 2 ** 40,
    }).complete({ messages: [] });
    return [await first.text(), await both.text()];
  });

  expect([first, both]).toEqual(['Hello', 'Hello']);
});

test('timeout holds a limit above the longest timer delay at that delay', async () => {
  jest.useFakeTimers();
  const signals: AbortSignal[] = [];

  await enter(stubHost(), async () => {
    const failed = timeout(hung(signals), 2 ** 40)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(2 ** 31 - 2);
    await settled();
    expect(signals.map((signal) => signal.aborted)).toEqual([false]);
    jest.advanceTimersByTime(1);
    expect(await due(failed)).toBeInstanceOf(TimedOut);
  });

  expect(jest.getTimerCount()).toBe(0);
});

test('timeout given a number limits the first chunk only, never the gaps after it', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/slow': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await due(
      timeout(spaced(model('acme/slow'), 1000), 5).complete({
        messages: [],
      }),
    );
    await settled();
    jest.advanceTimersByTime(1000);
    await settled();
    jest.advanceTimersByTime(1000);
    return due(reply.text());
  });

  expect(text).toBe('Hello');
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout ends at the upstream’s finish and closes it without reading on or aborting it', async () => {
  const log: string[] = [];
  const signals: AbortSignal[] = [];

  const [events, after] = await enter(stubHost(), async () => {
    const stream = await callOf(
      timeout(
        held(
          scripted(
            [
              { type: 'text', text: 'Hel' },
              { type: 'finish', reason: 'stop' },
              { type: 'text', text: 'More' },
            ],
            log,
          ),
          0,
          signals,
        ),
        { firstMs: 1000, stallMs: 1000 },
      ),
    )({ messages: [] }, current().signal);
    const reader = stream[Symbol.asyncIterator]();
    const events = [(await reader.next()).value, (await reader.next()).value];
    return [events, await orHung(reader.next())];
  });

  expect(events).toEqual([
    { type: 'text', text: 'Hel' },
    { type: 'finish', reason: 'stop' },
  ]);
  expect(after).toEqual({ done: true, value: undefined });
  expect(log).toEqual(['iterator', 'return']);
  expect(signals.map((signal) => signal.aborted)).toEqual([false]);
});

test('timeout does not abort the upstream after a normal finish, read to its end or left at the finish', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const signals: AbortSignal[] = [];

  const calls = await enter(host, async () => {
    const whole = await callOf(
      timeout(held(model('acme/small'), 0, signals), { stallMs: 1000 }),
    )({ messages: [] }, current().signal);
    await Array.fromAsync(whole);
    const left = await callOf(
      timeout(held(model('acme/small'), 0, signals), { stallMs: 1000 }),
    )({ messages: [] }, current().signal);
    for await (const event of left) {
      if (event.type === 'finish') break;
    }
    await Bun.sleep(1);
    return current().calls;
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
  expect(calls.made.map((made) => made.model)).toEqual([
    'acme/small',
    'acme/small',
  ]);
});

test('timeout ends a stalled stream that never ends without waiting for it, and closes the one iterator it took', async () => {
  const log: string[] = [];

  const events = await enter(stubHost(), async () => {
    const stream = await callOf(
      timeout(
        scripted(
          [{ type: 'text', text: 'Hel' }],
          log,
          () => new Promise(() => {}),
        ),
        { stallMs: 5 },
      ),
    )({ messages: [] }, current().signal);
    const events = await orHung(Array.fromAsync(stream));
    await Bun.sleep(1);
    return events;
  });

  expect(events).toEqual([
    { type: 'text', text: 'Hel' },
    { type: 'error', error: expect.objectContaining({ code: 'timed_out' }) },
  ]);
  expect(log).toEqual(['iterator', 'return']);
});

test('timeout gives up a stream that never ends when its reader stops early, through the one iterator it took', async () => {
  const log: string[] = [];
  const signals: AbortSignal[] = [];

  await enter(stubHost(), async () => {
    const stream = await callOf(
      timeout(
        held(scripted([{ type: 'text', text: 'Hel' }], log), 0, signals),
        {
          firstMs: 1000,
        },
      ),
    )({ messages: [] }, current().signal);
    for await (const _ of stream) break;
    await Bun.sleep(1);
  });

  expect(log).toEqual(['iterator', 'return']);
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('timeout gives up a call whose first chunk comes after the limit, by the one iterator of the stream it then gets', async () => {
  const log: string[] = [];

  const failed = await enter(stubHost(), async () => {
    const failed = await timeout(
      callable(async (prompt, signal) => {
        await Bun.sleep(8);
        return callOf(scripted([{ type: 'text', text: 'Late' }], log))(
          prompt,
          signal,
        );
      }),
      2,
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await Bun.sleep(12);
    return failed;
  });

  expect(failed).toBeInstanceOf(TimedOut);
  expect(log).toEqual(['iterator', 'return']);
});

test('timeout enters a generator-backed stream once and closes it when the reader stops early', async () => {
  const log: string[] = [];

  await enter(stubHost(), async () => {
    const stream = await callOf(
      timeout(
        callable(async () => ({
          async *[Symbol.asyncIterator]() {
            log.push('entered');
            try {
              yield { type: 'text' as const, text: 'Hel' };
              yield { type: 'text' as const, text: 'lo' };
            } finally {
              log.push('closed');
            }
          },
        })),
        { stallMs: 1000 },
      ),
    )({ messages: [] }, current().signal);
    for await (const _ of stream) break;
    await Bun.sleep(1);
  });

  expect(log).toEqual(['entered', 'closed']);
});

test('timeout gives up a web stream through the reader it holds, never asking the locked stream for another', async () => {
  const log: string[] = [];

  await enter(stubHost(), async () => {
    const stream = await callOf(
      timeout(
        callable(
          async () =>
            new ReadableStream<StreamEvent>({
              start: (controller) => {
                controller.enqueue({ type: 'text', text: 'Hel' });
              },
              cancel: () => {
                log.push('cancelled');
              },
            }),
        ),
        { stallMs: 1000 },
      ),
    )({ messages: [] }, current().signal);
    for await (const _ of stream) break;
    await Bun.sleep(2);
  });

  expect(log).toEqual(['cancelled']);
});

test('timeout swallows an upstream close that throws or rejects, at the terminal event and at a give-up', async () => {
  const log: string[] = [];

  const events = await enter(stubHost(), async () => {
    const events: StreamEvent[] = [];
    for (const closed of [
      () => {
        throw new Error('No close');
      },
      () => Promise.reject(new Error('No close')),
    ]) {
      const ended = await callOf(
        timeout(
          scripted(
            [
              { type: 'text', text: 'Hel' },
              { type: 'finish', reason: 'stop' },
            ],
            log,
            closed,
          ),
          { stallMs: 1000 },
        ),
      )({ messages: [] }, current().signal);
      for await (const event of ended) events.push(event);
      const left = await callOf(
        timeout(scripted([{ type: 'text', text: 'Hel' }], log, closed), {
          stallMs: 1000,
        }),
      )({ messages: [] }, current().signal);
      for await (const _ of left) break;
    }
    await Bun.sleep(2);
    return events;
  });

  expect(events.map((event) => event.type)).toEqual([
    'text',
    'finish',
    'text',
    'finish',
  ]);
  expect(log.filter((entry) => entry === 'return')).toHaveLength(4);
});

test('timeout’s stream reports done after it was returned, whether unread, midway or ended', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });

  const after = await enter(host, async () => {
    const after: IteratorResult<StreamEvent>[] = [];
    for (const reads of [0, 1, 3, 4]) {
      const stream = await callOf(
        timeout(model('acme/small'), { firstMs: 1000, stallMs: 1000 }),
      )({ messages: [] }, current().signal);
      const reader = stream[Symbol.asyncIterator]();
      for (let read = 0; read < reads; read += 1) await reader.next();
      await reader.return?.();
      after.push(await reader.next(), await reader.next());
    }
    return after;
  });

  expect(after).toEqual(Array(8).fill({ done: true, value: undefined }));
  expect(host.sent('acme/small')).toHaveLength(4);
});

test('a pull in flight when timeout’s stream is returned reports done, not the event that then arrives', async () => {
  const host = stubHost({
    'acme/slow': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });

  const [pulled, calls] = await enter(host, async () => {
    const stream = await callOf(
      timeout(spaced(model('acme/slow'), 1000), { stallMs: 5000 }),
    )({ messages: [] }, current().signal);
    const reader = stream[Symbol.asyncIterator]();
    await reader.next();
    const pulling = reader.next();
    await Bun.sleep(1);
    await reader.return?.();
    return [await orHung(pulling), current().calls];
  });

  expect(pulled).toEqual({ done: true, value: undefined });
  expect(calls.made.map((made) => made.model)).toEqual(['acme/slow']);
});

test('timeout around a fallback limits the whole of it: a slow first model times it out before the next is asked', async () => {
  const host = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const signals: AbortSignal[] = [];

  const failed = await enter(host, async () => {
    const failed = await timeout(fallback(hung(signals), model('acme/fast')), 5)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await Bun.sleep(2);
    return failed;
  });

  expect(failed).toBeInstanceOf(TimedOut);
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  expect(host.sent('acme/fast')).toEqual([]);
});

test('timeout around a retry limits the whole of it and can end it during a backoff', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/busy': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
  });

  await enter(host, async () => {
    const failed = timeout(retry(model('acme/busy'), 5), 700)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(500);
    await settled();
    expect(current().calls.made).toHaveLength(2);
    jest.advanceTimersByTime(200);
    expect(await due(failed)).toBeInstanceOf(TimedOut);
    await settled();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(5000);
    await settled();
    expect(current().calls.made).toHaveLength(2);
  });
});

test('timeout ends a read in flight and clears its stall clock when the reader returns a stream that ignores its signal', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const added = spyOn(request.signal, 'addEventListener');
  const removed = spyOn(request.signal, 'removeEventListener');
  const log: string[] = [];

  const pulled = await enter(stubHost(), async () => {
    const stream = await due(
      callOf(
        timeout(scripted([{ type: 'text', text: 'Hel' }], log), {
          stallMs: 5000,
        }),
      )({ messages: [] }, request.signal),
    );
    const reader = stream[Symbol.asyncIterator]();
    await due(reader.next());
    const pulling = reader.next();
    await settled();
    expect(jest.getTimerCount()).toBe(1);
    await reader.return?.();
    return [await due(pulling), await due(reader.next())];
  });

  expect(pulled).toEqual([
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  expect(log).toEqual(['iterator', 'return']);
  expect(jest.getTimerCount()).toBe(0);
  expect(added.mock.calls.length).toBeGreaterThan(0);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
});

test('timeout ends a read in flight with Aborted when the request is stopped, though the stream ignores its signal', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const signals: AbortSignal[] = [];
  const log: string[] = [];

  const read = await enter(stubHost(), async () => {
    const stream = await due(
      callOf(
        timeout(
          callable((prompt, signal) => {
            signals.push(signal);
            return callOf(scripted([{ type: 'text', text: 'Hel' }], log))(
              prompt,
              signal,
            );
          }),
          { firstMs: 5000, stallMs: 5000 },
        ),
      )({ messages: [] }, request.signal),
    );
    const reader = stream[Symbol.asyncIterator]();
    const first = await due(reader.next());
    const pulling = reader.next();
    await settled();
    request.abort();
    return [first, await due(pulling), await due(reader.next())];
  });

  expect(read).toEqual([
    { done: false, value: { type: 'text', text: 'Hel' } },
    {
      done: false,
      value: {
        type: 'error',
        error: expect.objectContaining({
          code: 'aborted',
          message: 'The work was stopped',
        }),
      },
    },
    { done: true, value: undefined },
  ]);
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  expect(log).toEqual(['iterator', 'return']);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout owes Aborted to the next read when the request is stopped between reads, and nothing once returned', async () => {
  jest.useFakeTimers();
  const log: string[] = [];

  const read = await enter(stubHost(), async () => {
    const read: IteratorResult<StreamEvent>[] = [];
    for (const leaves of [false, true]) {
      const request = new AbortController();
      const stream = await due(
        callOf(
          timeout(
            scripted(
              [
                { type: 'text', text: 'Hel' },
                { type: 'text', text: 'lo' },
              ],
              log,
            ),
            { stallMs: 5000 },
          ),
        )({ messages: [] }, request.signal),
      );
      const reader = stream[Symbol.asyncIterator]();
      await due(reader.next());
      request.abort();
      await settled();
      if (leaves) await reader.return?.();
      read.push(await due(reader.next()), await due(reader.next()));
    }
    return read;
  });

  expect(read).toEqual([
    {
      done: false,
      value: {
        type: 'error',
        error: expect.objectContaining({ code: 'aborted' }),
      },
    },
    { done: true, value: undefined },
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  expect(log).toEqual(['iterator', 'return', 'iterator', 'return']);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout drops its listener from the signal when its stream finishes or stalls, and when its call fails or is late', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const added = spyOn(request.signal, 'addEventListener');
  const removed = spyOn(request.signal, 'removeEventListener');

  await enter(stubHost(), async () => {
    const finished = await due(
      callOf(
        timeout(
          scripted([
            { type: 'text', text: 'Hel' },
            { type: 'finish', reason: 'stop' },
          ]),
          { stallMs: 50 },
        ),
      )({ messages: [] }, request.signal),
    );
    await due(Array.fromAsync(finished));
    const stalling = await due(
      callOf(
        timeout(scripted([{ type: 'text', text: 'Hel' }]), { stallMs: 50 }),
      )({ messages: [] }, request.signal),
    );
    const stalled = Array.fromAsync(stalling);
    await settled();
    jest.advanceTimersByTime(50);
    await due(stalled);
    await due(
      callOf(timeout(model('acme/missing'), 50))(
        { messages: [] },
        request.signal,
      ).catch(() => {}),
    );
    const late = callOf(timeout(deaf(), 50))(
      { messages: [] },
      request.signal,
    ).catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(50);
    expect(await due(late)).toBeInstanceOf(TimedOut);
  });

  expect(jest.getTimerCount()).toBe(0);
  expect(removed.mock.calls.map(([, listener]) => listener)).toEqual(
    expect.arrayContaining(added.mock.calls.map(([, listener]) => listener)),
  );
});

test('timeout throws Aborted, the call’s failure as its cause, once the signal it was given has fired, and passes the failure on otherwise', async () => {
  const request = new AbortController();
  const failure = new Overloaded('Busy');
  const own = new Aborted('The call was stopped');

  const [passed, failed] = await enter(
    stubHost({}, { signal: request.signal }),
    async () => [
      await timeout(
        callable(async () => {
          throw own;
        }),
        { firstMs: 1000, stallMs: 1000 },
      )
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown),
      await timeout(
        callable(async () => {
          request.abort();
          throw failure;
        }),
        { firstMs: 1000, stallMs: 1000 },
      )
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown),
    ],
  );

  expect(passed).toBe(own);
  expect(failed).toBeInstanceOf(Aborted);
  expect(failed).toHaveProperty('message', 'The work was stopped');
  expect(failed).toHaveProperty('cause', failure);
});

test('timeout ends for good where an upstream is done without a terminal event, and never reads it again', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const added = spyOn(request.signal, 'addEventListener');
  const removed = spyOn(request.signal, 'removeEventListener');
  const log: string[] = [];

  const read = await enter(stubHost(), async () => {
    const stream = await due(
      callOf(
        timeout(
          callable(async () => ({
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                log.push('next');
                return log.length === 1
                  ? { done: false, value: { type: 'text' as const, text: 'A' } }
                  : log.length === 2
                    ? { done: true, value: undefined }
                    : {
                        done: false,
                        value: { type: 'text' as const, text: 'B' },
                      };
              },
              return: async () => {
                log.push('return');
                return { done: true, value: undefined };
              },
            }),
          })),
          { stallMs: 50 },
        ),
      )({ messages: [] }, request.signal),
    );
    const reader = stream[Symbol.asyncIterator]();
    return [
      await due(reader.next()),
      await due(reader.next()),
      await due(reader.next()),
    ];
  });

  expect(read).toEqual([
    { done: false, value: { type: 'text', text: 'A' } },
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  expect(log).toEqual(['next', 'next', 'return']);
  expect(jest.getTimerCount()).toBe(0);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
});

test('timeout hands concurrent reads their events in order, one upstream read at a time', async () => {
  jest.useFakeTimers();
  let reading = 0;
  let most = 0;

  const read = await enter(stubHost(), async () => {
    const stream = await due(
      callOf(
        timeout(
          callable(async () => {
            const events = [
              { type: 'text' as const, text: 'A' },
              { type: 'text' as const, text: 'B' },
              { type: 'finish' as const, reason: 'stop' as const },
            ].values();
            return {
              [Symbol.asyncIterator]: () => ({
                next: async () => {
                  reading += 1;
                  most = Math.max(most, reading);
                  await settled();
                  reading -= 1;
                  return events.next();
                },
              }),
            };
          }),
          { stallMs: 50 },
        ),
      )({ messages: [] }, current().signal),
    );
    const reader = stream[Symbol.asyncIterator]();
    return Promise.all([
      reader.next(),
      reader.next(),
      reader.next(),
      reader.next(),
    ]);
  });

  expect(
    read.map((result) => (result.done ? 'done' : result.value.type)),
  ).toEqual(['text', 'text', 'finish', 'done']);
  expect(most).toBe(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('timeout rejects the read whose upstream read throws, then is done, with no clock or listener left', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const added = spyOn(request.signal, 'addEventListener');
  const removed = spyOn(request.signal, 'removeEventListener');
  const failure = new Error('Broken pipe');

  const read = await enter(stubHost(), async () => {
    const read: unknown[] = [];
    for (const next of [
      () => Promise.reject(failure),
      () => {
        throw failure;
      },
    ]) {
      const stream = await due(
        callOf(
          timeout(
            callable(async () => ({
              [Symbol.asyncIterator]: () => ({ next }),
            })),
            { stallMs: 50 },
          ),
        )({ messages: [] }, request.signal),
      );
      const reader = stream[Symbol.asyncIterator]();
      read.push(
        await due(reader.next().catch((thrown: unknown) => thrown)),
        await due(reader.next()),
      );
    }
    return read;
  });

  expect(read).toEqual([
    failure,
    { done: true, value: undefined },
    failure,
    { done: true, value: undefined },
  ]);
  expect(jest.getTimerCount()).toBe(0);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
});

test('a limit that is not a number or a plain object of numbers is a mistake at load, never a model left unlimited', () => {
  for (const limit of [
    '100',
    true,
    [5],
    1n,
    null,
    undefined,
    new Date(0),
    () => 5,
    { firstMs: '5' },
    { stallMs: null },
  ]) {
    expect(() =>
      Reflect.apply(timeout, undefined, [model('acme/small'), limit]),
    ).toThrow('timeout() needs limits of zero or more milliseconds');
  }
  expect(() => timeout(model('acme/small'), 0)).not.toThrow();
  expect(() =>
    timeout(model('acme/small'), { firstMs: 0, stallMs: 5 }),
  ).not.toThrow();
});

test('accepted: a close issued while a read is in flight waits behind that read, and only the abort reaches the source at once', async () => {
  const log: string[] = [];

  await enter(stubHost(), async () => {
    for (const source of [
      (gate: Promise<void>) =>
        (async function* () {
          try {
            yield { type: 'text' as const, text: 'Hel' };
            await gate;
            yield { type: 'text' as const, text: 'lo' };
          } finally {
            log.push('closed');
          }
        })(),
      (gate: Promise<void>) =>
        new ReadableStream<StreamEvent>({
          start: (controller) => {
            controller.enqueue({ type: 'text', text: 'Hel' });
            gate.then(() => controller.enqueue({ type: 'text', text: 'lo' }));
          },
          cancel: () => {
            log.push('closed');
          },
        }),
    ]) {
      const gate = Promise.withResolvers<void>();
      const stream = await callOf(
        timeout(
          callable(async (_prompt, signal) => {
            signal.addEventListener('abort', () => log.push('aborted'));
            return source(gate.promise);
          }),
          { stallMs: 1000 },
        ),
      )({ messages: [] }, current().signal);
      const reader = stream[Symbol.asyncIterator]();
      await reader.next();
      const pulling = reader.next();
      await Bun.sleep(1);
      await reader.return?.();
      log.push(`read ${(await orHung(pulling)) === 'hung' ? 'hung' : 'ended'}`);
      await Bun.sleep(2);
      log.push('released');
      gate.resolve();
      await Bun.sleep(2);
    }
  });

  expect(log).toEqual([
    'aborted',
    'read ended',
    'released',
    'closed',
    'aborted',
    'read ended',
    'released',
    'closed',
  ]);
});
