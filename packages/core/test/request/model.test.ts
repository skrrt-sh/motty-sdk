import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import type { AnyMotty } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { contractOf } from '../../src/chain/run.ts';
import type {
  EventStream,
  Host,
  ModelCall,
  RequestRecord,
} from '../../src/contract.ts';
import {
  Aborted,
  fromFacts,
  LimitReached,
  MottyError,
  Overloaded,
  RateLimited,
  TimedOut,
  toFacts,
  UnknownModel,
  Unsupported,
} from '../../src/data/errors.ts';
import type { StreamEvent } from '../../src/data/event.ts';
import type { ChatRequest } from '../../src/data/message.ts';
import { answer } from '../../src/request/answer.ts';
import {
  beginAfterResponse,
  current,
  endPhase,
  enter,
} from '../../src/request/context.ts';
import { callable, callOf, model } from '../../src/request/model.ts';
import { race } from '../../src/request/switching.ts';
import { timeout } from '../../src/request/timeout.ts';
import { stubHost } from '../stub-host.ts';

function asked() {
  return callOf(model('acme/small'))({ messages: [] }, current().signal);
}

function ask(): ChatRequest {
  return {
    id: 'req_1',
    model: 'motty/coder',
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [],
    options: {},
    headers: new Headers(),
  };
}

async function told(served: AnyMotty, host: Host) {
  const seen = [];
  for await (const event of contractOf(served).run(ask(), host)) {
    seen.push(event);
  }
  return seen;
}

afterEach(() => {
  mock.restore();
});

// The listeners the core holds on its own signals. The one by which a
// request follows the signal of its host is held until its phase ends, and
// is counted where a test is about that.
function listening(host: AbortSignal) {
  const added = spyOn(AbortSignal.prototype, 'addEventListener');
  const removed = spyOn(AbortSignal.prototype, 'removeEventListener');
  const from = [added.mock.calls.length, removed.mock.calls.length] as const;
  return () =>
    added.mock.calls.filter(
      ([, listener], at) =>
        at >= from[0] &&
        added.mock.contexts[at] !== host &&
        !removed.mock.calls.some(
          ([, gone], left) =>
            left >= from[1] &&
            gone === listener &&
            removed.mock.contexts[left] === added.mock.contexts[at],
        ),
    ).length;
}

function stalling(...events: StreamEvent[]) {
  let sent = 0;
  let closed = 0;
  const models: ModelCall = () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const event = events[sent];
        sent += 1;
        return event === undefined
          ? new Promise(() => {})
          : Promise.resolve({ done: false, value: event });
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
    }),
  });
  return { models, closed: () => closed };
}

test('a completed call resolves an answer with its text', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 3, output: 2, cached: 0, reasoning: 0 },
      },
    ],
  });

  const text = await enter(host, async () => {
    const reply = await model('acme/small').complete({
      messages: [{ role: 'user', text: 'Hi' }],
    });
    return reply.text();
  });

  expect(text).toBe('Hello');
});

test('the host receives the prompt that was sent', async () => {
  const host = stubHost({
    'acme/small': [
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1, output: 0, cached: 0, reasoning: 0 },
      },
    ],
  });

  await enter(host, () =>
    model('acme/small').complete({
      messages: [{ role: 'user', text: 'Hi' }],
      options: { temperature: 0, provider: { openai: { logprobs: true } } },
    }),
  );

  expect(host.sent('acme/small')).toEqual([
    {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { temperature: 0, provider: { openai: { logprobs: true } } },
    },
  ]);
});

test('usage and time land in calls and are summed over two calls', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'One' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 3, output: 2, cached: 1, reasoning: 0 },
      },
    ],
    'acme/large': [
      { type: 'text', text: 'Two' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 10, output: 20, cached: 0, reasoning: 5 },
      },
    ],
  });

  const calls = await enter(host, async () => {
    const one = await model('acme/small').complete({ messages: [] });
    await one.text();
    const two = await model('acme/large').complete({ messages: [] });
    await two.text();
    return current().calls;
  });

  expect(calls.made).toEqual([
    {
      model: 'acme/small',
      input: 3,
      output: 2,
      cached: 1,
      reasoning: 0,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
    },
    {
      model: 'acme/large',
      input: 10,
      output: 20,
      cached: 0,
      reasoning: 5,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
    },
  ]);
  expect(calls.total).toEqual({
    input: 13,
    output: 22,
    cached: 1,
    reasoning: 5,
  });
});

test('what a call left out is kept with the call, and a call that left nothing out says nothing', async () => {
  const records: RequestRecord[] = [];
  const warnings = [
    { setting: 'seed', detail: 'This API has no field for a seed' },
  ];
  const host = stubHost(
    {
      'acme/small': [
        { type: 'text', text: 'One' },
        { type: 'finish', reason: 'stop', warnings },
      ],
      'acme/large': [
        { type: 'text', text: 'Two' },
        { type: 'finish', reason: 'stop', warnings: [] },
      ],
    },
    { record: (record) => records.push(record) },
  );
  const seen: (readonly { setting: string }[] | undefined)[] = [];
  const served = motty({ name: 'coder' }).handle(async () => {
    await (await model('acme/small').complete({ messages: [] })).text();
    const last = await model('acme/large').complete({ messages: [] });
    await last.text();
    for (const call of current().calls.made) seen.push(call.warnings);
    return last;
  });

  await told(served, host);
  await Bun.sleep(0);

  expect(seen).toEqual([warnings, undefined]);
  expect(records[0]?.calls).toMatchObject([
    { model: 'acme/small', warnings },
    { model: 'acme/large' },
  ]);
  expect(records[0]?.calls[1]).not.toHaveProperty('warnings');
});

test('a call nobody reads is still counted', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Unread' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 4, output: 1, cached: 0, reasoning: 0 },
      },
    ],
  });

  const calls = await enter(host, async () => {
    await model('acme/small').complete({ messages: [] });
    await Bun.sleep(1);
    return current().calls;
  });

  expect(calls.total).toEqual({ input: 4, output: 1, cached: 0, reasoning: 0 });
});

test('a name the host cannot serve throws UnknownModel and is counted with no usage', async () => {
  const calls = await enter(stubHost(), async () => {
    const call = model('acme/missing').complete({ messages: [] });
    await expect(call).rejects.toBeInstanceOf(UnknownModel);
    return current().calls;
  });

  expect(calls.made).toEqual([
    {
      model: 'acme/missing',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'unknown_model',
      message: 'No model named acme/missing',
    },
  ]);
});

test('a model made by name carries that name, read-only by type', () => {
  const small = model('acme/small');

  expect(small.name).toBe('acme/small');
  // @ts-expect-error
  small.name = 'acme/large';
});

test('what a combinator returns has no name by type', () => {
  const either = race(model('acme/small'), model('acme/large'));

  // @ts-expect-error
  expect(either.name).toBeUndefined();
});

test('a name is resolved only when called', () => {
  expect(() => model('acme/missing')).not.toThrow();
});

test('a failure before the first chunk rejects complete with its class', async () => {
  const host = stubHost({
    'acme/small': [
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfter: 30,
        },
      },
    ],
  });

  await enter(host, async () => {
    const call = model('acme/small').complete({ messages: [] });
    await expect(call).rejects.toBeInstanceOf(RateLimited);
    await expect(call).rejects.toMatchObject({
      message: 'Slow down',
      retryAfter: 30,
    });
  });
});

test('a failure after the first chunk resolves and then fails on read', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Half' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Too busy' },
      },
    ],
  });

  const calls = await enter(host, async () => {
    const reply = await model('acme/small').complete({ messages: [] });
    await expect(reply.text()).rejects.toBeInstanceOf(Overloaded);
    return current().calls;
  });

  expect(calls.made).toEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'overloaded',
      message: 'Too busy',
    },
  ]);
});

test('the call past the limit throws LimitReached', async () => {
  const host = stubHost(
    {
      'acme/small': [
        {
          type: 'finish',
          reason: 'stop',
          usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
        },
      ],
    },
    { limits: { calls: 1 } },
  );

  await enter(host, async () => {
    await model('acme/small').complete({ messages: [] });
    await expect(
      model('acme/small').complete({ messages: [] }),
    ).rejects.toBeInstanceOf(LimitReached);
  });

  expect(host.sent('acme/small')).toHaveLength(1);
});

test('an already stopped request throws Aborted and the host is not asked', async () => {
  const host = stubHost(
    {
      'acme/small': [
        {
          type: 'finish',
          reason: 'stop',
          usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
        },
      ],
    },
    { signal: AbortSignal.abort() },
  );

  const calls = await enter(host, async () => {
    await expect(
      model('acme/small').complete({ messages: [] }),
    ).rejects.toBeInstanceOf(Aborted);
    return current().calls;
  });

  expect(host.sent('acme/small')).toEqual([]);
  expect(calls.made).toEqual([]);
});

test('the call behind a callable model is the one it was given', async () => {
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

  const [text, events] = await enter(host, async () => {
    const made = callable(async (prompt, signal) =>
      host.models('acme/small', prompt, signal),
    );
    const reply = await made.complete({ messages: [] });
    const stream = await callOf(made)({ messages: [] }, current().signal);
    return [await reply.text(), await Array.fromAsync(stream)];
  });

  expect(text).toBe('Hello');
  expect(events).toEqual([
    { type: 'text', text: 'Hello' },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
    },
  ]);
  expect(host.sent('acme/small')).toHaveLength(2);
});

