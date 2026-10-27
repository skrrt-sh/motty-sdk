import { expect, test } from 'bun:test';
import type { EventStream } from '../../src/contract.ts';
import {
  Aborted,
  Blocked,
  InvalidOutput,
  MottyError,
  Overloaded,
  RateLimited,
  TimedOut,
  UnknownModel,
} from '../../src/data/errors.ts';
import type { Chunk, StreamEvent } from '../../src/data/event.ts';
import { answer, buffered, ending } from '../../src/request/answer.ts';
import { endPhase, enter } from '../../src/request/context.ts';
import { model } from '../../src/request/model.ts';
import { stubHost } from '../stub-host.ts';

function stream(events: StreamEvent[]): EventStream {
  const host = stubHost({ 'acme/small': events });
  return host.models('acme/small', { messages: [] }, host.signal);
}

async function* heldAt(
  events: EventStream,
  type: StreamEvent['type'],
  gate: Promise<void>,
): EventStream {
  for await (const event of events) {
    if (event.type === type) await gate;
    yield event;
  }
}

function pending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    Bun.sleep(1).then(() => true),
  ]);
}

test('a text answer finishes with stop and no usage count', async () => {
  const reply = answer('I only answer questions about software.');

  expect(await reply.text()).toBe('I only answer questions about software.');
  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'text', text: 'I only answer questions about software.' },
  ]);
  expect(await reply.finish()).toBe('stop');
  expect(await reply.usage()).toEqual({});
  expect(await ending(reply)).toStrictEqual({ type: 'finish', reason: 'stop' });
});

test('an answer is made from a rewritten chunk stream', async () => {
  async function* withoutReasoning(
    chunks: AsyncIterable<Chunk>,
  ): AsyncIterable<Chunk> {
    for await (const chunk of chunks) {
      if (chunk.type !== 'reasoning') yield chunk;
    }
  }

  const reply = answer(
    withoutReasoning(
      buffered(
        stream([
          { type: 'reasoning', text: 'The lock order differs' },
          { type: 'text', text: 'deep ' },
          { type: 'text', text: 'reply' },
          {
            type: 'finish',
            reason: 'length',
            usage: { input: 9, output: 4, reasoning: 3 },
          },
        ]),
      ).chunks(),
    ),
  );

  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'text', text: 'deep ' },
    { type: 'text', text: 'reply' },
  ]);
  expect(await reply.text()).toBe('deep reply');
  expect(await reply.finish()).toBe('stop');
  expect(await reply.usage()).toEqual({});
});

test('the ending of something this module did not make throws a plain error', () => {
  expect(() => ending({ ...answer('Hello') })).toThrow('Not an answer');
  expect(() => ending({ ...answer('Hello') })).not.toThrow(MottyError);
});

test('an answer is re-read in any order, any number of times', async () => {
  const reply = buffered(
    stream([
      { type: 'reasoning', text: 'Counting' },
      { type: 'text', text: '{"count":' },
      { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
      { type: 'text', text: '2}' },
      { type: 'finish', reason: 'stop', usage: { input: 3, output: 2 } },
    ]),
  );

  expect(await reply.finish()).toBe('stop');
  expect(await reply.json()).toEqual({ count: 2 });
  expect(await reply.text()).toBe('{"count":2}');
  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'reasoning', text: 'Counting' },
    { type: 'text', text: '{"count":' },
    { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
    { type: 'text', text: '2}' },
  ]);
  expect(await reply.text()).toBe('{"count":2}');
  expect((await Array.fromAsync(reply.chunks())).length).toBe(4);
  expect(await reply.json()).toEqual({ count: 2 });
  expect(await reply.usage()).toEqual(await reply.usage());
  expect(await reply.finish()).toBe('stop');
});

