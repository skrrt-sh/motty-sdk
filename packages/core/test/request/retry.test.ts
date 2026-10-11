import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import {
  Aborted,
  Blocked,
  LimitReached,
  MottyError,
  Overloaded,
  QuotaExceeded,
  RateLimited,
  TimedOut,
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

test('a count of retries that is not a whole number is a mistake at load', () => {
  expect(() => retry(model('acme/small'), 1.5)).toThrow(Error);
  expect(() => retry(model('acme/small'), 0.5)).toThrow(Error);
  expect(() => retry(model('acme/small'), 2)).not.toThrow();
});

test('retry answers from the first try without waiting', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const [text, calls] = await enter(host, async () => {
    const reply = await due(
      retry(model('acme/small'), 3).complete({
        messages: [],
      }),
    );
    return [await due(reply.text()), current().calls];
  });

  expect(text).toBe('Hello');
  expect(calls.made).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry backs off 500 ms, then double, and throws the last failure once its retries are spent', async () => {
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
    const failed = retry(model('acme/busy'), 2)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    expect(current().calls.made).toHaveLength(1);
    jest.advanceTimersByTime(499);
    await settled();
    expect(current().calls.made).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await settled();
    expect(current().calls.made).toHaveLength(2);
    jest.advanceTimersByTime(999);
    await settled();
    expect(current().calls.made).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(await due(failed)).toBeInstanceOf(Overloaded);
    expect(current().calls.made).toHaveLength(3);
  });

  expect(jest.getTimerCount()).toBe(0);
});

test('retry answers once a retried call works', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  let tries = 0;

  const text = await enter(host, async () => {
    const pending = retry(
      callable(async (prompt, signal) => {
        tries += 1;
        if (tries === 1) throw new Overloaded('Busy');
        return callOf(model('acme/small'))(prompt, signal);
      }),
      1,
    ).complete({ messages: [] });
    await settled();
    jest.advanceTimersByTime(500);
    const reply = await due(pending);
    return due(reply.text());
  });

  expect(text).toBe('Hello');
  expect(tries).toBe(2);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry with no retries makes one try and throws its failure', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/busy': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
  });

  const calls = await enter(host, async () => {
    expect(
      await due(
        retry(model('acme/busy'), 0)
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown),
      ),
    ).toBeInstanceOf(Overloaded);
    return current().calls;
  });

  expect(calls.made).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry stops at a failure that is not retryable after one that was', async () => {
  jest.useFakeTimers();
  const host = stubHost();
  let tries = 0;

  await enter(host, async () => {
    const failed = retry(
      callable(async () => {
        tries += 1;
        throw tries === 1 ? new Overloaded('Busy') : new Blocked('Refused');
      }),
      5,
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(500);
    expect(await due(failed)).toBeInstanceOf(Blocked);
  });

  expect(tries).toBe(2);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry repeats a rate limit but not a spent quota', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/limited': [
      {
        type: 'error',
        error: { code: 'rate_limited', status: 429, message: 'Slow down' },
      },
    ],
    'acme/spent': [
      {
        type: 'error',
        error: { code: 'quota_exceeded', status: 429, message: 'No credit' },
      },
    ],
  });

  await enter(host, async () => {
    expect(
      await due(
        retry(model('acme/spent'), 2)
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown),
      ),
    ).toBeInstanceOf(QuotaExceeded);
    const failed = retry(model('acme/limited'), 1)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(500);
    expect(await due(failed)).toBeInstanceOf(RateLimited);
  });

  expect(host.sent('acme/spent')).toHaveLength(1);
  expect(host.sent('acme/limited')).toHaveLength(2);
});

test('retry repeats a call that timed out', async () => {
  jest.useFakeTimers();
  const host = stubHost();
  const signals: AbortSignal[] = [];

  await enter(host, async () => {
    const failed = retry(timeout(hung(signals), 5), 1)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(5);
    await settled();
    expect(signals).toHaveLength(1);
    jest.advanceTimersByTime(500);
    await settled();
    expect(signals).toHaveLength(2);
    jest.advanceTimersByTime(5);
    expect(await due(failed)).toBeInstanceOf(TimedOut);
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry calls again at once on a retry-after of zero', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/limited': [
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfter: 0,
        },
      },
    ],
  });

  await enter(host, async () => {
    const failed = retry(model('acme/limited'), 1)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(1);
    expect(await due(failed)).toBeInstanceOf(RateLimited);
  });

  expect(host.sent('acme/limited')).toHaveLength(2);
});