test('the call behind a named model reaches the host with the signal it is given', async () => {
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

  await enter(host, async () => {
    const call = callOf(model('acme/small'))(
      { messages: [] },
      AbortSignal.abort(),
    );
    await expect(call).rejects.toBeInstanceOf(Aborted);
  });

  expect(host.sent('acme/small')).toEqual([]);
});

test('complete outside a request throws', async () => {
  await expect(model('acme/small').complete({ messages: [] })).rejects.toThrow(
    'outside a request',
  );
});

test('a host that throws when asked rejects the call, which is counted', async () => {
  const outcome = await enter(
    {
      ...stubHost(),
      models: () => {
        throw new RangeError('No route to the upstream');
      },
    },
    async () => {
      const failure = await asked().catch((thrown: unknown) => thrown);
      return { failure, calls: current().calls };
    },
  );

  expect(outcome.failure).toBeInstanceOf(MottyError);
  expect(outcome.failure).not.toHaveProperty('cause');
  expect(outcome.failure).toMatchObject({
    code: 'internal',
    retryable: false,
    unexpected: true,
    message: 'The model call to acme/small failed',
    upstream: true,
  });
  expect(outcome.calls.made).toEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number) },
      code: 'internal',
      message: 'The model call to acme/small failed',
    },
  ]);
});

test('a call resolves at its first event with a stream that still includes it', async () => {
  const gate = Promise.withResolvers<void>();
  const outcome = await enter(
    {
      ...stubHost(),
      models: async function* () {
        yield { type: 'text', text: 'Hel' };
        await gate.promise;
        yield { type: 'text', text: 'lo' };
        yield {
          type: 'finish',
          reason: 'stop',
          usage: { input: 3, output: 2 },
        };
      },
    },
    async () => {
      const stream = await asked();
      const before = current().calls.made.length;
      gate.resolve();
      return {
        before,
        events: await Array.fromAsync(stream),
        calls: current().calls,
      };
    },
  );

  expect(outcome.before).toBe(0);
  expect(outcome.events).toEqual([
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    { type: 'finish', reason: 'stop', usage: { input: 3, output: 2 } },
  ]);
  expect(outcome.calls.made).toEqual([
    {
      model: 'acme/small',
      input: 3,
      output: 2,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
    },
  ]);
  expect(outcome.calls.total).toEqual({ input: 3, output: 2 });
});

test('a call whose first event is the finish is counted before anyone reads it', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'finish', reason: 'stop', usage: { input: 4, output: 0 } },
    ],
  });

  const outcome = await enter(host, async () => {
    const stream = await asked();
    const unread = current().calls.made.length;
    return { unread, events: await Array.fromAsync(stream) };
  });

  expect(outcome.unread).toBe(1);
  expect(outcome.events).toEqual([
    { type: 'finish', reason: 'stop', usage: { input: 4, output: 0 } },
  ]);
});

test('returning a stream that holds only the finish keeps the finish usage', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'finish', reason: 'stop', usage: { input: 4, output: 0 } },
    ],
  });

  const calls = await enter(host, async () => {
    const reader = (await asked())[Symbol.asyncIterator]();
    await reader.return?.();
    expect(await reader.next()).toEqual({ done: true, value: undefined });
    return current().calls;
  });

  expect(calls.made).toHaveLength(1);
  expect(calls.total).toEqual({ input: 4, output: 0 });
});

test('a failure before the first chunk is counted with the usage it reports', async () => {
  const host = stubHost({
    'acme/small': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Too busy' },
        usage: { input: 7, output: 0, cached: 2 },
      },
    ],
  });

  const calls = await enter(host, async () => {
    await expect(asked()).rejects.toBeInstanceOf(Overloaded);
    return current().calls;
  });

  expect(calls.made).toEqual([
    {
      model: 'acme/small',
      input: 7,
      output: 0,
      cached: 2,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'overloaded',
      message: 'Too busy',
    },
  ]);
});

test('a source that ends before any event rejects the call, which is counted', async () => {
  const outcome = await enter(
    { ...stubHost(), models: async function* () {} },
    async () => {
      const failure = await asked().catch((thrown: unknown) => thrown);
      return { failure, calls: current().calls };
    },
  );

  expect(outcome.failure).toBeInstanceOf(MottyError);
  expect(outcome.failure).toMatchObject({
    message: 'The stream ended without a finish or an error',
  });
  expect(outcome.calls.made).toEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number) },
      code: 'internal',
      message: 'The stream ended without a finish or an error',
    },
  ]);
});

test('a source that throws before any event rejects with a core error naming the model and nothing thrown, marked as the host’s', async () => {
  const outcome = await enter(
    {
      ...stubHost(),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new RangeError('The socket closed');
          },
        }),
      }),
    },
    async () => {
      const failure = await asked().catch((thrown: unknown) => thrown);
      return { failure, calls: current().calls };
    },
  );

  expect(outcome.failure).toBeInstanceOf(MottyError);
  expect(outcome.failure).not.toHaveProperty('cause');
  expect(outcome.failure).toMatchObject({
    code: 'internal',
    message: 'The model call to acme/small failed',
    upstream: true,
  });
  expect(outcome.calls.made).toHaveLength(1);
});

test('a core error a source throws before any event rejects the call with its class and facts, marked as the host’s', async () => {
  await enter(
    {
      ...stubHost(),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new RateLimited('Slow down', { retryAfter: 30 });
          },
        }),
      }),
    },
    async () => {
      const call = asked();
      await expect(call).rejects.toBeInstanceOf(RateLimited);
      await expect(call).rejects.toMatchObject({
        message: 'Slow down',
        retryAfter: 30,
        upstream: true,
      });
    },
  );
});

test('a signal that fires while waiting rejects with Aborted, counts the call and closes a host that ignores it', async () => {
  const stop = new AbortController();
  let closed = 0;
  const calls = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise(() => {}),
          return: async () => {
            closed += 1;
            return { done: true, value: undefined };
          },
        }),
      }),
    },
    async () => {
      const call = asked();
      stop.abort();
      await expect(call).rejects.toBeInstanceOf(Aborted);
      return current().calls;
    },
  );

  expect(closed).toBe(1);
  expect(calls.made).toEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number) },
      code: 'aborted',
      message: 'The work was stopped',
    },
  ]);
});

test('a first event that arrives after the call was stopped is dropped and the call counted once', async () => {
  const stop = new AbortController();
  const gate = Promise.withResolvers<void>();
  let closed = false;
  const calls = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: async function* () {
        try {
          await gate.promise;
          yield {
            type: 'finish',
            reason: 'stop',
            usage: { input: 9, output: 9 },
          };
        } finally {
          closed = true;
        }
      },
    },
    async () => {
      const call = asked();
      stop.abort();
      await expect(call).rejects.toBeInstanceOf(Aborted);
      gate.resolve();
      await Bun.sleep(1);
      return current().calls;
    },
  );

  expect(closed).toBe(true);
  expect(calls.made).toHaveLength(1);
  expect(calls.total).toEqual({});
});

test('a source that fails after the first chunk is counted with the usage its error reports', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Half' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Too busy' },
        usage: { input: 7, output: 1 },
      },
    ],
  });

  const outcome = await enter(host, async () => ({
    events: await Array.fromAsync(await asked()),
    calls: current().calls,
  }));

  expect(outcome.events).toEqual([
    { type: 'text', text: 'Half' },
    {
      type: 'error',
      error: {
        code: 'overloaded',
        status: 503,
        message: 'Too busy',
        upstream: true,
      },
      usage: { input: 7, output: 1 },
    },
  ]);
  expect(outcome.calls.made).toHaveLength(1);
  expect(outcome.calls.total).toEqual({ input: 7, output: 1 });
});

test('a source that throws mid-stream ends the stream with an error event and is counted', async () => {
  const outcome = await enter(
    {
      ...stubHost(),
      models: async function* () {
        yield { type: 'text', text: 'Half' };
        throw new RangeError('The socket closed');
      },
    },
    async () => ({
      events: await Array.fromAsync(await asked()),
      calls: current().calls,
    }),
  );

  expect(outcome.events).toEqual([
    { type: 'text', text: 'Half' },
    {
      type: 'error',
      error: {
        code: 'internal',
        status: 500,
        message: 'The model call to acme/small failed',
        retryable: false,
        upstream: true,
        unexpected: true,
      },
    },
  ]);
  expect(outcome.calls.made).toHaveLength(1);
});

test('a core error a source throws mid-stream keeps its facts in the error event, marked as the host’s', async () => {
  const events = await enter(
    {
      ...stubHost(),
      models: async function* () {
        yield { type: 'text', text: 'Half' };
        throw new Overloaded('Too busy', { retryAfter: 30 });
      },
    },
    async () => Array.fromAsync(await asked()),
  );

  expect(events).toEqual([
    { type: 'text', text: 'Half' },
    {
      type: 'error',
      error: {
        code: 'overloaded',
        status: 503,
        message: 'Too busy',
        retryable: true,
        retryAfter: 30,
        upstream: true,
      },
    },
  ]);
});