test('what is asked before the end resolves once the end arrives', async () => {
  const gate = Promise.withResolvers<void>();
  const reply = buffered(
    heldAt(
      stream([
        { type: 'text', text: '{"count":2}' },
        { type: 'finish', reason: 'length', usage: { input: 3, output: 2 } },
      ]),
      'finish',
      gate.promise,
    ),
  );
  const text = reply.text();
  const json = reply.json();
  const usage = reply.usage();
  const finish = reply.finish();
  const end = ending(reply);

  expect(
    await Promise.all([text, json, usage, finish, end].map(pending)),
  ).toEqual([true, true, true, true, true]);
  gate.resolve();

  expect(await text).toBe('{"count":2}');
  expect(await json).toEqual({ count: 2 });
  expect(await usage).toEqual({ input: 3, output: 2 });
  expect(await finish).toBe('length');
  expect((await end).reason).toBe('length');
  expect(reply.text()).toBe(text);
  expect(await reply.json()).toBe(await json);
});

test('the source is consumed once, to its end, without a reader', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' there' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ],
  });
  const pulled: string[] = [];
  const drained = Promise.withResolvers<void>();
  async function* watched(events: EventStream): EventStream {
    try {
      for await (const event of events) {
        pulled.push(event.type);
        yield event;
      }
    } finally {
      drained.resolve();
    }
  }

  const reply = buffered(
    watched(host.models('acme/small', { messages: [] }, host.signal)),
  );
  expect(pulled).toEqual([]);
  await drained.promise;

  expect(pulled).toEqual(['text', 'text', 'finish']);
  expect(await reply.text()).toBe('Hello there');
  expect(await reply.text()).toBe('Hello there');
  expect((await Array.fromAsync(reply.chunks())).length).toBe(2);
  expect(pulled).toEqual(['text', 'text', 'finish']);
  expect(host.sent('acme/small').length).toBe(1);
});

test('nothing after the terminal is read, and the source is closed', async () => {
  const pulled: string[] = [];
  const closed = Promise.withResolvers<void>();
  async function* watched(events: EventStream): EventStream {
    try {
      for await (const event of events) {
        pulled.push(event.type);
        yield event;
      }
    } finally {
      closed.resolve();
    }
  }

  const reply = buffered(
    watched(
      stream([
        { type: 'text', text: 'Done' },
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
        { type: 'text', text: ' and more' },
        {
          type: 'error',
          error: { code: 'overloaded', status: 503, message: 'Too late' },
        },
      ]),
    ),
  );
  await closed.promise;

  expect(pulled).toEqual(['text', 'finish']);
  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'text', text: 'Done' },
  ]);
  expect(await reply.text()).toBe('Done');
  expect(await reply.finish()).toBe('stop');
});

test('a source that throws while closing does not undo its terminal', async () => {
  function leaky(events: EventStream): EventStream {
    const inner = events[Symbol.asyncIterator]();
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => inner.next(),
        return: async () => {
          throw new RangeError('The socket closed twice');
        },
      }),
    };
  }

  const done = buffered(
    leaky(
      stream([
        { type: 'text', text: 'Done' },
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 1 } },
      ]),
    ),
  );
  await Bun.sleep(1);

  expect(await done.text()).toBe('Done');
  expect(await done.finish()).toBe('stop');
});

test('a terminal error raises the known class after the chunks before it', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: 'Partial' },
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          status: 429,
          message: 'Slow down',
          retryAfter: 1500,
          retryable: true,
          provider: { acme: { bucket: 'tokens' } },
        },
      },
    ]),
  );
  const seen: Chunk[] = [];
  const reading = (async () => {
    for await (const chunk of reply.chunks()) seen.push(chunk);
  })();

  await expect(reading).rejects.toBeInstanceOf(RateLimited);
  await expect(reading).rejects.toMatchObject({
    message: 'Slow down',
    retryAfter: 1500,
    retryable: true,
    provider: { acme: { bucket: 'tokens' } },
  });
  expect(seen).toEqual([{ type: 'text', text: 'Partial' }]);
  expect(await reply.finish().catch((raised: unknown) => raised)).toBe(
    await reply.text().catch((raised: unknown) => raised),
  );
});