test('a try that failed before a later one answered stays in the calls with its code and its message', async () => {
  jest.useFakeTimers();
  const replies: StreamEvent[][] = [
    [
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfter: 0,
        },
      },
    ],
    [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop' },
    ],
  ];
  const host = {
    ...stubHost(),
    models: async function* () {
      yield* replies.shift() ?? [];
    },
  };

  const made = await enter(host, async () => {
    const reply = retry(model('acme/limited'), 1).complete({ messages: [] });
    await settled();
    jest.advanceTimersByTime(1);
    await (await due(reply)).text();
    return current().calls.made;
  });

  expect(made).toStrictEqual([
    {
      model: 'acme/limited',
      latency: expect.any(Number),
      firstEvent: expect.any(Number),
      code: 'rate_limited',
      message: 'Slow down',
    },
    {
      model: 'acme/limited',
      latency: expect.any(Number),
      firstEvent: expect.any(Number),
    },
  ]);
});

test('retry follows what the upstream said about a failure over its class', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/final': [
      {
        type: 'error',
        error: {
          code: 'overloaded',
          status: 503,
          message: 'Busy for good',
          retryable: false,
        },
      },
    ],
    'acme/passing': [
      {
        type: 'error',
        error: {
          code: 'invalid_request',
          status: 400,
          message: 'Try again',
          retryable: true,
        },
      },
    ],
  });

  await enter(host, async () => {
    expect(
      await due(
        retry(model('acme/final'), 2)
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown),
      ),
    ).toBeInstanceOf(Overloaded);
    const failed = retry(model('acme/passing'), 1)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(500);
    expect(await due(failed)).toBeInstanceOf(MottyError);
  });

  expect(host.sent('acme/final')).toHaveLength(1);
  expect(host.sent('acme/passing')).toHaveLength(2);
});

test('retry does not repeat a thrown value that is not one of the core’s errors', async () => {
  jest.useFakeTimers();
  const host = stubHost();
  let tries = 0;

  await enter(host, async () =>
    expect(
      await due(
        retry(
          callable(async () => {
            tries += 1;
            throw new TypeError('Not ours');
          }),
          2,
        )
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown),
      ),
    ).toBeInstanceOf(TypeError),
  );

  expect(tries).toBe(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry does not repeat a failure that came after the first chunk', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/breaking': [
      { type: 'text', text: 'Hel' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
  });

  await enter(host, async () => {
    const reply = await due(
      retry(model('acme/breaking'), 2).complete({
        messages: [],
      }),
    );
    expect(
      await due(reply.text().catch((thrown: unknown) => thrown)),
    ).toBeInstanceOf(Overloaded);
  });

  expect(host.sent('acme/breaking')).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry makes no try when the request was stopped before the first', async () => {
  const request = new AbortController();
  request.abort();
  let tries = 0;

  await enter(stubHost({}, { signal: request.signal }), () =>
    expect(
      retry(
        callable(async () => {
          tries += 1;
          throw new Overloaded('Busy');
        }),
        2,
      ).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(Aborted),
  );

  expect(tries).toBe(0);
});

test('retry ends its wait with Aborted when the request is stopped, and calls no more', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const host = stubHost(
    {
      'acme/limited': [
        {
          type: 'error',
          error: {
            code: 'rate_limited',
            status: 429,
            message: 'Slow down',
            retryAfter: 1500,
          },
        },
      ],
    },
    { signal: request.signal },
  );

  await enter(host, async () => {
    const failed = retry(model('acme/limited'), 2)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(1499);
    await settled();
    expect(jest.getTimerCount()).toBe(1);
    request.abort();
    expect(await due(failed)).toBeInstanceOf(Aborted);
  });

  expect(host.sent('acme/limited')).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry stops with Aborted, the failure it got as its cause, without waiting, when the request is stopped as a try fails', async () => {
  jest.useFakeTimers();
  let tries = 0;

  for (const failure of [new Overloaded('Busy'), new Blocked('Refused')]) {
    const request = new AbortController();
    const failed = await enter(stubHost({}, { signal: request.signal }), () =>
      retry(
        callable(async () => {
          tries += 1;
          request.abort();
          throw failure;
        }),
        2,
      )
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown),
    );

    expect(failed).toBeInstanceOf(Aborted);
    expect(failed).toHaveProperty('cause', failure);
  }

  expect(tries).toBe(2);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry stops with Aborted, the call’s own failure as its cause, when the request is stopped during a try', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const signals: AbortSignal[] = [];

  await enter(stubHost({}, { signal: request.signal }), async () => {
    const failed = retry(hung(signals), 2)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    request.abort();
    const thrown = await due(failed);
    expect(thrown).toBeInstanceOf(Aborted);
    expect(thrown).toHaveProperty('message', 'The work was stopped');
    expect(thrown).toHaveProperty('cause.message', 'The call was stopped');
  });

  expect(signals).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry throws a failure that is not retryable at once', async () => {
  const host = stubHost({
    'acme/strict': [
      {
        type: 'error',
        error: { code: 'blocked', status: 400, message: 'Refused' },
      },
    ],
  });

  const calls = await enter(host, async () => {
    await expect(
      retry(model('acme/strict'), 2).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(Blocked);
    return current().calls;
  });

  expect(calls.made).toHaveLength(1);
});