test('a source that ends without a terminal ends the stream with an error event and is counted', async () => {
  const outcome = await enter(
    {
      ...stubHost(),
      models: async function* () {
        yield { type: 'text', text: 'Half' };
      },
    },
    async () => ({
      events: await Array.fromAsync(await asked()),
      calls: current().calls,
    }),
  );

  expect(outcome.events).toEqual([
    { type: 'text', text: 'Half' },
    {
      type: 'error',
      error: {
        code: 'internal',
        status: 500,
        message: 'The stream ended without a finish or an error',
        retryable: false,
      },
    },
  ]);
  expect(outcome.calls.made).toHaveLength(1);
});

test('what a source sends after its terminal is not passed on, and the source is closed', async () => {
  let closed = false;
  const outcome = await enter(
    {
      ...stubHost(),
      models: async function* () {
        try {
          yield { type: 'text', text: 'Whole' };
          yield {
            type: 'finish',
            reason: 'stop',
            usage: { input: 3, output: 2 },
          };
          yield { type: 'text', text: 'Too late' };
          yield {
            type: 'finish',
            reason: 'stop',
            usage: { input: 9, output: 9 },
          };
        } finally {
          closed = true;
        }
      },
    },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      const events = [await reader.next(), await reader.next()];
      const closedAtTheTerminal = closed;
      return {
        events,
        closedAtTheTerminal,
        after: [await reader.next(), await reader.next()],
        calls: current().calls,
      };
    },
  );

  expect(outcome.events).toEqual([
    { done: false, value: { type: 'text', text: 'Whole' } },
    {
      done: false,
      value: { type: 'finish', reason: 'stop', usage: { input: 3, output: 2 } },
    },
  ]);
  expect(outcome.closedAtTheTerminal).toBe(true);
  expect(outcome.after).toEqual([
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  expect(outcome.calls.made).toHaveLength(1);
  expect(outcome.calls.total).toEqual({ input: 3, output: 2 });
});

test('a consumer that returns the stream before reading counts the call and closes the source', async () => {
  let closed = false;
  const calls = await enter(
    {
      ...stubHost(),
      models: async function* () {
        try {
          yield { type: 'text', text: 'Unread' };
          yield {
            type: 'finish',
            reason: 'stop',
            usage: { input: 3, output: 2 },
          };
        } finally {
          closed = true;
        }
      },
    },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      expect(await reader.return?.()).toEqual({ done: true, value: undefined });
      expect(await reader.next()).toEqual({ done: true, value: undefined });
      return current().calls;
    },
  );

  expect(closed).toBe(true);
  expect(calls.made).toEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'aborted',
      message: 'The call was given up',
    },
  ]);
});

test('a consumer that stops after reading some counts the call and closes the source', async () => {
  let closed = false;
  const calls = await enter(
    {
      ...stubHost(),
      models: async function* () {
        try {
          yield { type: 'text', text: 'One' };
          yield { type: 'text', text: 'Two' };
          yield {
            type: 'finish',
            reason: 'stop',
            usage: { input: 3, output: 2 },
          };
        } finally {
          closed = true;
        }
      },
    },
    async () => {
      for await (const event of await asked()) {
        if (event.type === 'text' && event.text === 'Two') break;
      }
      return current().calls;
    },
  );

  expect(closed).toBe(true);
  expect(calls.made).toHaveLength(1);
  expect(calls.total).toEqual({});
});

test('a return issued while a read is pending ends that read and drops the terminal that arrives later, with its usage', async () => {
  const gate = Promise.withResolvers<void>();
  const calls = await enter(
    {
      ...stubHost(),
      models: async function* () {
        yield { type: 'text', text: 'One' };
        await gate.promise;
        yield {
          type: 'finish',
          reason: 'stop',
          usage: { input: 9, output: 9 },
        };
      },
    },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      await reader.next();
      const waiting = reader.next();
      await reader.return?.();
      gate.resolve();
      expect(await waiting).toEqual({ done: true, value: undefined });
      return current().calls;
    },
  );

  expect(calls.made).toHaveLength(1);
  expect(calls.total).toEqual({});
});

test('returning an ended stream changes nothing', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Whole' },
      { type: 'finish', reason: 'stop', usage: { input: 3, output: 2 } },
    ],
  });

  const calls = await enter(host, async () => {
    const reader = (await asked())[Symbol.asyncIterator]();
    await reader.next();
    await reader.next();
    expect(await reader.return?.()).toEqual({ done: true, value: undefined });
    expect(await reader.return?.()).toEqual({ done: true, value: undefined });
    return current().calls;
  });

  expect(calls.made).toHaveLength(1);
  expect(calls.total).toEqual({ input: 3, output: 2 });
});

test('a signal that fires while a read waits on a silent host ends that read with one aborted terminal', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const silent = stalling({ type: 'text', text: 'Half' });
  const outcome = await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      const first = await reader.next();
      const waiting = reader.next();
      const before = [current().calls.made.length, silent.closed(), live()];
      stop.abort();
      return {
        first,
        before,
        after: [await waiting, await reader.next(), await reader.next()],
        calls: current().calls,
      };
    },
  );

  expect(outcome.first).toEqual({
    done: false,
    value: { type: 'text', text: 'Half' },
  });
  expect(outcome.before).toEqual([0, 0, 0]);
  expect(outcome.after).toEqual([
    {
      done: false,
      value: {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'The work was stopped',
          retryable: false,
        },
      },
    },
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  expect(outcome.calls.made).toEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'aborted',
      message: 'The work was stopped',
    },
  ]);
  expect(silent.closed()).toBe(1);
}, 1_000);

test('a signal that fires while the stream is held unread ends the first read with the aborted terminal, the call counted and its source closed by then', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const silent = stalling({ type: 'text', text: 'Unread' });
  const outcome = await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      stop.abort();
      const read = await reader.next();
      return {
        counted: [current().calls.made.length, silent.closed(), live()],
        after: [read, await reader.next()],
      };
    },
  );

  expect(outcome.counted).toEqual([1, 1, 0]);
  expect(outcome.after).toEqual([
    {
      done: false,
      value: {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'The work was stopped',
          retryable: false,
        },
      },
    },
    { done: true, value: undefined },
  ]);
  expect(silent.closed()).toBe(1);
}, 1_000);

test('a signal that fires between reads ends the next read with the aborted terminal, the call counted and its source closed by then', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const silent = stalling({ type: 'text', text: 'Half' });
  const outcome = await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      await reader.next();
      stop.abort();
      const read = await reader.next();
      return {
        counted: [current().calls.made.length, silent.closed(), live()],
        after: [read, await reader.next()],
      };
    },
  );

  expect(outcome.counted).toEqual([1, 1, 0]);
  expect(outcome.after).toEqual([
    {
      done: false,
      value: {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'The work was stopped',
          retryable: false,
        },
      },
    },
    { done: true, value: undefined },
  ]);
  expect(silent.closed()).toBe(1);
}, 1_000);

test('a stream stopped while held and then returned ends without its terminal or a second close', async () => {
  const stop = new AbortController();
  const silent = stalling({ type: 'text', text: 'Unread' });
  const calls = await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      stop.abort();
      expect(await reader.return?.()).toEqual({ done: true, value: undefined });
      expect(await reader.next()).toEqual({ done: true, value: undefined });
      return current().calls;
    },
  );

  expect(calls.made).toHaveLength(1);
  expect(silent.closed()).toBe(1);
}, 1_000);

test('a terminal the host sent before the signal fired stays the only one', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const silent = stalling(
    { type: 'text', text: 'Half' },
    {
      type: 'error',
      error: { code: 'aborted', status: 499, message: 'The host stopped it' },
      usage: { input: 7, output: 1 },
    },
  );
  const outcome = await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      const events = [await reader.next(), await reader.next()];
      const atTheTerminal = live();
      stop.abort();
      return {
        events,
        atTheTerminal,
        after: await reader.next(),
        calls: current().calls,
      };
    },
  );

  expect(outcome.events[1]).toEqual({
    done: false,
    value: {
      type: 'error',
      error: {
        code: 'aborted',
        status: 499,
        message: 'The host stopped it',
        upstream: true,
      },
      usage: { input: 7, output: 1 },
    },
  });
  expect(outcome.atTheTerminal).toBe(0);
  expect(outcome.after).toEqual({ done: true, value: undefined });
  expect(outcome.calls.made).toHaveLength(1);
  expect(outcome.calls.total).toEqual({ input: 7, output: 1 });
  expect(silent.closed()).toBe(1);
}, 1_000);

test('a signal that fires while only the finish is held leaves the finish to be read', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const silent = stalling({
    type: 'finish',
    reason: 'stop',
    usage: { input: 4, output: 0 },
  });
  const outcome = await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      const stream = await asked();
      const held = live();
      stop.abort();
      return {
        held,
        events: await Array.fromAsync(stream),
        calls: current().calls,
      };
    },
  );

  expect(outcome.held).toBe(0);
  expect(outcome.events).toEqual([
    { type: 'finish', reason: 'stop', usage: { input: 4, output: 0 } },
  ]);
  expect(outcome.calls.total).toEqual({ input: 4, output: 0 });
  expect(silent.closed()).toBe(1);
}, 1_000);