test('a failed answer still reports the usage its error carried', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: 'Partial' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
        usage: { input: 40, output: 6, cached: 30 },
      },
    ]),
  );

  expect(await reply.usage()).toEqual({ input: 40, output: 6, cached: 30 });
  expect(await reply.usage()).toEqual({ input: 40, output: 6, cached: 30 });
  await expect(reply.finish()).rejects.toMatchObject({ code: 'overloaded' });
  await expect(reply.text()).rejects.toMatchObject({ code: 'overloaded' });
  await expect(ending(reply)).rejects.toMatchObject({ code: 'overloaded' });
});

test('a failed answer nobody reads stays quiet until it is read', async () => {
  const host = stubHost();

  const reply = buffered(
    host.models('acme/missing', { messages: [] }, host.signal),
  );
  await Bun.sleep(1);

  await expect(reply.finish()).rejects.toBeInstanceOf(UnknownModel);
  expect(await Array.fromAsync(reply.chunks()).catch(() => 'failed')).toBe(
    'failed',
  );
});

test('a source that throws fails the answer with a MottyError holding the cause', async () => {
  async function* broken(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'Partial' };
    throw new RangeError('The socket closed');
  }

  const reply = answer(broken());
  const seen: Chunk[] = [];
  const reading = (async () => {
    for await (const chunk of reply.chunks()) seen.push(chunk);
  })();
  const thrown = await reading.catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(MottyError);
  expect(thrown).toMatchObject({ code: 'internal', status: 500 });
  expect(thrown instanceof Error && thrown.cause).toBeInstanceOf(RangeError);
  expect(seen).toEqual([{ type: 'text', text: 'Partial' }]);
  await expect(reply.text()).rejects.toThrow('The stream failed');
  await expect(reply.json()).rejects.toBe(thrown);
  await expect(reply.usage()).rejects.toBe(thrown);
  await expect(reply.finish()).rejects.toBe(thrown);
  await expect(ending(reply)).rejects.toBe(thrown);
});

test('a source that throws a MottyError fails the answer with that error', async () => {
  const raised = new RateLimited('Slow down', { retryAfter: 20 });
  async function* broken(): EventStream {
    yield { type: 'text', text: 'Partial' };
    throw raised;
  }

  const reply = buffered(broken());

  await expect(reply.finish()).rejects.toBe(raised);
  await expect(Array.fromAsync(reply.chunks())).rejects.toBe(raised);
});

test('a stream that ends without a terminal event fails the answer', async () => {
  const reply = buffered(stream([{ type: 'text', text: 'Partial' }]));
  const seen: Chunk[] = [];
  const reading = (async () => {
    for await (const chunk of reply.chunks()) seen.push(chunk);
  })();

  await expect(reading).rejects.toThrow('without a finish or an error');
  expect(seen).toEqual([{ type: 'text', text: 'Partial' }]);
  await expect(reply.finish()).rejects.toBeInstanceOf(MottyError);
  await expect(reply.text()).rejects.toThrow('without a finish or an error');
  await expect(reply.usage()).rejects.toThrow('without a finish or an error');
});

test('json is validated once and typed by a Standard Schema', async () => {
  let validated = 0;
  const reply = buffered(
    stream([
      { type: 'text', text: '{"city":"Oslo",' },
      { type: 'text', text: '"extra":true}' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
    ]),
    {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value: unknown) => {
          validated += 1;
          return typeof value === 'object' &&
            value !== null &&
            'city' in value &&
            typeof value.city === 'string'
            ? { value: { city: value.city } }
            : { issues: [{ message: 'city must be a string' }] };
        },
      },
    },
  );
  const place: { city: string } = await reply.json();
  // @ts-expect-error the schema's output has no number in it
  const wrong: { city: number } = await reply.json();

  expect([place, wrong]).toEqual([{ city: 'Oslo' }, { city: 'Oslo' }]);
  expect(place).toBe(await reply.json());
  expect(validated).toBe(1);
});