test('retry waits the failure’s retry-after before it calls again', async () => {
  const host = stubHost({
    'acme/limited': [
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfter: 20,
        },
      },
    ],
  });

  const [early, late] = await enter(host, async () => {
    const pending = retry(model('acme/limited'), 1).complete({ messages: [] });
    await Bun.sleep(5);
    const early = current().calls.made.length;
    await expect(pending).rejects.toBeInstanceOf(RateLimited);
    return [early, current().calls.made.length];
  });

  expect([early, late]).toEqual([1, 2]);
});

test('retry doubles its backoff from 500 ms and holds it at 30 seconds, however many retries came before', async () => {
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
    const failed = retry(model('acme/busy'), 30)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    for (const [retried, ms] of [
      500,
      1000,
      2000,
      4000,
      8000,
      16_000,
      ...Array<number>(24).fill(30_000),
    ].entries()) {
      jest.advanceTimersByTime(ms - 1);
      await settled();
      expect(current().calls.made).toHaveLength(retried + 1);
      jest.advanceTimersByTime(1);
      await settled();
      expect(current().calls.made).toHaveLength(retried + 2);
    }
    expect(await due(failed)).toBeInstanceOf(Overloaded);
  });

  expect(jest.getTimerCount()).toBe(0);
});

test('retry gives up at once on a retry-after longer than its backoff cap, with the failure as it came, so a fallback moves on', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/limited': [
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfter: 30_001,
          provider: { plan: 'free' },
        },
      },
    ],
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  await enter(host, async () => {
    const failed = await due(
      retry(model('acme/limited'), 3)
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown),
    );
    const reply = await due(
      fallback(retry(model('acme/limited'), 3), model('acme/small')).complete({
        messages: [],
      }),
    );

    expect(failed).toBeInstanceOf(RateLimited);
    expect(failed).toMatchObject({
      message: 'Slow down',
      status: 429,
      retryable: true,
      retryAfter: 30_001,
      provider: { plan: 'free' },
    });
    expect(await due(reply.text())).toBe('Hello');
  });

  expect(host.sent('acme/limited')).toHaveLength(2);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry gives up at once on a retry-after of a day or of longer than any timer runs', async () => {
  jest.useFakeTimers();

  for (const retryAfter of [86_400_000, 2 ** 40]) {
    let tries = 0;
    const failed = await enter(stubHost(), () =>
      due(
        retry(
          callable(async () => {
            tries += 1;
            throw new RateLimited('Slow down', { retryAfter });
          }),
          20,
        )
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown),
      ),
    );

    expect(failed).toBeInstanceOf(RateLimited);
    expect(tries).toBe(1);
  }

  expect(jest.getTimerCount()).toBe(0);
});

test('retry waits out a retry-after as long as its backoff cap', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/limited': [
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfter: 30_000,
        },
      },
    ],
  });

  await enter(host, async () => {
    const failed = retry(model('acme/limited'), 1)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(29_999);
    await settled();
    expect(current().calls.made).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(await due(failed)).toBeInstanceOf(RateLimited);
    expect(current().calls.made).toHaveLength(2);
  });
});