test('a terminal that arrives once the signal has fired ends the call as stopped, and the usage it reported is counted', async () => {
  const stop = new AbortController();
  const host = stubHost(
    {
      'acme/small': [
        { type: 'text', text: 'One' },
        { type: 'finish', reason: 'stop', usage: { input: 3, output: 2 } },
      ],
    },
    { signal: stop.signal },
  );

  const outcome = await enter(host, async () => {
    const reader = (await asked())[Symbol.asyncIterator]();
    await reader.next();
    const waiting = reader.next();
    stop.abort();
    return {
      after: [await waiting, await reader.next()],
      calls: current().calls,
    };
  });

  expect(outcome.after).toEqual([
    {
      done: false,
      value: {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'The work was stopped',
          retryable: false,
        },
        usage: { input: 3, output: 2 },
      },
    },
    { done: true, value: undefined },
  ]);
  expect(outcome.calls.made).toEqual([
    {
      model: 'acme/small',
      input: 3,
      output: 2,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'aborted',
      message: 'The work was stopped',
    },
  ]);
}, 1_000);

test('a first event the core has not seen when the signal fires is dropped for the stop: the call rejects with Aborted and leaves no listener', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  let closed = 0;
  const calls = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const arriving = Promise.resolve({
              done: false,
              value: { type: 'text', text: 'Half' },
            } as const);
            arriving.then(() => stop.abort());
            return arriving;
          },
          return: async () => {
            closed += 1;
            return { done: true, value: undefined };
          },
        }),
      }),
    },
    async () => {
      await expect(asked()).rejects.toBeInstanceOf(Aborted);
      return current().calls;
    },
  );

  expect(calls.made).toEqual([
    {
      model: 'acme/small',
      time: { total: expect.any(Number) },
      code: 'aborted',
      message: 'The work was stopped',
    },
  ]);
  expect(closed).toBe(1);
  expect(live()).toBe(0);
}, 1_000);

test.each([
  [
    'a finish read to the end',
    [
      { type: 'text', text: 'Whole' },
      { type: 'finish', reason: 'stop' },
    ],
  ],
  [
    'an error read to the end',
    [
      { type: 'text', text: 'Half' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Too busy' },
      },
    ],
  ],
  ['a source cut short', [{ type: 'text', text: 'Half' }]],
  ['a finish as the first event', [{ type: 'finish', reason: 'stop' }]],
  [
    'an error as the first event',
    [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Too busy' },
      },
    ],
  ],
  ['a source with no event', []],
] as const)(
  '%s holds no listener on any signal, while it runs or after',
  async (_name, events) => {
    const stop = new AbortController();
    const live = listening(stop.signal);
    await enter(
      {
        ...stubHost({}, { signal: stop.signal }),
        models: async function* () {
          yield* events;
        },
      },
      async () => {
        const call = asked();
        expect(live()).toBe(0);
        await call.then(
          (stream) => Array.fromAsync(stream),
          () => {},
        );
      },
    );

    expect(live()).toBe(0);
  },
);

test('a consumer that returns the stream closes its source, and no listener was put on the signal of the host', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const silent = stalling(
    { type: 'text', text: 'One' },
    { type: 'text', text: 'Two' },
  );
  await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      const held = (await asked())[Symbol.asyncIterator]();
      const streaming = (await asked())[Symbol.asyncIterator]();
      await streaming.next();
      await held.return?.();
      expect(silent.closed()).toBe(1);
      await streaming.return?.();
    },
  );

  expect(live()).toBe(0);
  expect(silent.closed()).toBe(2);
});

test('a source that fails before its first event leaves no listener on the signal', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            throw new RangeError('The socket closed');
          },
        }),
      }),
    },
    async () => {
      await expect(asked()).rejects.toMatchObject({
        code: 'internal',
        message: 'The model call to acme/small failed',
      });
    },
  );

  expect(live()).toBe(0);
});

test('a host that rejects its read with the reason of the signal ends the stream as aborted, its listener first', async () => {
  const stop = new AbortController();
  const events = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: (_model, _prompt, signal) => {
        const cancelled = Promise.withResolvers<never>();
        signal.addEventListener('abort', () => cancelled.reject(signal.reason));
        let sent = false;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (sent) return cancelled.promise;
              sent = true;
              return Promise.resolve({
                done: false,
                value: { type: 'text', text: 'Half' },
              });
            },
          }),
        };
      },
    },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      await reader.next();
      const waiting = reader.next();
      stop.abort();
      return [await waiting, await reader.next()];
    },
  );

  expect(events).toEqual([
    {
      done: false,
      value: {
        type: 'error',
        error: {
          code: 'aborted',
          status: 499,
          message: 'The work was stopped',
          retryable: false,
        },
      },
    },
    { done: true, value: undefined },
  ]);
}, 1_000);

test('a host that rejects its read with the reason of the signal ends the stream as aborted, its listener last', async () => {
  const stop = new AbortController();
  const events = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: (_model, _prompt, signal) => {
        let sent = false;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => {
              if (sent) {
                return new Promise((_resolve, reject) => {
                  signal.addEventListener('abort', () => reject(signal.reason));
                });
              }
              sent = true;
              return Promise.resolve({
                done: false,
                value: { type: 'text', text: 'Half' },
              });
            },
          }),
        };
      },
    },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      await reader.next();
      const waiting = reader.next();
      stop.abort();
      return [await waiting, await reader.next()];
    },
  );

  expect(events).toEqual([
    { done: false, value: expect.objectContaining({ type: 'error' }) },
    { done: true, value: undefined },
  ]);
  expect(events[0]?.value).toHaveProperty('error.code', 'aborted');
}, 1_000);

test.each(['AbortError', 'TimeoutError'])(
  'a platform %s a source throws mid-stream, its signal not fired, is a failure of the call and no stop',
  async (name) => {
    const events = await enter(
      {
        ...stubHost(),
        models: async function* () {
          yield { type: 'text', text: 'Half' };
          throw new DOMException('The fetch of sk-live was interrupted', name);
        },
      },
      async () => Array.fromAsync(await asked()),
    );

    expect(events[1]).toEqual({
      type: 'error',
      error: {
        code: 'internal',
        status: 500,
        message: 'The model call to acme/small failed',
        retryable: false,
        upstream: true,
        unexpected: true,
      },
    });
  },
);

test.each(['AbortError', 'TimeoutError'])(
  'a platform %s a source throws before any event, its signal not fired, rejects as a failure of the call and no stop',
  async (name) => {
    const outcome = await enter(
      {
        ...stubHost(),
        // biome-ignore lint/correctness/useYield: the source fails before it yields
        models: async function* () {
          throw new DOMException('The fetch of sk-live was interrupted', name);
        },
      },
      async () => ({
        failure: await asked().catch((thrown: unknown) => thrown),
        calls: current().calls,
      }),
    );

    expect(outcome.failure).not.toBeInstanceOf(Aborted);
    expect(outcome.failure).not.toBeInstanceOf(TimedOut);
    expect(outcome.failure).toMatchObject({
      code: 'internal',
      retryable: false,
      message: 'The model call to acme/small failed',
    });
    expect(outcome.calls.made).toHaveLength(1);
  },
);

test.each([
  ['a null result', 'null'],
  ['a result with no value', '{"done":false}'],
  ['a null event', '{"done":false,"value":null}'],
  ['a number', '{"done":false,"value":7}'],
  ['a string', '{"done":false,"value":"text"}'],
  ['an object with no type', '{"done":false,"value":{}}'],
  ['an array', '{"done":false,"value":[]}'],
  ['an object whose type is a number', '{"done":false,"value":{"type":7}}'],
  ['an object whose type is null', '{"done":false,"value":{"type":null}}'],
  ['an error with no facts', '{"done":false,"value":{"type":"error"}}'],
  [
    'an error with null facts',
    '{"done":false,"value":{"type":"error","error":null}}',
  ],
])(
  'a first event that is %s rejects with a core error, counted and closed',
  async (_name, result) => {
    const stop = new AbortController();
    const live = listening(stop.signal);
    let closed = 0;
    const outcome = await enter(
      {
        ...stubHost({}, { signal: stop.signal }),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => JSON.parse(result),
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        }),
      },
      async () => {
        const failure = await asked().catch((thrown: unknown) => thrown);
        return { failure, calls: current().calls };
      },
    );

    expect(outcome.failure).toBeInstanceOf(MottyError);
    expect(outcome.failure).toHaveProperty('code', 'internal');
    expect(outcome.calls.made).toHaveLength(1);
    expect(closed).toBe(1);
    expect(live()).toBe(0);
  },
);