test('an answer rewritten from another ends with that one’s finish event', async () => {
  async function* withoutReasoning(
    chunks: AsyncIterable<Chunk>,
  ): AsyncIterable<Chunk> {
    for await (const chunk of chunks) {
      if (chunk.type !== 'reasoning') yield chunk;
    }
  }
  const inner = buffered(
    stream([
      { type: 'reasoning', text: 'The lock order differs' },
      { type: 'text', text: 'deep reply' },
      { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
      {
        type: 'finish',
        reason: 'tool_calls',
        usage: { input: 9, output: 4, reasoning: 3 },
        rawReason: 'tool_use',
        id: 'resp_81',
        model: 'acme/small-2026',
        warnings: [{ setting: 'seed', detail: 'ignored' }],
        provider: { acme: { tier: 'priority' } },
      },
    ]),
  );

  const reply = answer(withoutReasoning(inner.chunks()), inner);

  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'text', text: 'deep reply' },
    { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
  ]);
  expect(await reply.finish()).toBe('tool_calls');
  expect(await reply.usage()).toEqual({ input: 9, output: 4, reasoning: 3 });
  expect(await ending(reply)).toBe(await ending(inner));
});

test('an answer rewritten from a failed one fails with the same error and usage', async () => {
  async function* same(chunks: AsyncIterable<Chunk>): AsyncIterable<Chunk> {
    yield* chunks;
  }
  const inner = buffered(
    stream([
      { type: 'text', text: 'Partial' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
        usage: { input: 40, output: 6 },
      },
    ]),
  );
  const raised = await inner.finish().catch((thrown: unknown) => thrown);

  const reply = answer(same(inner.chunks()), inner);
  const seen: Chunk[] = [];
  const reading = (async () => {
    for await (const chunk of reply.chunks()) seen.push(chunk);
  })();

  await expect(reading).rejects.toBe(raised);
  expect(seen).toEqual([{ type: 'text', text: 'Partial' }]);
  await expect(reply.finish()).rejects.toBe(raised);
  await expect(ending(reply)).rejects.toBe(raised);
  expect(await reply.usage()).toEqual({ input: 40, output: 6 });
});

test('a rewrite whose chunks end first waits for the ending of the answer it is from', async () => {
  const gate = Promise.withResolvers<void>();
  const inner = buffered(
    heldAt(
      stream([
        { type: 'text', text: 'slow' },
        { type: 'finish', reason: 'length', usage: { input: 2, output: 1 } },
      ]),
      'finish',
      gate.promise,
    ),
  );
  async function* own(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'Rewritten' };
  }

  const reply = answer(own(), inner);
  const live = reply.chunks()[Symbol.asyncIterator]();

  expect(await live.next()).toEqual({
    done: false,
    value: { type: 'text', text: 'Rewritten' },
  });
  const last = live.next();
  expect(
    await Promise.all([last, reply.text(), reply.finish()].map(pending)),
  ).toEqual([true, true, true]);
  gate.resolve();

  expect(await last).toEqual({ done: true, value: undefined });
  expect(await reply.text()).toBe('Rewritten');
  expect(await reply.finish()).toBe('length');
  expect(await reply.usage()).toEqual({ input: 2, output: 1 });
});

test('a rewrite whose chunk source throws fails with that, whatever it is from', async () => {
  const inner = buffered(
    stream([
      { type: 'text', text: 'Fine' },
      { type: 'finish', reason: 'stop', usage: { input: 2, output: 1 } },
    ]),
  );
  const failed = buffered(
    stream([
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
        usage: { input: 40, output: 6 },
      },
    ]),
  );
  const raised = new RateLimited('Slow down');
  async function* broken(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'Partial' };
    throw raised;
  }

  const reply = answer(broken(), inner);
  const other = answer(broken(), failed);

  await expect(reply.finish()).rejects.toBe(raised);
  await expect(reply.usage()).rejects.toBe(raised);
  await expect(other.finish()).rejects.toBe(raised);
  await expect(other.usage()).rejects.toBe(raised);
  expect(await inner.finish()).toBe('stop');
});

