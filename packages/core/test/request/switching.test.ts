import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import {
  Aborted,
  Blocked,
  Overloaded,
  UnknownModel,
} from '../../src/data/errors.ts';
import type { StreamEvent } from '../../src/data/event.ts';
import { current, endPhase, enter } from '../../src/request/context.ts';
import {
  callable,
  callOf,
  type Model,
  model,
} from '../../src/request/model.ts';
import { retry } from '../../src/request/retry.ts';
import { fallback, race } from '../../src/request/switching.ts';
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

test('fallback answers with the first model when it answers', async () => {
  const host = stubHost({
    'acme/first': [
      { type: 'text', text: 'First' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
    'acme/second': [
      { type: 'text', text: 'Second' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await fallback(
      model('acme/first'),
      model('acme/second'),
    ).complete({ messages: [] });
    return reply.text();
  });

  expect(text).toBe('First');
  expect(host.sent('acme/second')).toEqual([]);
});

test('fallback moves past a model the host cannot serve', async () => {
  const host = stubHost({
    'acme/second': [
      { type: 'text', text: 'Second' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 2, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  const [text, calls] = await enter(host, async () => {
    const reply = await fallback(
      model('acme/missing'),
      model('acme/second'),
    ).complete({ messages: [] });
    return [await reply.text(), current().calls];
  });

  expect(text).toBe('Second');
  expect(calls.made.map((made) => made.model)).toEqual([
    'acme/missing',
    'acme/second',
  ]);
});

test('fallback reaches its last model when every one before it failed', async () => {
  const host = stubHost({
    'acme/first': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
    'acme/third': [
      { type: 'text', text: 'Third' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const [text, calls] = await enter(host, async () => {
    const reply = await fallback(
      model('acme/first'),
      model('acme/missing'),
      model('acme/third'),
    ).complete({ messages: [] });
    return [await reply.text(), current().calls];
  });

  expect(text).toBe('Third');
  expect(calls.made.map((made) => made.model)).toEqual([
    'acme/first',
    'acme/missing',
    'acme/third',
  ]);
});

test('fallback stops at a middle model that answers', async () => {
  const host = stubHost({
    'acme/second': [
      { type: 'text', text: 'Second' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
    'acme/third': [
      { type: 'text', text: 'Third' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await fallback(
      model('acme/missing'),
      model('acme/second'),
      model('acme/third'),
    ).complete({ messages: [] });
    return reply.text();
  });

  expect(text).toBe('Second');
  expect(host.sent('acme/third')).toEqual([]);
});

test('fallback over one model answers with it or throws its failure', async () => {
  const host = stubHost({
    'acme/only': [
      { type: 'text', text: 'Only' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  await enter(host, async () => {
    const reply = await fallback(model('acme/only')).complete({
      messages: [],
    });
    expect(await reply.text()).toBe('Only');
    await expect(
      fallback(model('acme/missing')).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(UnknownModel);
  });
});

test('fallback asks no model when the request was stopped before the first try', async () => {
  const request = new AbortController();
  request.abort();
  let tries = 0;

  const failed = await enter(stubHost({}, { signal: request.signal }), () =>
    fallback(
      callable(async () => {
        tries += 1;
        throw new Overloaded('Busy');
      }),
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown),
  );

  expect(failed).toBeInstanceOf(Aborted);
  expect(failed instanceof Aborted ? failed.cause : failed).toBeUndefined();
  expect(tries).toBe(0);
});

test('fallback stops with Aborted, the try’s failure as its cause, when the request is stopped during a try', async () => {
  const request = new AbortController();
  const host = stubHost(
    {
      'acme/second': [
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
      ],
    },
    { signal: request.signal },
  );

  const failed = await enter(host, async () => {
    const pending = fallback(hung(), model('acme/second'))
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await Bun.sleep(1);
    request.abort();
    return pending;
  });

  expect(failed).toBeInstanceOf(Aborted);
  expect(failed).toHaveProperty('message', 'The work was stopped');
  expect(failed).toHaveProperty('cause.message', 'The call was stopped');
  expect(host.sent('acme/second')).toEqual([]);
});

test('fallback throws its last model’s failure when every model failed', async () => {
  const host = stubHost({
    'acme/first': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
    'acme/second': [
      {
        type: 'error',
        error: { code: 'blocked', status: 400, message: 'Refused' },
      },
    ],
  });

  await enter(host, () =>
    expect(
      fallback(model('acme/first'), model('acme/second')).complete({
        messages: [],
      }),
    ).rejects.toBeInstanceOf(Blocked),
  );
});

test('fallback does not switch once the first chunk has arrived', async () => {
  const host = stubHost({
    'acme/first': [
      { type: 'text', text: 'Fir' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
    'acme/second': [
      { type: 'text', text: 'Second' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  await enter(host, async () => {
    const reply = await fallback(
      model('acme/first'),
      model('acme/second'),
    ).complete({ messages: [] });
    await expect(reply.text()).rejects.toBeInstanceOf(Overloaded);
  });

  expect(host.sent('acme/second')).toEqual([]);
});

test('fallback stops with Aborted, the failure it got as its cause, when the request is stopped as a try fails', async () => {
  const request = new AbortController();
  const host = stubHost(
    {
      'acme/second': [
        {
          type: 'finish',
          reason: 'stop',
          usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
        },
      ],
    },
    { signal: request.signal },
  );

  const failed = await enter(host, () =>
    fallback(
      callable(async () => {
        request.abort();
        throw new Overloaded('Busy');
      }),
      model('acme/second'),
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown),
  );

  expect(failed).toBeInstanceOf(Aborted);
  expect(failed instanceof Aborted ? failed.cause : failed).toBeInstanceOf(
    Overloaded,
  );
  expect(host.sent('acme/second')).toEqual([]);
});

test('fallback stops with Aborted when the request is stopped as its last model fails', async () => {
  const request = new AbortController();

  const failed = await enter(stubHost({}, { signal: request.signal }), () =>
    fallback(
      callable(async () => {
        request.abort();
        throw new Blocked('Refused');
      }),
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown),
  );

  expect(failed).toBeInstanceOf(Aborted);
  expect(failed instanceof Aborted ? failed.cause : failed).toBeInstanceOf(
    Blocked,
  );
});

test('a combinator given nothing to work with is a mistake at load', () => {
  expect(() => fallback()).toThrow(Error);
  expect(() => race()).toThrow(Error);
  expect(() => fallback({ complete: model('acme/small').complete })).toThrow(
    'Not a model',
  );
  expect(() => race({ complete: model('acme/small').complete })).toThrow(
    'Not a model',
  );
  expect(() => retry({ complete: model('acme/small').complete }, 1)).toThrow(
    'Not a model',
  );
  expect(() => timeout({ complete: model('acme/small').complete }, 1)).toThrow(
    'Not a model',
  );
});

test('race answers with the first to resolve and gives up the pending loser, which is counted once', async () => {
  const host = stubHost({
    'acme/slow': [
      { type: 'text', text: 'Slow' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 5, output: 5, cached: 0, reasoning: 0 },
      },
    ],
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 2, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });
  const signals: AbortSignal[] = [];

  const [text, calls] = await enter(host, async () => {
    const reply = await race(
      held(model('acme/slow'), 1000, signals),
      model('acme/fast'),
    ).complete({ messages: [] });
    const text = await reply.text();
    await Bun.sleep(1);
    return [text, current().calls];
  });

  expect(text).toBe('Fast');
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  expect(calls.made.map((made) => made.model).sort()).toEqual([
    'acme/fast',
    'acme/slow',
  ]);
  expect(calls.total).toMatchObject({ input: 2, output: 1 });
});

test('race answers with the one that works when another fails', async () => {
  const host = stubHost({
    'acme/second': [
      { type: 'text', text: 'Second' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await race(
      model('acme/missing'),
      held(model('acme/second'), 2),
    ).complete({ messages: [] });
    return reply.text();
  });

  expect(text).toBe('Second');
});

test('race throws its first-listed model’s failure when every model fails, not the first to fail', async () => {
  const host = stubHost({
    'acme/second': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
  });

  await enter(host, () =>
    expect(
      race(
        callable(async () => {
          await Bun.sleep(2);
          throw new Blocked('Refused');
        }),
        model('acme/second'),
      ).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(Blocked),
  );
});

test('race keeps its winner when a loser fails after it', async () => {
  const host = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await race(
      model('acme/fast'),
      callable(async () => {
        await Bun.sleep(2);
        throw new Overloaded('Busy');
      }),
    ).complete({ messages: [] });
    await Bun.sleep(4);
    return reply.text();
  });

  expect(text).toBe('Fast');
});

test('race gives up a loser that fails with Aborted once it is cancelled', async () => {
  const host = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const signals: AbortSignal[] = [];

  const text = await enter(host, async () => {
    const reply = await race(hung(signals), model('acme/fast')).complete({
      messages: [],
    });
    await Bun.sleep(1);
    return reply.text();
  });

  expect(text).toBe('Fast');
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('race between two that resolve in one tick answers with one and gives up the other, each counted once', async () => {
  const host = stubHost({
    'acme/first': [
      { type: 'text', text: 'First' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
    'acme/second': [
      { type: 'text', text: 'Second' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const [text, calls] = await enter(host, async () => {
    const reply = await race(
      model('acme/first'),
      model('acme/second'),
    ).complete({ messages: [] });
    const text = await reply.text();
    await Bun.sleep(1);
    return [text, current().calls];
  });

  expect(text).toBe('First');
  expect(calls.made.map((made) => made.model).sort()).toEqual([
    'acme/first',
    'acme/second',
  ]);
});

test('race stops with its own Aborted when the request is stopped while all are pending', async () => {
  const request = new AbortController();
  const host = stubHost({}, { signal: request.signal });
  const signals: AbortSignal[] = [];

  const failed = await enter(host, async () => {
    const pending = race(hung(signals), hung(signals))
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown);
    await Bun.sleep(1);
    request.abort();
    return pending;
  });

  expect(failed).toBeInstanceOf(Aborted);
  expect(failed).toHaveProperty('message', 'The work was stopped');
  expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
});

test('race stops waiting with Aborted once the request is stopped, though one model never settles and the rest failed', async () => {
  const request = new AbortController();
  const signals: AbortSignal[] = [];

  const failed = await enter(
    stubHost({}, { signal: request.signal }),
    async () => {
      const pending = race(deaf(signals), model('acme/missing'))
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown);
      await Bun.sleep(2);
      request.abort();
      return orHung(pending);
    },
  );

  expect(failed).toBeInstanceOf(Aborted);
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('race gives up a call that resolves only after the request was stopped', async () => {
  const request = new AbortController();
  const log: string[] = [];

  const failed = await enter(
    stubHost({}, { signal: request.signal }),
    async () => {
      const pending = race(
        deaf(),
        callable(async (prompt, signal) => {
          await Bun.sleep(4);
          return callOf(scripted([{ type: 'text', text: 'Late' }], log))(
            prompt,
            signal,
          );
        }),
      )
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown);
      await Bun.sleep(1);
      request.abort();
      const failed = await orHung(pending);
      await Bun.sleep(6);
      return failed;
    },
  );

  expect(failed).toBeInstanceOf(Aborted);
  expect(log).toEqual(['iterator', 'return']);
});

test('race asks no model when the request was stopped before it began', async () => {
  const request = new AbortController();
  request.abort();
  const signals: AbortSignal[] = [];

  const failed = await enter(stubHost({}, { signal: request.signal }), () =>
    race(deaf(signals), deaf(signals))
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown),
  );

  expect(failed).toBeInstanceOf(Aborted);
  expect(signals).toEqual([]);
});

test('race leaves no listener on the signal it was given, whether it answered or failed', async () => {
  const request = new AbortController();
  const added = spyOn(request.signal, 'addEventListener');
  const removed = spyOn(request.signal, 'removeEventListener');

  await enter(stubHost(), async () => {
    const answered = await callOf(
      race(
        scripted([{ type: 'text', text: 'Fast' }]),
        callable(async () => {
          throw new Overloaded('Busy');
        }),
      ),
    )({ messages: [] }, request.signal);
    await answered[Symbol.asyncIterator]().return?.();
    await callOf(
      race(
        callable(async () => {
          throw new Overloaded('Busy');
        }),
      ),
    )({ messages: [] }, request.signal).catch(() => {});
  });

  expect(added.mock.calls.length).toBeGreaterThan(0);
  expect(new Set(removed.mock.calls.map(([, listener]) => listener))).toEqual(
    new Set(added.mock.calls.map(([, listener]) => listener)),
  );
});

test('race gives up a loser that never ends without reading it, through the one iterator it took', async () => {
  const log: string[] = [];

  const first = await enter(stubHost(), async () => {
    const stream = await callOf(
      race(
        scripted([{ type: 'text', text: 'Fast' }]),
        callable(async (prompt, signal) => {
          await Bun.sleep(2);
          return callOf(
            scripted(
              [{ type: 'text', text: 'Slow' }],
              log,
              () => new Promise(() => {}),
            ),
          )(prompt, signal);
        }),
      ),
    )({ messages: [] }, current().signal);
    await Bun.sleep(6);
    return orHung(stream[Symbol.asyncIterator]().next());
  });

  expect(first).toEqual({ done: false, value: { type: 'text', text: 'Fast' } });
  expect(log).toEqual(['iterator', 'return']);
});

test('race hands on the one iterator it took from its winner', async () => {
  const log: string[] = [];

  const events = await enter(stubHost(), async () => {
    const stream = await callOf(
      race(
        scripted(
          [
            { type: 'text', text: 'Only' },
            { type: 'finish', reason: 'stop' },
          ],
          log,
        ),
      ),
    )({ messages: [] }, current().signal);
    const reader = stream[Symbol.asyncIterator]();
    return [(await reader.next()).value, (await reader.next()).value];
  });

  expect(events).toEqual([
    { type: 'text', text: 'Only' },
    { type: 'finish', reason: 'stop' },
  ]);
  expect(log).toEqual(['iterator']);
});

test('race over one model answers with it or throws its failure', async () => {
  const host = stubHost({
    'acme/only': [
      { type: 'text', text: 'Only' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  await enter(host, async () => {
    const reply = await race(model('acme/only')).complete({ messages: [] });
    expect(await reply.text()).toBe('Only');
    await expect(
      race(model('acme/missing')).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(UnknownModel);
  });
});

test('race treats a call that throws before returning a promise as one more failure', async () => {
  const host = stubHost({
    'acme/second': [
      { type: 'text', text: 'Second' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await race(
      callable(() => {
        throw new Blocked('Refused');
      }),
      model('acme/second'),
    ).complete({ messages: [] });
    return reply.text();
  });

  expect(text).toBe('Second');
});

test('fallback over retry spends the retries, then asks the next model', async () => {
  jest.useFakeTimers();
  const host = stubHost({
    'acme/busy': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
      },
    ],
    'acme/second': [
      { type: 'text', text: 'Second' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const [text, calls] = await enter(host, async () => {
    const pending = fallback(
      retry(model('acme/busy'), 2),
      model('acme/second'),
    ).complete({ messages: [] });
    await settled();
    jest.advanceTimersByTime(500);
    await settled();
    jest.advanceTimersByTime(1000);
    const reply = await due(pending);
    return [await due(reply.text()), current().calls];
  });

  expect(text).toBe('Second');
  expect(calls.made.map((made) => made.model)).toEqual([
    'acme/busy',
    'acme/busy',
    'acme/busy',
    'acme/second',
  ]);
});

test('fallback over timeout moves on from a hung model', async () => {
  const host = stubHost({
    'acme/hung': [
      { type: 'text', text: 'Late' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
    'acme/second': [
      { type: 'text', text: 'Second' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await fallback(
      timeout(held(model('acme/hung'), 1000), 5),
      model('acme/second'),
    ).complete({ messages: [] });
    return reply.text();
  });

  expect(text).toBe('Second');
});

test('a combinator keeps the typed value of a Standard Schema', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: '{"city":"Oslo"}' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 2, cached: 0, reasoning: 0 },
      },
    ],
  });

  const place = await enter(host, async () => {
    const reply = await fallback(
      retry(model('acme/small'), 1),
      model('acme/large'),
    ).complete({
      messages: [],
      output: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) =>
            typeof value === 'object' &&
            value !== null &&
            'city' in value &&
            typeof value.city === 'string'
              ? { value: { city: value.city } }
              : { issues: [{ message: 'city must be a string' }] },
          jsonSchema: {
            output: () => ({
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            }),
          },
        },
      },
    });
    const place: { city: string } = await reply.json();
    return place;
  });

  expect(place).toEqual({ city: 'Oslo' });
});

test('a call that ignores its signal holds no combinator once the request is stopped', async () => {
  for (const wrap of [
    (inner: Model) => timeout(inner, 1000),
    (inner: Model) => timeout(inner, { stallMs: 1000 }),
    (inner: Model) => retry(inner, 2),
    (inner: Model) => fallback(inner, model('acme/next')),
    (inner: Model) => race(inner, inner),
  ]) {
    const request = new AbortController();
    const signals: AbortSignal[] = [];
    const host = stubHost(
      { 'acme/next': [{ type: 'finish', reason: 'stop' }] },
      { signal: request.signal },
    );

    const failed = await enter(host, async () => {
      const pending = wrap(deaf(signals))
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown);
      await Bun.sleep(1);
      request.abort();
      return orHung(pending);
    });

    expect(failed).toBeInstanceOf(Aborted);
    expect(failed).toHaveProperty('message', 'The work was stopped');
    expect(failed).not.toHaveProperty('cause');
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(host.sent('acme/next')).toEqual([]);
  }
});

test('a combinator stopped while a call that ignores its signal is pending leaves no timer, and put one listener on the signal it was given', async () => {
  jest.useFakeTimers();

  for (const wrap of [
    (inner: Model) => timeout(inner, 1000),
    (inner: Model) => retry(inner, 2),
    (inner: Model) => fallback(inner, inner),
    (inner: Model) => race(inner, inner),
  ]) {
    const request = new AbortController();
    const added = spyOn(request.signal, 'addEventListener');

    await enter(stubHost(), async () => {
      const pending = callOf(wrap(deaf()))(
        { messages: [] },
        request.signal,
      ).catch((thrown: unknown) => thrown);
      await settled();
      request.abort();
      expect(await due(pending)).toBeInstanceOf(Aborted);
    });

    expect(jest.getTimerCount()).toBe(0);
    expect(added).toHaveBeenCalledTimes(1);
  }
});

test('a call that answers only after it was given up on the signal has its stream closed', async () => {
  for (const wrap of [
    (inner: Model) => timeout(inner, 1000),
    (inner: Model) => retry(inner, 2),
    (inner: Model) => fallback(inner, inner),
  ]) {
    const request = new AbortController();
    const log: string[] = [];

    const failed = await enter(
      stubHost({}, { signal: request.signal }),
      async () => {
        const pending = wrap(
          callable(async (prompt, signal) => {
            await Bun.sleep(4);
            return callOf(scripted([{ type: 'text', text: 'Late' }], log))(
              prompt,
              signal,
            );
          }),
        )
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown);
        await Bun.sleep(1);
        request.abort();
        const failed = await orHung(pending);
        await Bun.sleep(6);
        return failed;
      },
    );

    expect(failed).toBeInstanceOf(Aborted);
    expect(log).toEqual(['iterator', 'return']);
  }
});

test('race clears the first-chunk clock of a loser that ignores its signal', async () => {
  jest.useFakeTimers();
  const signals: AbortSignal[] = [];

  await enter(stubHost(), async () => {
    const pending = callOf(
      race(
        held(scripted([{ type: 'text', text: 'Fast' }]), 10),
        timeout(deaf(signals), 5000),
      ),
    )({ messages: [] }, current().signal);
    await settled();
    expect(jest.getTimerCount()).toBe(2);
    jest.advanceTimersByTime(10);
    await due(pending);
    await settled();
  });

  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
  expect(jest.getTimerCount()).toBe(0);
});

test('a combinator stopped while it holds a failure throws Aborted with that failure as the cause', async () => {
  jest.useFakeTimers();

  for (const wrap of [
    (failing: Model) => retry(failing, 2),
    (failing: Model) => fallback(failing, deaf()),
    (failing: Model) => race(deaf(), failing, model('acme/missing')),
  ]) {
    const request = new AbortController();
    const failure = new Overloaded('Busy');

    await enter(stubHost({}, { signal: request.signal }), async () => {
      const pending = wrap(
        callable(async () => {
          throw failure;
        }),
      )
        .complete({ messages: [] })
        .catch((thrown: unknown) => thrown);
      await settled();
      request.abort();
      const failed = await due(pending);
      expect(failed).toBeInstanceOf(Aborted);
      expect(failed).toHaveProperty('cause', failure);
    });

    expect(jest.getTimerCount()).toBe(0);
  }
});

test('a combinator stopped before it began asks no model and throws Aborted with no cause', async () => {
  for (const wrap of [
    (inner: Model) => fallback(inner, inner),
    (inner: Model) => race(inner, inner),
    (inner: Model) => retry(inner, 2),
    (inner: Model) => timeout(inner, 1000),
    (inner: Model) => timeout(inner, { stallMs: 1000 }),
  ]) {
    const request = new AbortController();
    request.abort();
    const signals: AbortSignal[] = [];

    const failed = await enter(stubHost({}, { signal: request.signal }), () =>
      orHung(
        wrap(deaf(signals))
          .complete({ messages: [] })
          .catch((thrown: unknown) => thrown),
      ),
    );

    expect(failed).toBeInstanceOf(Aborted);
    expect(failed).not.toHaveProperty('cause');
    expect(signals).toEqual([]);
  }
});

test('a combinator whose calls all failed throws Aborted, the failure it would have thrown as the cause, when the request is stopped before it resumes', async () => {
  for (const wrap of [
    (failing: Model) =>
      race(
        failing,
        callable(async () => {
          throw new Overloaded('Busy');
        }),
      ),
    (failing: Model) => fallback(failing),
    (failing: Model) => retry(failing, 2),
    (failing: Model) => timeout(failing, 1000),
  ]) {
    const outcomes = new Set<string>();

    for (let ticks = 0; ticks < 12; ticks += 1) {
      const request = new AbortController();
      const failure = new Blocked('Refused');
      const stoppedAtTheEnd: boolean[] = [];
      const remove = request.signal.removeEventListener.bind(request.signal);
      spyOn(request.signal, 'removeEventListener').mockImplementation(
        (type: string, listener: EventListener) => {
          stoppedAtTheEnd.push(request.signal.aborted);
          remove(type, listener);
        },
      );

      const failed = await enter(stubHost(), async () => {
        const pending = callOf(
          wrap(
            callable(async () => {
              throw failure;
            }),
          ),
        )({ messages: [] }, request.signal).catch((thrown: unknown) => thrown);
        for (let tick = 0; tick < ticks; tick += 1) await Promise.resolve();
        request.abort();
        return pending;
      });

      expect(failed instanceof Aborted ? failed.cause : failed).toBe(failure);
      expect(failed instanceof Aborted).toBe(stoppedAtTheEnd.at(-1) ?? true);
      outcomes.add(failed instanceof Aborted ? 'stopped' : 'failed');
    }

    expect(outcomes).toEqual(new Set(['stopped', 'failed']));
  }
});

test('race’s stream reports done once returned, though its winner’s iterator would go on', async () => {
  const log: string[] = [];
  const signals: AbortSignal[] = [];

  const read = await enter(stubHost(), async () => {
    const stream = await callOf(
      race(
        callable(async (_prompt, signal) => {
          signals.push(signal);
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                log.push('next');
                return {
                  done: false,
                  value: { type: 'text' as const, text: 'More' },
                };
              },
              return: async () => {
                log.push('return');
                return {
                  done: false,
                  value: { type: 'text' as const, text: 'More' },
                };
              },
            }),
          };
        }),
      ),
    )({ messages: [] }, current().signal);
    const reader = stream[Symbol.asyncIterator]();
    return [
      await reader.next(),
      await reader.return?.(),
      await reader.next(),
      await reader.return?.(),
      await reader.next(),
    ];
  });

  expect(read).toEqual([
    { done: false, value: { type: 'text', text: 'More' } },
    { done: true, value: undefined },
    { done: true, value: undefined },
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  expect(log).toEqual(['next', 'return']);
  expect(signals.map((signal) => signal.aborted)).toEqual([true]);
});

test('accepted: fallback throws its last model’s failure and race its first-listed model’s, neither chained to the others', async () => {
  const first = new Overloaded('Busy');
  const last = new Blocked('Refused');

  const [fellBack, raced] = await enter(stubHost(), async () => [
    await fallback(
      callable(async () => {
        throw first;
      }),
      callable(async () => {
        throw last;
      }),
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown),
    await race(
      callable(async () => {
        await Bun.sleep(2);
        throw first;
      }),
      callable(async () => {
        throw last;
      }),
    )
      .complete({ messages: [] })
      .catch((thrown: unknown) => thrown),
  ]);

  expect(fellBack).toBe(last);
  expect(raced).toBe(first);
  expect(fellBack).not.toHaveProperty('cause');
  expect(raced).not.toHaveProperty('cause');
});

test('the call that won a race and ended by itself is not stopped afterwards, while the loser is', async () => {
  const stopped: [string, boolean][] = [];
  const signals: [string, AbortSignal][] = [];
  const host = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });

  const text = await enter(
    {
      ...host,
      models: (name, prompt, signal) => {
        signals.push([name, signal]);
        signal.addEventListener('abort', () => stopped.push([name, true]));
        return name === 'acme/slow'
          ? {
              [Symbol.asyncIterator]: () => ({
                next: () => new Promise(() => {}),
              }),
            }
          : host.models(name, prompt, signal);
      },
    },
    async () => {
      const reply = await race(model('acme/slow'), model('acme/fast')).complete(
        { messages: [] },
      );
      const read = await reply.text();
      await endPhase();
      return read;
    },
  );

  expect(text).toBe('Fast');
  expect(stopped).toEqual([['acme/slow', true]]);
  expect(signals.map(([name, signal]) => [name, signal.aborted])).toEqual([
    ['acme/slow', true],
    ['acme/fast', false],
  ]);
});

test('an answer through fallback names the model that answered', async () => {
  const host = stubHost({
    'acme/second': [
      { type: 'text', text: 'Second' },
      { type: 'finish', reason: 'stop' },
    ],
  });

  const name = await enter(host, async () => {
    const reply = await fallback(
      model('acme/first'),
      model('acme/second'),
    ).complete({ messages: [] });
    return reply.model();
  });

  expect(name).toBe('acme/second');
});

test('an answer through race names the model that won', async () => {
  const host = stubHost({
    'acme/slow': [
      { type: 'text', text: 'Slow' },
      { type: 'finish', reason: 'stop' },
    ],
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop' },
    ],
  });

  const name = await enter(host, async () => {
    const reply = await race(
      held(model('acme/slow'), 50),
      model('acme/fast'),
    ).complete({ messages: [] });
    return reply.model();
  });

  expect(name).toBe('acme/fast');
});

test('an answer through retry names the model that answered after its first failure', async () => {
  let tries = 0;
  const host = {
    ...stubHost(),
    models: async function* (): AsyncGenerator<StreamEvent> {
      tries += 1;
      if (tries === 1) {
        yield {
          type: 'error',
          error: {
            code: 'overloaded',
            status: 503,
            message: 'Try later',
            retryable: true,
            retryAfterMs: 0,
          },
        };
        return;
      }
      yield { type: 'text', text: 'Hello' };
      yield { type: 'finish', reason: 'stop' };
    },
  };

  const name = await enter(host, async () => {
    const reply = await retry(model('acme/small'), 1).complete({
      messages: [],
    });
    return reply.model();
  });

  expect([name, tries]).toEqual(['acme/small', 2]);
});