test.each([
  ['a null result', 'null'],
  ['a result with no value', '{"done":false}'],
  ['a null event', '{"done":false,"value":null}'],
  ['a number', '{"done":false,"value":7}'],
  ['a string', '{"done":false,"value":"text"}'],
  ['an object with no type', '{"done":false,"value":{}}'],
  ['an array', '{"done":false,"value":[]}'],
  ['an object whose type is a number', '{"done":false,"value":{"type":7}}'],
  ['an object whose type is null', '{"done":false,"value":{"type":null}}'],
  ['an error with no facts', '{"done":false,"value":{"type":"error"}}'],
  [
    'an error with null facts',
    '{"done":false,"value":{"type":"error","error":null}}',
  ],
])(
  'mid-stream, %s ends the stream with an internal error event, counted and closed',
  async (_name, result) => {
    let closed = 0;
    let sent = 0;
    const outcome = await enter(
      {
        ...stubHost(),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              sent += 1;
              if (sent === 2) return JSON.parse(result);
              return sent === 1
                ? { done: false, value: { type: 'text', text: 'Half' } }
                : { done: true, value: undefined };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        }),
      },
      async () => ({
        events: await Array.fromAsync(await asked()),
        calls: current().calls,
      }),
    );

    expect(outcome.events).toEqual([
      { type: 'text', text: 'Half' },
      {
        type: 'error',
        error: {
          code: 'internal',
          status: 500,
          message: 'The host sent something that is not an event',
          retryable: false,
        },
      },
    ]);
    expect(outcome.calls.made).toHaveLength(1);
    expect(closed).toBe(1);
  },
);

test('a source whose read throws at once mid-stream ends the stream with an error event', async () => {
  let sent = false;
  const events = await enter(
    {
      ...stubHost(),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (sent) throw new RangeError('The socket closed');
            sent = true;
            return Promise.resolve({
              done: false,
              value: { type: 'text', text: 'Half' },
            });
          },
        }),
      }),
    },
    async () => Array.fromAsync(await asked()),
  );

  expect(events).toEqual([
    { type: 'text', text: 'Half' },
    {
      type: 'error',
      error: {
        code: 'internal',
        status: 500,
        message: 'The model call to acme/small failed',
        retryable: false,
        upstream: true,
        unexpected: true,
      },
    },
  ]);
});

test.each([
  ['rejects', { return: () => Promise.reject(new RangeError('Closed')) }],
  [
    'throws',
    {
      return: () => {
        throw new RangeError('Closed');
      },
    },
  ],
  ['is absent', {}],
])(
  'a host whose close %s still ends and counts the call',
  async (_name, closing) => {
    const outcome = await enter(
      {
        ...stubHost(),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({
              done: false,
              value: { type: 'text', text: 'Unread' },
            }),
            ...closing,
          }),
        }),
      },
      async () => {
        const reader = (await asked())[Symbol.asyncIterator]();
        const left = await reader.return?.();
        await Bun.sleep(1);
        return { left, calls: current().calls };
      },
    );

    expect(outcome.left).toEqual({ done: true, value: undefined });
    expect(outcome.calls.made).toHaveLength(1);
  },
);

test('returning a stream that holds only the finish does not close the source a second time', async () => {
  const silent = stalling({
    type: 'finish',
    reason: 'stop',
    usage: { input: 4, output: 0 },
  });
  const calls = await enter(
    { ...stubHost(), models: silent.models },
    async () => {
      const reader = (await asked())[Symbol.asyncIterator]();
      await reader.return?.();
      await reader.return?.();
      return current().calls;
    },
  );

  expect(silent.closed()).toBe(1);
  expect(calls.made).toHaveLength(1);
});

test('a call on a stopped signal takes no slot of the call limit', async () => {
  const host = stubHost(
    { 'acme/small': [{ type: 'finish', reason: 'stop' }] },
    { limits: { calls: 1 } },
  );

  const events = await enter(host, async () => {
    await expect(
      callOf(model('acme/small'))({ messages: [] }, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(Aborted);
    return Array.fromAsync(await asked());
  });

  expect(events).toEqual([{ type: 'finish', reason: 'stop' }]);
});

test('a stopped signal is told before a spent call limit', async () => {
  const host = stubHost({}, { limits: { calls: 0 } });

  await enter(host, async () => {
    await expect(
      callOf(model('acme/small'))({ messages: [] }, AbortSignal.abort()),
    ).rejects.toBeInstanceOf(Aborted);
  });
});

test('a stream read after enter returned still counts into its request', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Late' },
      { type: 'finish', reason: 'stop', usage: { input: 3, output: 2 } },
    ],
  });

  const held = await enter(host, async () => ({
    stream: await asked(),
    calls: current().calls,
  }));
  expect(held.calls.made).toEqual([]);

  await Array.fromAsync(held.stream);

  expect(held.calls.made).toHaveLength(1);
  expect(held.calls.total).toEqual({ input: 3, output: 2 });
});

test.each([
  ['its models function', true],
  ['the opening of its stream', false],
])(
  'a host that fires the signal inside %s and never answers rejects with Aborted, counted, closed and unheard',
  async (_name, atOnce) => {
    const stop = new AbortController();
    const live = listening(stop.signal);
    let closed = 0;
    let asked = 0;
    const outcome = await enter(
      {
        ...stubHost({}, { signal: stop.signal }),
        models: () => {
          if (atOnce) stop.abort();
          return {
            [Symbol.asyncIterator]: () => {
              stop.abort();
              return {
                next: () => {
                  asked += 1;
                  return new Promise(() => {});
                },
                return: async () => {
                  closed += 1;
                  return { done: true, value: undefined };
                },
              };
            },
          };
        },
      },
      async () => {
        const failure = await callOf(model('acme/small'))(
          { messages: [] },
          current().signal,
        ).catch((thrown: unknown) => thrown);
        return { failure, calls: current().calls };
      },
    );

    expect(outcome.failure).toBeInstanceOf(Aborted);
    expect(outcome.calls.made).toEqual([
      {
        model: 'acme/small',
        time: { total: expect.any(Number) },
        code: 'aborted',
        message: 'The work was stopped',
      },
    ]);
    expect(asked).toBe(0);
    expect(closed).toBe(1);
    expect(live()).toBe(0);
  },
  1_000,
);

test('a host that fires the signal inside its first read and never answers rejects with Aborted and leaves no listener', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const calls = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            stop.abort();
            return new Promise(() => {});
          },
        }),
      }),
    },
    async () => {
      await expect(asked()).rejects.toBeInstanceOf(Aborted);
      return current().calls;
    },
  );

  expect(calls.made).toHaveLength(1);
  expect(live()).toBe(0);
}, 1_000);

test('a reply is validated by the schema that was sent, though the prompt is given another right after the call', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: '{"city":"Oslo"}' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const prompt = {
    messages: [],
    output: {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value: { sent: value } }),
        jsonSchema: { output: () => ({ title: 'sent' }) },
      },
    },
  };

  const value = await enter(host, async () => {
    const call = model('acme/small').complete(prompt);
    prompt.output = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value: unknown) => ({ value: { sent: `late ${value}` } }),
        jsonSchema: { output: () => ({ title: 'late' }) },
      },
    };
    return (await call).json();
  });

  expect(value).toEqual({ sent: { city: 'Oslo' } });
  expect(host.sent('acme/small')).toEqual([
    { messages: [], output: { schema: { title: 'sent' } } },
  ]);
});

test('a finish that arrived as the first event wins over a signal that fires a microtask later', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  let closed = 0;
  const outcome = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const arriving = Promise.resolve({
              done: false,
              value: {
                type: 'finish',
                reason: 'stop',
                usage: { input: 4, output: 1 },
              },
            } as const);
            arriving.then(() => queueMicrotask(() => stop.abort()));
            return arriving;
          },
          return: async () => {
            closed += 1;
            return { done: true, value: undefined };
          },
        }),
      }),
    },
    async () => ({
      events: await Array.fromAsync(await asked()),
      fired: stop.signal.aborted,
      calls: current().calls,
    }),
  );

  expect(outcome.fired).toBe(true);
  expect(outcome.events).toEqual([
    { type: 'finish', reason: 'stop', usage: { input: 4, output: 1 } },
  ]);
  expect(outcome.calls.made).toEqual([
    {
      model: 'acme/small',
      input: 4,
      output: 1,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
    },
  ]);
  expect(closed).toBe(1);
  expect(live()).toBe(0);
}, 1_000);

test('an error that arrived as the first event wins over a signal that fires a microtask later, its usage counted', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const calls = await enter(
    {
      ...stubHost({}, { signal: stop.signal }),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const arriving = Promise.resolve({
              done: false,
              value: {
                type: 'error',
                error: { code: 'overloaded', status: 503, message: 'Too busy' },
                usage: { input: 7, output: 0 },
              },
            } as const);
            arriving.then(() => queueMicrotask(() => stop.abort()));
            return arriving;
          },
        }),
      }),
    },
    async () => {
      await expect(asked()).rejects.toBeInstanceOf(Overloaded);
      return current().calls;
    },
  );

  expect(stop.signal.aborted).toBe(true);
  expect(calls.total).toEqual({ input: 7, output: 0 });
  expect(live()).toBe(0);
}, 1_000);

test.each([
  ['empty', '{}'],
  ['an array', '[]'],
  ['text', '"Too busy"'],
  [
    'of the wrong types',
    '{"code":7,"status":"503","message":null,"retryable":"yes","retryAfter":"30","provider":[]}',
  ],
])(
  'a mid-stream error whose facts are %s is no event: the call fails there, and what it said of usage is not counted',
  async (_name, facts) => {
    let sent = 0;
    const outcome = await enter(
      {
        ...stubHost(),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              sent += 1;
              return sent === 1
                ? { done: false, value: { type: 'text', text: 'Half' } }
                : JSON.parse(
                    `{"done":false,"value":{"type":"error","error":${facts},"usage":{"input":7,"output":1}}}`,
                  );
            },
          }),
        }),
      },
      async () => ({
        events: await Array.fromAsync(await asked()),
        calls: current().calls,
      }),
    );

    expect(outcome.events).toStrictEqual([
      { type: 'text', text: 'Half' },
      {
        type: 'error',
        error: {
          code: 'internal',
          status: 500,
          message: 'The host sent something that is not an event',
          retryable: false,
        },
      },
    ]);
    expect(outcome.calls.total).toEqual({});
    expect(outcome.calls.made.map((call) => call.code)).toEqual(['internal']);
  },
);