test('a rewrite still receiving chunks when the answer it is from fails delivers them, then fails the same', async () => {
  const gate = Promise.withResolvers<void>();
  const inner = buffered(
    stream([
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
        usage: { input: 40, output: 6 },
      },
    ]),
  );
  const raised = await inner.finish().catch((thrown: unknown) => thrown);
  async function* late(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'one ' };
    await gate.promise;
    yield { type: 'text', text: 'two' };
  }

  const reply = answer(late(), inner);
  const seen: Chunk[] = [];
  const reading = (async () => {
    for await (const chunk of reply.chunks()) seen.push(chunk);
  })();

  expect(await pending(reply.finish())).toBe(true);
  gate.resolve();

  await expect(reading).rejects.toBe(raised);
  expect(seen).toEqual([
    { type: 'text', text: 'one ' },
    { type: 'text', text: 'two' },
  ]);
  expect(await reply.usage()).toEqual({ input: 40, output: 6 });
});

test('a text answer made from another ends as that one ends', async () => {
  const inner = buffered(
    stream([
      { type: 'text', text: 'long reply' },
      { type: 'finish', reason: 'length', usage: { input: 9, output: 4 } },
    ]),
  );
  const failed = buffered(
    stream([
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
        usage: { input: 40, output: 6 },
      },
    ]),
  );

  const reply = answer('Shortened', inner);
  const other = answer('Shortened', failed);

  expect(await reply.text()).toBe('Shortened');
  expect(await ending(reply)).toBe(await ending(inner));
  await expect(other.text()).rejects.toBe(
    await failed.finish().catch((thrown: unknown) => thrown),
  );
  expect(await other.usage()).toEqual({ input: 40, output: 6 });
});

test('usage of a failed answer whose error carried none rejects with the error', async () => {
  const reply = buffered(
    stream([
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
      },
    ]),
  );

  await expect(reply.usage()).rejects.toMatchObject({ code: 'overloaded' });
});

test('a source that never ends leaves the answer arriving, with no cancel of its own', async () => {
  let closed = false;
  async function* endless(): EventStream {
    try {
      yield { type: 'text', text: 'Partial' };
      await Promise.withResolvers<void>().promise;
    } finally {
      closed = true;
    }
  }

  const reply = buffered(endless());
  for await (const chunk of reply.chunks()) {
    expect(chunk).toEqual({ type: 'text', text: 'Partial' });
    break;
  }

  expect(
    await Promise.all(
      [reply.text(), reply.json(), reply.usage(), reply.finish()].map(pending),
    ),
  ).toEqual([true, true, true, true]);
  expect(closed).toBe(false);
});

function placed(text: string) {
  return buffered(
    stream([
      { type: 'text', text },
      { type: 'finish', reason: 'length', usage: { input: 1, output: 2 } },
    ]),
    {
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
      },
    },
  );
}

test('a rewrite validates its own text against the schema of the answer it is from', async () => {
  const inner = placed('{"city":"Oslo"}');
  async function* rewritten(): AsyncIterable<Chunk> {
    yield { type: 'text', text: '{"city":"Bergen",' };
    yield { type: 'text', text: '"extra":true}' };
  }

  const reply = answer(rewritten(), inner);
  const wrong = answer('{"city":7}', inner);

  expect(await reply.json()).toEqual({ city: 'Bergen' });
  await expect(wrong.json()).rejects.toBeInstanceOf(InvalidOutput);
});

test('a stream made by hand that gives a finish, which is no chunk, fails the answer there and is closed', async () => {
  let closed = false;
  async function* handMade(): AsyncIterable<Chunk> {
    try {
      yield { type: 'text', text: 'Before' };
      yield JSON.parse('{"type":"finish","reason":"stop"}');
      yield { type: 'text', text: ' after' };
    } finally {
      closed = true;
    }
  }

  const reply = answer(handMade());
  const seen: Chunk[] = [];
  const reading = (async () => {
    for await (const chunk of reply.chunks()) seen.push(chunk);
  })();
  const thrown = await reading.catch((raised: unknown) => raised);

  expect(thrown).toBeInstanceOf(MottyError);
  expect(thrown).toMatchObject({
    code: 'internal',
    message: 'The stream gave something that is not a chunk',
  });
  expect(seen).toEqual([{ type: 'text', text: 'Before' }]);
  expect(closed).toBe(true);
  await expect(reply.text()).rejects.toBe(thrown);
  await expect(reply.usage()).rejects.toBe(thrown);
  await expect(reply.finish()).rejects.toBe(thrown);
});