test('retry backs off as if unhinted when the retry-after is negative or not a finite number', async () => {
  jest.useFakeTimers();

  for (const retryAfter of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    let tries = 0;
    await enter(stubHost(), async () => {
      const failed = retry(
        callable(async () => {
          tries += 1;
          throw new RateLimited('Slow down', { retryAfter });
        }),
        1,
      )
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown);
      await settled();
      jest.advanceTimersByTime(499);
      await settled();
      expect(tries).toBe(1);
      jest.advanceTimersByTime(1);
      expect(await due(failed)).toBeInstanceOf(RateLimited);
      expect(tries).toBe(2);
    });
  }

  expect(jest.getTimerCount()).toBe(0);
});

test('retry never repeats Aborted or LimitReached, whatever their facts say about retrying', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/left': [
      {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'Gone',
          retryable: true,
        },
      },
    ],
    'acme/capped': [
      {
        type: 'error',
        error: {
          code: 'limit_reached',
          status: 500,
          message: 'Enough',
          retryable: true,
          retryAfter: 0,
        },
      },
    ],
  });

  await enter(host, async () => {
    const left = await due(
      retry(model('acme/left'), 2)
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown),
    );
    const capped = await due(
      retry(model('acme/capped'), 2)
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown),
    );

    expect(left).toBeInstanceOf(Aborted);
    expect(left).toHaveProperty('message', 'Gone');
    expect(left).toHaveProperty('retryable', true);
    expect(capped).toBeInstanceOf(LimitReached);
    expect(capped).toHaveProperty('retryable', true);
  });

  expect(host.sent('acme/left')).toHaveLength(1);
  expect(host.sent('acme/capped')).toHaveLength(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry does not repeat a thrown value that only looks retryable and is not one of the core’s errors', async () => {
  jest.useFakeTimers();
  let tries = 0;

  const failed = await enter(stubHost(), () =>
    retry(
      callable(async () => {
        tries += 1;
        throw Object.assign(new TypeError('Not ours'), {
          retryable: true,
          retryAfter: 0,
        });
      }),
      2,
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown),
  );

  expect(failed).toBeInstanceOf(TypeError);
  expect(tries).toBe(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry throws LimitReached as it is from the try after a wait, and waits no more', async () => {
  jest.useFakeTimers();
  const host = stubHost(
    {
      'acme/busy': [
        {
          type: 'error',
          error: { code: 'overloaded', status: 503, message: 'Busy' },
        },
      ],
    },
    { limits: { calls: 2 } },
  );

  await enter(host, async () => {
    const failed = retry(model('acme/busy'), 5)
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(500);
    await settled();
    expect(current().calls.made).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(1000);
    const thrown = await due(failed);
    expect(thrown).toBeInstanceOf(LimitReached);
    expect(current().calls.made).toHaveLength(2);
  });

  expect(host.sent('acme/busy')).toHaveLength(2);
  expect(jest.getTimerCount()).toBe(0);
});

test('retry drops its listener from the signal once a wait has run its course', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const added = spyOn(request.signal, 'addEventListener');
  const removed = spyOn(request.signal, 'removeEventListener');
  let tries = 0;

  await enter(stubHost(), async () => {
    const pending = callOf(
      retry(
        callable(async (prompt, signal) => {
          tries += 1;
          if (tries === 1) throw new Overloaded('Busy');
          return callOf(scripted([{ type: 'text', text: 'Hello' }]))(
            prompt,
            signal,
          );
        }),
        1,
      ),
    )({ messages: [] }, request.signal);
    await settled();
    jest.advanceTimersByTime(500);
    await due(pending);
  });

  expect(added.mock.calls.length).toBeGreaterThan(0);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
});

test('retry stopped during a later try that ignores its signal carries the failure of the try before', async () => {
  jest.useFakeTimers();
  const request = new AbortController();
  const failure = new Overloaded('Busy');
  const signals: AbortSignal[] = [];

  await enter(stubHost({}, { signal: request.signal }), async () => {
    const pending = retry(
      callable((prompt, signal) => {
        signals.push(signal);
        return signals.length === 1
          ? Promise.reject(failure)
          : callOf(deaf())(prompt, signal);
      }),
      2,
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await settled();
    jest.advanceTimersByTime(500);
    await settled();
    request.abort();
    expect(await due(pending)).toHaveProperty('cause', failure);
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
  expect(jest.getTimerCount()).toBe(0);
});

test('a count of retries that is not a number is a mistake at load, never coerced into one', () => {
  for (const times of ['2', null, true, undefined, [2], 2n]) {
    expect(() =>
      Reflect.apply(retry, undefined, [model('acme/small'), times]),
    ).toThrow('retry() needs a whole number of retries');
  }
});