test.each([
  [
    'sound but for a status that is text',
    '{"code":"overloaded","status":"503","message":"Too busy"}',
    { code: 'overloaded', status: 503, message: 'Too busy', retryable: true },
    Overloaded,
  ],
  [
    'of a code no class knows',
    '{"code":"teapot","status":418,"message":"Short and stout","retryAfter":30,"provider":{"acme":{"id":"e_1"}}}',
    {
      code: 'teapot',
      status: 418,
      message: 'Short and stout',
      retryAfter: 30,
      provider: { acme: { id: 'e_1' } },
      retryable: false,
    },
    MottyError,
  ],
])(
  'a mid-stream error whose facts are %s is handed on with the host’s facts and the mark of where it came from, its usage kept, and raised by its class where the answer is read',
  async (_name, facts, expected, raised) => {
    let sent = 0;
    const outcome = await enter(
      {
        ...stubHost(),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              sent += 1;
              return sent === 1
                ? { done: false, value: { type: 'text', text: 'Half' } }
                : JSON.parse(
                    `{"done":false,"value":{"type":"error","error":${facts},"usage":{"input":7,"output":1}}}`,
                  );
            },
          }),
        }),
      },
      async () => ({
        events: await Array.fromAsync(await asked()),
        calls: current().calls,
      }),
    );

    expect(outcome.events).toStrictEqual([
      { type: 'text', text: 'Half' },
      {
        type: 'error',
        error: { ...JSON.parse(facts), upstream: true },
        usage: { input: 7, output: 1 },
      },
    ]);
    expect(fromFacts(JSON.parse(facts))).toBeInstanceOf(raised);
    expect(fromFacts(JSON.parse(facts))).toMatchObject(expected);
    expect(outcome.calls.total).toEqual({ input: 7, output: 1 });
    expect(outcome.calls.made.map((call) => call.code)).toEqual([
      expected.code,
    ]);
  },
);

test('a first error whose facts are an array rejects with an internal core error', async () => {
  await enter(
    {
      ...stubHost(),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            JSON.parse('{"done":false,"value":{"type":"error","error":[]}}'),
        }),
      }),
    },
    async () => {
      await expect(asked()).rejects.toMatchObject({
        code: 'internal',
        status: 500,
        message: 'The host sent something that is not an event',
      });
    },
  );
});

test.each([
  ['a text chunk whose text is a number', '{"type":"text","text":7}'],
  ['a text chunk whose text is null', '{"type":"text","text":null}'],
  ['an event of a kind nobody knows', '{"type":"hologram"}'],
  ['progress', '{"type":"progress","piece":0,"text":"Forged"}'],
  ['a finish with a reason nobody knows', '{"type":"finish","reason":"bored"}'],
  ['a tool call with no id', '{"type":"tool_call","arguments":"{}"}'],
])(
  '%s from a host is no event: the call fails where it enters and nothing of it is handed on',
  async (_name, sent) => {
    let read = 0;
    const events = await enter(
      {
        ...stubHost(),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              read += 1;
              return read === 1
                ? { done: false, value: { type: 'text', text: 'Half' } }
                : { done: false, value: JSON.parse(sent) };
            },
          }),
        }),
      },
      async () => Array.fromAsync(await asked()),
    );

    expect(events).toStrictEqual([
      { type: 'text', text: 'Half' },
      {
        type: 'error',
        error: {
          code: 'internal',
          status: 500,
          message: 'The host sent something that is not an event',
          retryable: false,
        },
      },
    ]);
  },
);

test('a chunk is handed on as the very object the host sent, the data of its provider unchecked', async () => {
  const chunk = JSON.parse(
    '{"type":"text","text":"Half","provider":{"acme":{"logprobs":[0.5,null,{"deep":[]}]}}}',
  );
  let read = 0;
  const results = await enter(
    {
      ...stubHost(),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            read += 1;
            return {
              done: false,
              value: read === 1 ? chunk : { type: 'finish', reason: 'stop' },
            };
          },
        }),
      }),
    },
    async () => Array.fromAsync(await asked()),
  );

  expect(results[0]).toBe(chunk);
});

test('usage counts of the wrong type from a host are left out, and the rest of the finish is kept', async () => {
  const outcome = await enter(
    {
      ...stubHost(),
      models: async function* () {
        yield JSON.parse(
          '{"type":"finish","reason":"stop","id":"msg_1","usage":{"input":3,"output":"2","cached":-1,"reasoning":1.5}}',
        );
      },
    },
    async () => ({
      events: await Array.fromAsync(await asked()),
      calls: current().calls,
    }),
  );

  expect(outcome.events).toStrictEqual([
    { type: 'finish', reason: 'stop', id: 'msg_1', usage: { input: 3 } },
  ]);
  expect(outcome.calls.total).toStrictEqual({ input: 3 });
});

test.each([
  [
    'type',
    () => ({
      get type(): 'text' {
        throw new RangeError('Not ready');
      },
      text: 'Half',
    }),
  ],
  [
    'usage',
    () => ({
      type: 'finish' as const,
      reason: 'stop' as const,
      get usage(): { input: number } {
        throw new RangeError('Not ready');
      },
    }),
  ],
])(
  'a first event whose %s throws when read rejects with a core error naming the model and nothing thrown, counted, closed and unheard',
  async (_name, event) => {
    const stop = new AbortController();
    const live = listening(stop.signal);
    let closed = 0;
    const outcome = await enter(
      {
        ...stubHost({}, { signal: stop.signal }),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: false, value: event() }),
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        }),
      },
      async () => {
        const failure = await asked().catch((thrown: unknown) => thrown);
        return { failure, calls: current().calls };
      },
    );

    expect(outcome.failure).toBeInstanceOf(MottyError);
    expect(outcome.failure).not.toHaveProperty('cause');
    expect(outcome.failure).toMatchObject({
      code: 'internal',
      message: 'The model call to acme/small failed',
      upstream: true,
    });
    expect(outcome.calls.made).toHaveLength(1);
    expect(closed).toBe(1);
    expect(live()).toBe(0);
  },
  1_000,
);

test.each([
  [
    'type',
    () => ({
      get type(): 'text' {
        throw new RangeError('Not ready');
      },
      text: 'Half',
    }),
  ],
  [
    'usage',
    () => ({
      type: 'finish' as const,
      reason: 'stop' as const,
      get usage(): { input: number } {
        throw new RangeError('Not ready');
      },
    }),
  ],
])(
  'mid-stream, an event whose %s throws when read ends the stream with one internal error event, counted, closed and unheard',
  async (_name, event) => {
    const stop = new AbortController();
    const live = listening(stop.signal);
    let closed = 0;
    let sent = 0;
    const outcome = await enter(
      {
        ...stubHost({}, { signal: stop.signal }),
        models: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              sent += 1;
              return sent === 1
                ? { done: false, value: { type: 'text', text: 'Half' } }
                : { done: false, value: event() };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        }),
      },
      async () => {
        const reader = (await asked())[Symbol.asyncIterator]();
        return {
          results: [
            await reader.next(),
            await reader.next(),
            await reader.next(),
          ],
          calls: current().calls,
        };
      },
    );

    expect(outcome.results).toEqual([
      { done: false, value: { type: 'text', text: 'Half' } },
      {
        done: false,
        value: {
          type: 'error',
          error: {
            code: 'internal',
            status: 500,
            message: 'The model call to acme/small failed',
            retryable: false,
            upstream: true,
            unexpected: true,
          },
        },
      },
      { done: true, value: undefined },
    ]);
    expect(outcome.calls.made).toHaveLength(1);
    expect(outcome.calls.total).toEqual({});
    expect(closed).toBe(1);
    expect(live()).toBe(0);
  },
  1_000,
);

test('a host whose reads return plain results, not promises, is read the same, first event and after', async () => {
  let sent = 0;
  const outcome = await enter(
    {
      ...stubHost(),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          // @ts-expect-error an async iterator answers with a promise
          next: () => {
            sent += 1;
            if (sent === 1) {
              return { done: false, value: { type: 'text', text: 'One' } };
            }
            return sent === 2
              ? { done: false, value: { type: 'text', text: 'Two' } }
              : {
                  done: false,
                  value: {
                    type: 'finish',
                    reason: 'stop',
                    usage: { input: 3, output: 2 },
                  },
                };
          },
        }),
      }),
    },
    async () => ({
      events: await Array.fromAsync(await asked()),
      calls: current().calls,
    }),
  );

  expect(outcome.events).toEqual([
    { type: 'text', text: 'One' },
    { type: 'text', text: 'Two' },
    { type: 'finish', reason: 'stop', usage: { input: 3, output: 2 } },
  ]);
  expect(outcome.calls.total).toEqual({ input: 3, output: 2 });
}, 1_000);