test('a stream made by hand that goes silent ends with Aborted once the signal fires, is closed and is not read again', async () => {
  const stop = new AbortController();
  let reads = 0;
  let closed = 0;
  const silent: AsyncIterable<Chunk> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve({
              done: false,
              value: { type: 'text', text: 'Half' },
            })
          : new Promise(() => {});
      },
      return: () => {
        closed += 1;
        return new Promise(() => {});
      },
    }),
  };

  const reply = enter(stubHost({}, { signal: stop.signal }), () =>
    answer(silent),
  );
  const seen: Chunk[] = [];
  const reading = (async () => {
    for await (const chunk of reply.chunks()) seen.push(chunk);
  })();
  await Bun.sleep(1);
  stop.abort();
  const thrown = await reading.catch((raised: unknown) => raised);
  await Bun.sleep(1);

  expect(thrown).toBeInstanceOf(Aborted);
  expect(seen).toEqual([{ type: 'text', text: 'Half' }]);
  expect([reads, closed]).toEqual([2, 1]);
});

test('a stream made by hand that keeps giving chunks after the signal fired is closed and not read again', async () => {
  const stop = new AbortController();
  let reads = 0;
  let closed = 0;
  const endless: AsyncIterable<Chunk> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        reads += 1;
        if (reads === 3) stop.abort();
        return { done: false, value: { type: 'text', text: `${reads}` } };
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
    }),
  };

  const reply = enter(stubHost({}, { signal: stop.signal }), () =>
    answer(endless),
  );
  const thrown = await reply.text().catch((raised: unknown) => raised);
  const read = reads;
  await Bun.sleep(5);

  expect(thrown).toBeInstanceOf(Aborted);
  expect([read, reads, closed]).toEqual([3, 3, 1]);
});

test('a stream made by hand whose pending read settles with something that is no chunk after it was given up is closed once and not read again', async () => {
  const stop = new AbortController();
  const late = Promise.withResolvers<IteratorResult<Chunk>>();
  let reads = 0;
  let closed = 0;

  const reply = enter(stubHost({}, { signal: stop.signal }), () =>
    answer({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          reads += 1;
          return late.promise;
        },
        return: async () => {
          closed += 1;
          return { done: true, value: undefined };
        },
      }),
    }),
  );
  stop.abort();
  const thrown = await reply.text().catch((raised: unknown) => raised);
  late.resolve({ done: false, value: JSON.parse('42') });
  await Bun.sleep(1);

  expect(thrown).toBeInstanceOf(Aborted);
  expect([reads, closed]).toEqual([1, 1]);
});

test('a stream made by hand whose stop is told by the host with an error of its own fails the answer with that error', async () => {
  const stop = new AbortController();
  const reason = new TimedOut('The host gave the request two minutes');

  const reply = enter(stubHost({}, { signal: stop.signal }), () =>
    answer({
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    }),
  );
  stop.abort(reason);

  await expect(reply.text()).rejects.toBe(reason);
});

test('a stream made by hand that follows the signal itself ends the way it says', async () => {
  const stop = new AbortController();
  const own = new Blocked('The rewrite was cut off');

  const reply = enter(stubHost({}, { signal: stop.signal }), () =>
    answer(
      (async function* following(): AsyncIterable<Chunk> {
        await new Promise((resolve) =>
          stop.signal.addEventListener('abort', resolve),
        );
        throw own;
      })(),
    ),
  );
  stop.abort();

  await expect(reply.text()).rejects.toBe(own);
});

