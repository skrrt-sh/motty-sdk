import { afterEach, expect, jest, spyOn, test } from 'bun:test';
import { Aborted, Blocked, Overloaded } from '../../src/data/errors.ts';
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
    (inner: Model) => timeout(inner, { stall: 1000 }),
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
    (inner: Model) => timeout(inner, { stall: 1000 }),
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