test('a host whose first read returns a plain finish, not a promise, resolves the call with it', async () => {
  const outcome = await enter(
    {
      ...stubHost(),
      models: () => ({
        [Symbol.asyncIterator]: () => ({
          // @ts-expect-error an async iterator answers with a promise
          next: () => ({
            done: false,
            value: {
              type: 'finish',
              reason: 'stop',
              usage: { input: 4, output: 0 },
            },
          }),
        }),
      }),
    },
    async () => ({
      events: await Array.fromAsync(await asked()),
      calls: current().calls,
    }),
  );

  expect(outcome.events).toEqual([
    { type: 'finish', reason: 'stop', usage: { input: 4, output: 0 } },
  ]);
  expect(outcome.calls.total).toEqual({ input: 4, output: 0 });
}, 1_000);

test('a stream that is resolved but never read and never returned stays uncounted until the signal fires, then is counted and closed', async () => {
  const stop = new AbortController();
  const live = listening(stop.signal);
  const silent = stalling({ type: 'text', text: 'Unread' });
  const outcome = await enter(
    { ...stubHost({}, { signal: stop.signal }), models: silent.models },
    async () => {
      await asked();
      await Bun.sleep(1);
      const unread = [current().calls.made.length, silent.closed(), live()];
      stop.abort();
      await endPhase();
      return {
        unread,
        stopped: [current().calls.made.length, silent.closed(), live()],
      };
    },
  );

  expect(outcome.unread).toEqual([0, 0, 0]);
  expect(outcome.stopped).toEqual([1, 1, 0]);
});

test.each([
  [
    'throws it when asked',
    (): EventStream => {
      throw new RateLimited('Rate limit reached for acme');
    },
  ],
  [
    'throws it mid-stream',
    async function* (): EventStream {
      yield { type: 'text', text: 'Half' };
      throw new RateLimited('Rate limit reached for acme');
    },
  ],
])(
  'an SDK error from a host that %s reaches the caller in its own words, and the host whole',
  async (_name, models) => {
    const over = Promise.withResolvers<RequestRecord>();

    const events = await told(
      motty({ name: 'coder' }).handle(async ({ prompt }) => {
        const reply = await model('acme/small').complete(prompt);
        await reply.text();
        return reply;
      }),
      { ...stubHost({}, { record: over.resolve }), models },
    );

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Rate limit reached for acme',
          retryable: true,
        },
        usage: {},
      },
    ]);
    expect((await over.promise).error).toEqual({
      code: 'rate_limited',
      status: 429,
      message: 'Rate limit reached for acme',
      retryable: true,
      upstream: true,
    });
  },
);

test.each([
  [
    'throws it when asked',
    (): EventStream => {
      throw new TypeError('key sk-1 is not a function');
    },
    false,
  ],
  [
    'sends it as the facts of what it caught',
    async function* (): EventStream {
      yield {
        type: 'error',
        error: toFacts(new TypeError('key sk-1 is not a function')),
      };
    },
    true,
  ],
])(
  'a thrown value that is no SDK error, from a host that %s, reaches the caller as an internal error with no message of its own, and the record holds only what was sent as facts',
  async (_name, models, held) => {
    const over = Promise.withResolvers<RequestRecord>();

    const events = await told(
      motty({ name: 'coder' }).handle(({ prompt }) =>
        model('acme/small').complete(prompt),
      ),
      { ...stubHost({}, { record: over.resolve }), models },
    );

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'internal',
          status: 500,
          message: 'Internal error',
          retryable: false,
        },
        usage: {},
      },
    ]);
    expect(
      JSON.stringify((await over.promise).error).includes(
        'key sk-1 is not a function',
      ),
    ).toBe(held);
  },
);

function cancelled(
  how: 'returns quietly' | 'echoes an error' | 'ignores the signal',
) {
  return async function* (
    name: string,
    _prompt: unknown,
    signal: AbortSignal,
  ): EventStream {
    if (name === 'acme/fast') {
      yield { type: 'text', text: 'Hi' };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    if (how === 'ignores the signal') await new Promise(() => {});
    if (how === 'echoes an error') {
      yield {
        type: 'error',
        error: { code: 'overloaded', message: 'Stopped' },
        usage: { input: 7 },
      };
    }
  };
}

test.each([
  ['returns quietly', {}],
  ['echoes an error', { input: 7 }],
  ['ignores the signal', {}],
] as const)(
  'a cancelled call whose host %s is recorded as stopped, with only the usage it reported and no first event: a race loser, a call timed out and a call the host stopped alike',
  async (how, usage) => {
    const lost = Promise.withResolvers<RequestRecord>();
    const late = Promise.withResolvers<RequestRecord>();
    const stopped = Promise.withResolvers<RequestRecord>();
    const stop = new AbortController();
    const models = cancelled(how);

    await told(
      motty({ name: 'coder' }).handle(({ prompt }) =>
        race(model('acme/fast'), model('acme/slow')).complete(prompt),
      ),
      { ...stubHost({}, { record: lost.resolve }), models },
    );
    await told(
      motty({ name: 'coder' }).handle(async ({ prompt }) => {
        await timeout(model('acme/slow'), 1)
          .complete(prompt)
          .catch(() => {});
        return answer('Hi');
      }),
      { ...stubHost({}, { record: late.resolve }), models },
    );
    const reading = told(
      motty({ name: 'coder' }).handle(({ prompt }) =>
        model('acme/slow').complete(prompt),
      ),
      {
        ...stubHost({}, { signal: stop.signal, record: stopped.resolve }),
        models,
      },
    );
    await Bun.sleep(1);
    stop.abort(new TimedOut('The host gave the request two minutes'));
    await reading;

    const slow = {
      model: 'acme/slow',
      time: { total: expect.any(Number) },
      ...usage,
    };
    expect(
      (await lost.promise).calls.filter((call) => call.model === 'acme/slow'),
    ).toStrictEqual([
      { ...slow, code: 'aborted', message: 'The call was given up' },
    ]);
    expect((await late.promise).calls).toStrictEqual([
      { ...slow, code: 'aborted', message: 'The call was given up' },
    ]);
    expect((await stopped.promise).calls).toStrictEqual([
      {
        ...slow,
        code: 'timed_out',
        message: 'The host gave the request two minutes',
      },
    ]);
  },
  1_000,
);

test('a chunk that arrived before the call was cancelled is its first event, whatever its host does at the stop', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  await told(
    motty({ name: 'coder' }).handle(({ prompt }) => {
      model('acme/slow').complete(prompt);
      return answer('Hi');
    }),
    {
      ...stubHost({}, { record: over.resolve }),
      models: async function* (_name, _prompt, signal) {
        yield { type: 'text', text: 'Half' };
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve),
        );
        yield { type: 'finish', reason: 'stop', usage: { input: 3 } };
      },
    },
  );

  expect((await over.promise).calls).toStrictEqual([
    {
      model: 'acme/slow',
      input: 3,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
      code: 'aborted',
      message: 'The call was given up',
    },
  ]);
});

test('an answer names the model that was called, not the id its upstream gave', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop', model: 'acme/small-2026' },
    ],
  });

  const name = await enter(host, async () => {
    const reply = await model('acme/small').complete({ messages: [] });
    return reply.model();
  });

  expect(name).toBe('acme/small');
});

test('an answer that failed after its first chunk names the model that failed', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Partial' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
      },
    ],
  });

  const name = await enter(host, async () => {
    const reply = await model('acme/small').complete({ messages: [] });
    await expect(reply.finish()).rejects.toBeInstanceOf(Overloaded);
    return reply.model();
  });

  expect(name).toBe('acme/small');
});

test('two calls a host ends with one and the same event each name their own model, and the event is left as it was', async () => {
  const done: StreamEvent = { type: 'finish', reason: 'stop' };
  const host = stubHost({
    'acme/small': [{ type: 'text', text: 'Small' }, done],
    'acme/large': [{ type: 'text', text: 'Large' }, done],
  });

  const names = await enter(host, async () => {
    const small = await model('acme/small').complete({ messages: [] });
    const large = await model('acme/large').complete({ messages: [] });
    return [await small.model(), await large.model(), await small.model()];
  });

  expect(names).toEqual(['acme/small', 'acme/large', 'acme/small']);
  expect(done).toStrictEqual({ type: 'finish', reason: 'stop' });
});

test('an answer through a time limit names the model that was called', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop' },
    ],
  });

  const name = await enter(host, async () => {
    const reply = await timeout(model('acme/small'), {
      first: 1000,
      stall: 1000,
    }).complete({ messages: [] });
    return reply.model();
  });

  expect(name).toBe('acme/small');
});

test('a failure its host calls its own rejects the call with no mark of the upstream', async () => {
  const host = stubHost({
    'acme/small': [
      {
        type: 'error',
        error: {
          code: 'unsupported',
          message: 'No audio here',
          upstream: false,
        },
      },
    ],
  });

  const failure = await enter(host, () =>
    asked().catch((thrown: unknown) => thrown),
  );

  expect(failure).toBeInstanceOf(Unsupported);
  expect('upstream' in toFacts(failure)).toBe(false);
});