test('a stream made by hand that was read to its end is not closed', async () => {
  let closed = 0;
  let reads = 0;
  const short: AsyncIterable<Chunk> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        reads += 1;
        return reads === 1
          ? { done: false, value: { type: 'text', text: 'All of it' } }
          : { done: true, value: undefined };
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
    }),
  };

  expect(await enter(stubHost(), () => answer(short)).text()).toBe('All of it');
  expect(closed).toBe(0);
});

test('the text of an answer made outside any request waits under the signal of the request that reads it, and the answer is left as it was', async () => {
  let closed = 0;
  const canned = answer({
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}),
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
    }),
  });
  const stop = new AbortController();

  const thrown = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      const waiting = canned.text().catch((caught: unknown) => caught);
      stop.abort();
      return waiting;
    },
  );

  expect(thrown).toBeInstanceOf(Aborted);
  expect(closed).toBe(0);
});

test('what is read of an answer that has ended is not waited on, whatever became of the signal', async () => {
  const reply = answer('Hi');

  const read = await enter(
    stubHost({}, { signal: AbortSignal.abort() }),
    async () => [
      await reply.text(),
      await reply.finish(),
      await reply.usage(),
      await Array.fromAsync(reply.chunks()),
    ],
  );

  expect(read).toEqual(['Hi', 'stop', {}, [{ type: 'text', text: 'Hi' }]]);
});

test('a stream made by hand that is given up when its phase ends makes no error until its answer is read', async () => {
  let made = 0;
  const plain = globalThis.Error;
  const counting = new Proxy(plain, {
    construct(target, given, madeAs) {
      made += 1;
      return Reflect.construct(target, given, madeAs);
    },
  });

  const silent = await enter(stubHost(), async () => {
    const reply = answer(
      (async function* (): AsyncIterable<Chunk> {
        await new Promise(() => {});
      })(),
    );
    globalThis.Error = counting;
    Object.setPrototypeOf(MottyError, counting);
    await endPhase().finally(() => Bun.sleep(1));
    return reply;
  }).finally(() => {
    globalThis.Error = plain;
  });
  const unread = made;
  const thrown = await silent
    .text()
    .catch((caught: unknown) => caught)
    .finally(() => Object.setPrototypeOf(MottyError, plain));

  expect(unread).toBe(0);
  expect(thrown).toBeInstanceOf(Aborted);
  expect(made).toBe(1);
});

test('the id an upstream gives in its finish is not the model of the answer', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: 'Hello' },
      { type: 'finish', reason: 'stop', model: 'acme/small-2026' },
    ]),
  );

  expect(await reply.model()).toBeUndefined();
});

test('an answer rewritten from one a model gave names that model, and one rewritten from that does too', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'deep reply' },
      { type: 'finish', reason: 'stop', model: 'acme/small-2026' },
    ],
  });

  const names = await enter(host, async () => {
    const inner = await model('acme/small').complete({ messages: [] });
    const reply = answer(inner.chunks(), inner);
    const again = answer('short reply', reply);
    return [await inner.model(), await reply.model(), await again.model()];
  });

  expect(names).toEqual(['acme/small', 'acme/small', 'acme/small']);
});

test('an answer rewritten from one that failed after its first chunk names the model that failed', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Partial' },
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Try later' },
      },
    ],
  });

  const names = await enter(host, async () => {
    const inner = await model('acme/small').complete({ messages: [] });
    const reply = answer('Sorry', inner);
    await expect(reply.finish()).rejects.toBeInstanceOf(Overloaded);
    return [await inner.model(), await reply.model()];
  });

  expect(names).toEqual(['acme/small', 'acme/small']);
});

test('a rewrite whose chunk source throws names no model', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'deep reply' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  // biome-ignore lint/correctness/useYield: the source fails before it gives a chunk
  async function* broken(): AsyncIterable<Chunk> {
    throw new RangeError('The rewrite broke');
  }

  const name = await enter(host, async () => {
    const inner = await model('acme/small').complete({ messages: [] });
    return answer(broken(), inner).model();
  });

  expect(name).toBeUndefined();
});