test('a failure its host calls its own after the first chunk fails the answer with no mark of the upstream', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Partial' },
      {
        type: 'error',
        error: {
          code: 'internal',
          message: 'The encoder broke',
          upstream: false,
        },
      },
    ],
  });

  const failure = await enter(host, async () => {
    const reply = await model('acme/small').complete({ messages: [] });
    return reply.finish().catch((thrown: unknown) => thrown);
  });

  expect(failure).toBeInstanceOf(MottyError);
  expect('upstream' in toFacts(failure)).toBe(false);
});

test('a race loser whose host reports usage after the winner’s first chunk is counted in its entry and in the totals, still as aborted', async () => {
  const cost = Promise.withResolvers<void>();
  const late: StreamEvent[] = [
    { type: 'text', text: 'Too late' },
    {
      type: 'error',
      error: { code: 'aborted', message: 'Cancelled at the proxy' },
      usage: { input: 40, output: 2 },
    },
  ];
  const left = late.values();
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await cost.promise;
              return left.next();
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    const text = await reply.text();
    await Bun.sleep(1);
    const before = current().calls;
    const stopped = { made: before.made, total: before.total };
    cost.resolve();
    await Bun.sleep(5);
    return { text, stopped, made: before.made, total: before.total };
  });

  expect(outcome.text).toBe('Fast');
  expect(outcome.stopped.made).toEqual([
    {
      model: 'acme/fast',
      input: 1,
      output: 1,
      time: { total: expect.any(Number), firstEvent: expect.any(Number) },
    },
    {
      model: 'acme/slow',
      time: { total: expect.any(Number) },
      code: 'aborted',
      message: 'The call was given up',
    },
  ]);
  expect(outcome.stopped.total).toEqual({ input: 1, output: 1 });
  expect(outcome.made[1]).toEqual({
    model: 'acme/slow',
    input: 40,
    output: 2,
    time: { total: expect.any(Number) },
    code: 'aborted',
    message: 'The call was given up',
  });
  expect(outcome.total).toEqual({ input: 41, output: 3 });
  expect(closed).toBe(1);
}, 1_000);

test('a race loser whose host reports usage after the answer has been sent is not counted, and its stream is closed by then', async () => {
  const cost = Promise.withResolvers<void>();
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await cost.promise;
              return {
                done: false,
                value: {
                  type: 'finish',
                  reason: 'stop',
                  usage: { input: 40, output: 2 },
                },
              };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(1);
    await endPhase();
    const closedAtEnd = closed;
    cost.resolve();
    await Bun.sleep(1);
    return { closedAtEnd, calls: current().calls };
  });

  expect(outcome.closedAtEnd).toBe(1);
  expect(outcome.calls.made[1]).toEqual({
    model: 'acme/slow',
    time: { total: expect.any(Number) },
    code: 'aborted',
    message: 'The call was given up',
  });
  expect(outcome.calls.total).toEqual({ input: 1, output: 1 });
  expect(closed).toBe(1);
}, 1_000);

test('a race loser whose host never ends its stream does not hold the request, and the stream is closed when the phase ends', async () => {
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<never>(() => {}),
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(1);
    const closedBefore = closed;
    await endPhase();
    return { closedBefore, closedAfter: closed, made: current().calls.made };
  });

  expect(outcome.closedBefore).toBe(0);
  expect(outcome.closedAfter).toBe(1);
  expect(outcome.made).toHaveLength(2);
}, 1_000);

test('a race loser whose host has thousands of chunks ready before its usage is counted with it well before the phase ends', async () => {
  let read = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (read === 0) await Bun.sleep(1);
              read += 1;
              return {
                done: false,
                value:
                  read <= 5_000
                    ? { type: 'text', text: 'More' }
                    : {
                        type: 'finish',
                        reason: 'stop',
                        usage: { input: 40, output: 5_000 },
                      },
              };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(50);
    return current().calls.total;
  });

  expect(outcome).toEqual({ input: 41, output: 5_001 });
}, 1_000);

test('a race loser whose host yields on and on with no wait of its own does not hold the request, and is closed and read no more when the phase ends', async () => {
  let read = 0;
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  // It ends far out of reach and not never, so a core that reads it in one
  // run fails here and does not hang the runner.
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (read === 0) await Bun.sleep(1);
              read += 1;
              return read < 1_000_000
                ? { done: false, value: { type: 'text', text: 'More' } }
                : { done: true, value: undefined };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(5);
    const closedBefore = closed;
    await endPhase();
    const readAtEnd = read;
    await Bun.sleep(5);
    return { closedBefore, closedAfter: closed, readAtEnd };
  });

  expect(outcome.closedBefore).toBe(0);
  expect(outcome.closedAfter).toBe(1);
  expect(outcome.readAtEnd).toBeLessThan(1_000_000);
  expect(read).toBe(outcome.readAtEnd);
}, 1_000);

test('a race loser in after-response work is counted with what its host reports until that work ends', async () => {
  const cost = Promise.withResolvers<void>();
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await cost.promise;
              return {
                done: false,
                value: {
                  type: 'finish',
                  reason: 'stop',
                  usage: { input: 40, output: 2 },
                },
              };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    await endPhase();
    beginAfterResponse();
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(1);
    cost.resolve();
    await Bun.sleep(1);
    await endPhase();
    return current().calls;
  });

  expect(outcome.made[1]).toEqual({
    model: 'acme/slow',
    input: 40,
    output: 2,
    time: { total: expect.any(Number) },
    code: 'aborted',
    message: 'The call was given up',
  });
  expect(outcome.total).toEqual({ input: 41, output: 3 });
  expect(closed).toBe(1);
}, 1_000);

test('a race loser in after-response work whose host never ends its stream is closed when that work ends', async () => {
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: () => new Promise<never>(() => {}),
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    await endPhase();
    beginAfterResponse();
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(1);
    const closedBefore = closed;
    await endPhase();
    return [closedBefore, closed];
  });

  expect(outcome).toEqual([0, 1]);
}, 1_000);

test('a late terminal that reports no usage changes nothing in the calls, and the stream is closed', async () => {
  const cost = Promise.withResolvers<void>();
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await cost.promise;
              return { done: false, value: { type: 'finish', reason: 'stop' } };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(1);
    const before = current().calls.made;
    cost.resolve();
    await Bun.sleep(1);
    return {
      before,
      after: current().calls.made,
      total: current().calls.total,
    };
  });

  expect(outcome.after).toBe(outcome.before);
  expect(outcome.total).toEqual({ input: 1, output: 1 });
  expect(closed).toBe(1);
}, 1_000);

test('a stopped call whose host ends its stream with no terminal is left as it was counted, and the stream is closed', async () => {
  const cost = Promise.withResolvers<void>();
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await cost.promise;
              return { done: true, value: undefined };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(1);
    const before = current().calls.made;
    cost.resolve();
    await Bun.sleep(1);
    return { before, after: current().calls.made };
  });

  expect(outcome.after).toBe(outcome.before);
  expect(closed).toBe(1);
}, 1_000);

test('a stopped call whose host throws afterwards is left as it was counted, and the stream is closed', async () => {
  const cost = Promise.withResolvers<void>();
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await cost.promise;
              throw new RangeError('The socket closed');
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    const reply = await race(model('acme/slow'), model('acme/fast')).complete({
      messages: [],
    });
    await reply.text();
    await Bun.sleep(1);
    const before = current().calls.made;
    cost.resolve();
    await Bun.sleep(1);
    return { before, after: current().calls.made };
  });

  expect(outcome.after).toBe(outcome.before);
  expect(closed).toBe(1);
}, 1_000);

test('a call cut by a time limit is counted with the usage its host reports afterwards', async () => {
  const cost = Promise.withResolvers<void>();
  let closed = 0;
  const stub = stubHost({
    'acme/fast': [
      { type: 'text', text: 'Fast' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
    ],
  });
  const models: ModelCall = (name, prompt, signal) =>
    name === 'acme/fast'
      ? stub.models(name, prompt, signal)
      : {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              await cost.promise;
              return {
                done: false,
                value: {
                  type: 'finish',
                  reason: 'stop',
                  usage: { input: 40, output: 2 },
                },
              };
            },
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        };

  const outcome = await enter({ ...stub, models }, async () => {
    await expect(
      timeout(model('acme/slow'), 5).complete({ messages: [] }),
    ).rejects.toBeInstanceOf(TimedOut);
    await Bun.sleep(1);
    const before = current().calls.total;
    cost.resolve();
    await Bun.sleep(1);
    return { before, calls: current().calls };
  });

  expect(outcome.before).toEqual({});
  expect(outcome.calls.made).toEqual([
    {
      model: 'acme/slow',
      input: 40,
      output: 2,
      time: { total: expect.any(Number) },
      code: 'aborted',
      message: 'The call was given up',
    },
  ]);
  expect(outcome.calls.total).toEqual({ input: 40, output: 2 });
  expect(closed).toBe(1);
}, 1_000);

test('a stream its consumer returned while the request goes on is closed at once and not read again', async () => {
  let pulls = 0;
  let closed = 0;
  const models: ModelCall = () => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        pulls += 1;
        return { done: false, value: { type: 'text', text: 'One' } };
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
    }),
  });

  await enter({ ...stubHost(), models }, async () => {
    const events = (await asked())[Symbol.asyncIterator]();
    await events.return?.();
    await Bun.sleep(1);
  });

  expect([pulls, closed]).toEqual([1, 1]);
}, 1_000);
