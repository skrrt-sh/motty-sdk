import { expect, spyOn, test } from 'bun:test';
import type { AnyMotty } from '../../src/chain/builder.ts';
import { motty } from '../../src/chain/motty.ts';
import { contractOf } from '../../src/chain/run.ts';
import type { EventStream, Host, RequestRecord } from '../../src/contract.ts';
import { UpstreamFailed } from '../../src/data/errors.ts';
import type { Chunk, StreamEvent, Usage } from '../../src/data/event.ts';
import type { ChatRequest } from '../../src/data/message.ts';
import { answer, buffered } from '../../src/request/answer.ts';
import * as context from '../../src/request/context.ts';
import { model } from '../../src/request/model.ts';
import { fallback } from '../../src/request/switching.ts';
import { think } from '../../src/request/think.ts';
import { stubHost } from '../stub-host.ts';

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

function says(text: string, input: number, output: number): StreamEvent[] {
  return [
    { type: 'text', text },
    { type: 'finish', reason: 'stop', usage: { input, output } },
  ];
}

function reading(served: AnyMotty, host: Host = stubHost()) {
  return contractOf(served).run(ask(), host)[Symbol.asyncIterator]();
}

async function told(served: AnyMotty, host: Host = stubHost()) {
  const seen = [];
  for await (const event of contractOf(served).run(ask(), host)) {
    seen.push(event);
  }
  return seen;
}

function stalling(...events: StreamEvent[]): EventStream {
  let sent = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const event = events[sent];
        sent += 1;
        return event === undefined
          ? new Promise(() => {})
          : Promise.resolve({ done: false, value: event });
      },
    }),
  };
}

function stopped(usage: Usage = {}): StreamEvent {
  return {
    type: 'error',
    error: {
      code: 'aborted',
      status: 499,
      message: 'The work was stopped',
      retryable: false,
    },
    usage,
  };
}

test('progress goes out as events of its own, all ahead of the answer', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => {
        think('Reading the request');
      })
      .handle(() => {
        think('Answering with the deep tier');
        return answer('The lock order differs');
      }),
  );

  expect(seen).toEqual([
    { type: 'progress', piece: 0, text: 'Reading the request' },
    { type: 'progress', piece: 1, text: 'Answering with the deep tier' },
    { type: 'text', text: 'The lock order differs' },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
});

test('progress offered in afterHandle still goes out, the stage closing after it', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => answer('The lock order differs'))
      .afterHandle(() => {
        think('Checking the answer');
      }),
  );

  expect(seen.map((event) => event.type)).toEqual([
    'progress',
    'text',
    'finish',
  ]);
});

test('think does nothing once the answer is being sent', async () => {
  const gate = Promise.withResolvers<void>();
  async function* arriving(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'The lock ' };
    await gate.promise;
    think('Too late to be progress');
    yield { type: 'text', text: 'order differs' };
  }
  const reader = reading(
    motty({ name: 'coder' }).handle(() => answer(arriving())),
  );

  expect((await reader.next()).value).toEqual({
    type: 'text',
    text: 'The lock ',
  });
  gate.resolve();
  expect((await reader.next()).value).toEqual({
    type: 'text',
    text: 'order differs',
  });
  expect((await reader.next()).value?.type).toBe('finish');
});

test('think in afterResponse does nothing and does not throw', async () => {
  const over = Promise.withResolvers<RequestRecord>();

  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => answer('Hi'))
      .afterResponse(() => {
        think('Remembering the route');
      }),
    stubHost({}, { record: over.resolve }),
  );

  expect(seen.map((event) => event.type)).toEqual(['text', 'finish']);
  expect((await over.promise).afterResponse.failed).toEqual([]);
});

test('a forwarded answer still arriving when the answer starts is dropped', async () => {
  const gate = Promise.withResolvers<void>();
  async function* arriving(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'Planning' };
    await gate.promise;
    yield { type: 'text', text: ' the rest' };
  }

  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(async () => {
        think(answer(arriving()));
        await Bun.sleep(1);
      })
      .handle(() => answer('The lock order differs')),
  );
  gate.resolve();

  expect(seen).toEqual([
    { type: 'progress', piece: 0, text: 'Planning' },
    { type: 'text', text: 'The lock order differs' },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
});

test('a request that failed before any answer ends with one error after its progress, a server failure told in its own words', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => {
      think('Answering with the deep tier');
      throw new UpstreamFailed('Every model is down');
    }),
  );

  expect(seen).toEqual([
    { type: 'progress', piece: 0, text: 'Answering with the deep tier' },
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        status: 502,
        message: 'Every model is down',
        retryable: true,
      },
      usage: {},
    },
  ]);
});

test('the finish tells the total over every call, not only the one that answered', async () => {
  const seen = await told(
    motty({ name: 'coder' }).route(
      async ({ prompt }) => {
        await model('acme/judge').complete(prompt);
        return 'deep' as const;
      },
      { deep: ({ prompt }) => model('acme/large').complete(prompt) },
    ),
    stubHost({
      'acme/judge': says('hard', 40, 2),
      'acme/large': says('The lock order differs', 50, 9),
    }),
  );

  expect(seen.at(-1)).toEqual({
    type: 'finish',
    reason: 'stop',
    usage: { input: 90, output: 11 },
  });
});

test('the finish keeps what the answer ended with besides its usage', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/large').complete(prompt),
    ),
    stubHost({
      'acme/large': [
        { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
        {
          type: 'finish',
          reason: 'tool_calls',
          rawReason: 'tool_use',
          id: 'msg_1',
          model: 'large-2026',
          usage: { input: 5, output: 7, cached: 3 },
        },
      ],
    }),
  );

  expect(seen).toEqual([
    { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
    {
      type: 'finish',
      reason: 'tool_calls',
      rawReason: 'tool_use',
      id: 'msg_1',
      model: 'large-2026',
      usage: { input: 5, output: 7, cached: 3 },
    },
  ]);
});

test('the finish a host is sent names the model that was called when read as an answer, and holds no field for it', async () => {
  const sent: StreamEvent[] = [];
  async function* received(): EventStream {
    yield* sent;
  }
  async function* copied(): EventStream {
    yield* structuredClone(sent);
  }

  for await (const event of contractOf(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      fallback(model('acme/small'), model('acme/large')).complete(prompt),
    ),
  ).run(
    ask(),
    stubHost({ 'acme/large': says('The lock order differs', 50, 9) }),
  )) {
    if (event.type !== 'progress') sent.push(event);
  }

  expect(await buffered(received()).model()).toBe('acme/large');
  expect(await buffered(copied()).model()).toBeUndefined();
  expect(sent.at(-1)).toEqual({
    type: 'finish',
    reason: 'stop',
    usage: { input: 50, output: 9 },
  });
});

test('an answer whose stream fails midway ends in that error after its chunks', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/large').complete(prompt),
    ),
    stubHost({
      'acme/large': [
        { type: 'text', text: 'The lock ' },
        {
          type: 'error',
          error: { code: 'overloaded', status: 503, message: 'Busy' },
          usage: { input: 5, output: 2 },
        },
      ],
    }),
  );

  expect(seen).toEqual([
    { type: 'text', text: 'The lock ' },
    {
      type: 'error',
      error: {
        code: 'overloaded',
        status: 503,
        message: 'Busy',
        retryable: true,
      },
      usage: { input: 5, output: 2 },
    },
  ]);
});

test('a look-alike not made by answer() or a model call is no answer: nothing of it is sent and none of its code runs', async () => {
  const ran: string[] = [];

  const seen = await told(
    motty({ name: 'coder' }).handle(() => ({
      ...answer('Hand-made'),
      chunks: () => {
        ran.push('chunks');
        return answer('Hand-made').chunks();
      },
    })),
  );

  expect(seen).toMatchObject([
    { type: 'error', error: { code: 'internal', message: 'Internal error' } },
  ]);
  expect(ran).toEqual([]);
});

test('when the signal fires a waiting reader gets aborted at once', async () => {
  const stop = new AbortController();
  const gate = Promise.withResolvers<void>();
  const reader = reading(
    motty({ name: 'coder' }).handle(async () => {
      await gate.promise;
      return answer('Too late');
    }),
    stubHost({}, { signal: stop.signal }),
  );

  const waiting = reader.next();
  stop.abort();

  expect(await waiting).toEqual({ done: false, value: stopped() });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
  gate.resolve();
});

test('a signal that fired while nobody was reading gives aborted to the next read', async () => {
  const stop = new AbortController();
  const reader = reading(
    motty({ name: 'coder' }).handle(() => answer('Never read')),
    stubHost({}, { signal: stop.signal }),
  );

  await Bun.sleep(1);
  stop.abort();

  expect(await reader.next()).toEqual({ done: false, value: stopped() });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
});

test('a request whose signal had already fired gives only the aborted event', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => answer('Never sent')),
    stubHost({}, { signal: AbortSignal.abort() }),
  );

  expect(seen).toEqual([stopped()]);
});

test('an answer cut by the signal ends in aborted after the chunks already read', async () => {
  const stop = new AbortController();
  const done = Promise.withResolvers<string>();
  async function* arriving(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'The lock ' };
    stop.abort();
    yield { type: 'text', text: 'order differs' };
  }

  const seen = await told(
    motty({ name: 'coder' })
      .handle(() => answer(arriving()))
      .afterResponse(({ outcome }) => {
        done.resolve(outcome);
      }),
    stubHost({}, { signal: stop.signal }),
  );

  expect(seen.at(-1)).toEqual(stopped());
  expect(seen.filter((event) => event.type === 'error')).toHaveLength(1);
  expect(await done.promise).toBe('aborted');
});

test('the aborted event tells what the request had used', async () => {
  const stop = new AbortController();

  const seen = await told(
    motty({ name: 'coder' }).handle(async ({ prompt }) => {
      const first = await model('acme/small').complete(prompt);
      await first.finish();
      stop.abort();
      return first;
    }),
    stubHost({ 'acme/small': says('Hi', 4, 1) }, { signal: stop.signal }),
  );

  expect(seen).toEqual([stopped({ input: 4, output: 1 })]);
});

test('nothing follows the terminal event', async () => {
  const reader = reading(motty({ name: 'coder' }).handle(() => answer('Hi')));

  await reader.next();
  expect((await reader.next()).value?.type).toBe('finish');

  expect(await reader.next()).toEqual({ done: true, value: undefined });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
});

test('an event waits for the reader before the next is produced', async () => {
  const order: string[] = [];
  async function* arriving(): AsyncIterable<Chunk> {
    yield { type: 'text', text: 'one' };
    yield { type: 'text', text: 'two' };
  }
  const reader = reading(
    motty({ name: 'coder' })
      .handle(() => answer(arriving()))
      .afterResponse(() => {
        order.push('response');
      }),
  );

  await reader.next();
  await reader.next();
  await Bun.sleep(1);
  order.push('before the finish was read');
  await reader.next();
  await Bun.sleep(1);

  expect(order).toEqual(['before the finish was read', 'response']);
});

test('a reader that leaves ends the stream and the request counts as aborted', async () => {
  const done = Promise.withResolvers<string>();
  const reader = reading(
    motty({ name: 'coder' })
      .handle(({ prompt }) => model('acme/large').complete(prompt))
      .afterResponse(({ outcome }) => {
        done.resolve(outcome);
      }),
    stubHost({
      'acme/large': [
        { type: 'text', text: 'The lock ' },
        { type: 'text', text: 'order differs' },
        { type: 'finish', reason: 'stop', usage: { input: 5, output: 7 } },
      ],
    }),
  );

  await reader.next();
  await reader.return?.();

  expect(await reader.next()).toEqual({ done: true, value: undefined });
  expect(await done.promise).toBe('aborted');
});

test('every event of an answer with progress survives a JSON round trip', async () => {
  const seen = await told(
    motty({ name: 'coder' })
      .beforeHandle(() => {
        think('Reading the request');
      })
      .handle(() => answer('The lock order differs')),
  );

  expect(seen.map((event) => event.type)).toEqual([
    'progress',
    'text',
    'finish',
  ]);
  for (const event of seen) {
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
  }
});

test('every kind of chunk and a full finish survive a JSON round trip', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete(prompt),
    ),
    stubHost({
      'acme/small': [
        { type: 'reasoning', text: 'Two locks', block: 0 },
        { type: 'text', text: 'The lock order differs', block: 1 },
        { type: 'tool_call', id: 'call_1', name: 'read', arguments: '{"pa' },
        { type: 'tool_call', id: 'call_1', arguments: 'th":"a.ts"}' },
        {
          type: 'tool_result',
          id: 'call_2',
          output: { lines: [1, 2], found: true, note: null },
          failed: false,
          hosted: true,
        },
        { type: 'file', data: 'aGk=', mediaType: 'text/plain' },
        { type: 'file', url: 'https://acme.test/a.png' },
        { type: 'file', id: 'file_1', mediaType: 'image/png' },
        { type: 'citation', title: 'Locks', url: 'https://acme.test/locks' },
        { type: 'refusal', text: 'Not that' },
        { type: 'provider', provider: { acme: { signature: 'abc' } } },
        {
          type: 'finish',
          reason: 'tool_calls',
          usage: {
            input: 9,
            output: 4,
            cached: 0,
            cacheWrite: 2,
            reasoning: 1,
          },
          rawReason: 'tool_use',
          id: 'msg_1',
          model: 'acme/small-2',
          warnings: [{ setting: 'seed', detail: 'Ignored' }],
          provider: { acme: { tier: 'fast' } },
        },
      ],
    }),
  );

  expect(seen.map((event) => event.type)).toEqual([
    'reasoning',
    'text',
    'tool_call',
    'tool_call',
    'tool_result',
    'file',
    'file',
    'file',
    'citation',
    'refusal',
    'provider',
    'finish',
  ]);
  for (const event of seen) {
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
  }
});

test('a structured answer survives a JSON round trip', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete({
        ...prompt,
        output: { schema: { type: 'object' } },
      }),
    ),
    stubHost({
      'acme/small': [
        { type: 'text', text: '{"tier":' },
        { type: 'text', text: '"deep"}' },
        { type: 'finish', reason: 'stop' },
      ],
    }),
  );

  expect(seen.at(-1)).toStrictEqual({
    type: 'finish',
    reason: 'stop',
    usage: {},
  });
  for (const event of seen) {
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
  }
});

test('the error of a failed request survives a JSON round trip', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => {
      throw new UpstreamFailed('Every model is down');
    }),
  );

  expect(seen.map((event) => event.type)).toEqual(['error']);
  for (const event of seen) {
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
  }
});

test('the error of a stopped request survives a JSON round trip', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle(() => answer('Hi')),
    stubHost({}, { signal: AbortSignal.abort() }),
  );

  expect(seen).toEqual([stopped()]);
  for (const event of seen) {
    expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
  }
});

test('a finish reports no count when no upstream reported one, and a reported zero as zero', async () => {
  const silent = await told(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete(prompt),
    ),
    stubHost({ 'acme/small': [{ type: 'finish', reason: 'stop' }] }),
  );
  const zero = await told(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete(prompt),
    ),
    stubHost({ 'acme/small': says('', 0, 0) }),
  );

  expect(silent.at(-1)).toStrictEqual({
    type: 'finish',
    reason: 'stop',
    usage: {},
  });
  expect(zero.at(-1)).toStrictEqual({
    type: 'finish',
    reason: 'stop',
    usage: { input: 0, output: 0 },
  });
});

test('closing the stream ends a wait on a silent upstream and refuses the next call', async () => {
  const asked: string[] = [];
  const records: RequestRecord[] = [];
  const over = Promise.withResolvers<RequestRecord>();
  const done = Promise.withResolvers<string>();
  const reader = reading(
    motty({ name: 'coder' })
      .handle(async ({ prompt }) => {
        const plan = await model('acme/small').complete(prompt);
        think('Reading the plan');
        await plan.text().catch(() => {});
        return model('acme/large').complete(prompt);
      })
      .afterResponse(({ outcome }) => {
        done.resolve(outcome);
      }),
    {
      ...stubHost(
        {},
        {
          record: (record) => {
            records.push(record);
            over.resolve(record);
          },
        },
      ),
      models: (name) => {
        asked.push(name);
        return stalling({ type: 'text', text: 'Half' });
      },
    },
  );

  expect((await reader.next()).value?.type).toBe('progress');
  await reader.return?.();
  const { outcome, error, calls } = await over.promise;

  expect(await done.promise).toBe('aborted');
  expect({ outcome, code: error?.code }).toEqual({
    outcome: 'aborted',
    code: 'aborted',
  });
  expect(calls.map((call) => call.model)).toEqual(['acme/small']);
  expect(asked).toEqual(['acme/small']);
  expect(records).toHaveLength(1);
});

test('closing the stream ends an answer streaming from a silent upstream', async () => {
  const records: RequestRecord[] = [];
  const over = Promise.withResolvers<RequestRecord>();
  const done = Promise.withResolvers<string>();
  const reader = reading(
    motty({ name: 'coder' })
      .handle(({ prompt }) => model('acme/large').complete(prompt))
      .afterResponse(({ outcome }) => {
        done.resolve(outcome);
      }),
    {
      ...stubHost(
        {},
        {
          record: (record) => {
            records.push(record);
            over.resolve(record);
          },
        },
      ),
      models: () => stalling({ type: 'text', text: 'The lock ' }),
    },
  );

  expect(await reader.next()).toEqual({
    done: false,
    value: { type: 'text', text: 'The lock ' },
  });
  await reader.return?.();
  const { outcome, error } = await over.promise;

  expect(await done.promise).toBe('aborted');
  expect({ outcome, code: error?.code }).toEqual({
    outcome: 'aborted',
    code: 'aborted',
  });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
  expect(records).toHaveLength(1);
});

test('closing the stream refuses the steps that had not run', async () => {
  const ran: string[] = [];
  const gate = Promise.withResolvers<void>();
  const done = Promise.withResolvers<string>();
  const reader = reading(
    motty({ name: 'coder' })
      .beforeHandle(async () => {
        think('Checking the cache');
        await gate.promise;
      })
      .handle(() => {
        ran.push('handle');
        return answer('Hi');
      })
      .afterResponse(({ outcome }) => {
        done.resolve(outcome);
      }),
  );

  await reader.next();
  await reader.return?.();
  gate.resolve();

  expect(await done.promise).toBe('aborted');
  expect(ran).toEqual([]);
});

test('closing a stream that has ended changes nothing: the request completed', async () => {
  const over = Promise.withResolvers<RequestRecord>();
  const reader = contractOf(motty({ name: 'coder' }).handle(() => answer('Hi')))
    .run(ask(), stubHost({}, { record: over.resolve }))
    [Symbol.asyncIterator]();

  await reader.next();
  expect((await reader.next()).value?.type).toBe('finish');
  await reader.return?.();

  expect((await over.promise).outcome).toBe('completed');
});

test('the signal a hook was given fires once the answer has been sent', async () => {
  const held = Promise.withResolvers<AbortSignal>();
  const seen = await told(
    motty({ name: 'coder' }).handle(({ signal }) => {
      held.resolve(signal);
      return answer('Hi');
    }),
  );

  expect(seen.map((event) => event.type)).toEqual(['text', 'finish']);
  expect((await held.promise).aborted).toBe(true);
});

test('an answer made outside any request is left when the host stops the request that sends it: the caller gets its terminal event, after-response work runs and the record arrives', async () => {
  const canned = answer(
    (async function* () {
      yield { type: 'text', text: 'Half' } as const;
      await new Promise(() => {});
    })(),
  );
  const stop = new AbortController();
  const over = Promise.withResolvers<RequestRecord>();
  const seen: string[] = [];

  const reader = contractOf(
    motty({ name: 'coder' })
      .handle(() => canned)
      .afterResponse(({ outcome }) => {
        seen.push(outcome);
      }),
  )
    .run(ask(), stubHost({}, { signal: stop.signal, record: over.resolve }))
    [Symbol.asyncIterator]();
  const first = await reader.next();
  const waiting = reader.next();
  stop.abort();

  expect(first.value).toEqual({ type: 'text', text: 'Half' });
  expect((await waiting).value).toMatchObject({ error: { code: 'aborted' } });
  expect(await over.promise).toMatchObject({
    outcome: 'aborted',
    error: { code: 'aborted' },
  });
  expect(seen).toEqual(['aborted']);
}, 1_000);

test('an answer made outside any request is left when the host closes the stream of the request that sends it, and still answers the next request', async () => {
  let asked = 0;
  let closed = 0;
  const canned = answer({
    [Symbol.asyncIterator]: () => ({
      next: () => {
        asked += 1;
        return asked === 1
          ? Promise.resolve({
              done: false,
              value: { type: 'text', text: 'Half' } as const,
            })
          : new Promise<never>(() => {});
      },
      return: async () => {
        closed += 1;
        return { done: true, value: undefined };
      },
    }),
  });
  const served = motty({ name: 'coder' })
    .handle(() => canned)
    .afterResponse(() => {});
  const over = Promise.withResolvers<RequestRecord>();
  const again = Promise.withResolvers<RequestRecord>();

  const reader = contractOf(served)
    .run(ask(), stubHost({}, { record: over.resolve }))
    [Symbol.asyncIterator]();
  await reader.next();
  await reader.return?.();
  const first = await over.promise;
  const next = contractOf(served)
    .run(ask(), stubHost({}, { record: again.resolve }))
    [Symbol.asyncIterator]();
  const replayed = await next.next();
  await next.return?.();

  expect(first.outcome).toBe('aborted');
  expect(replayed.value).toEqual({ type: 'text', text: 'Half' });
  expect((await again.promise).outcome).toBe('aborted');
  expect(closed).toBe(0);
}, 1_000);

test('a caller who left before the terminal event has the phase of the answer ended once', async () => {
  const ended = spyOn(context, 'endPhase');
  const over = Promise.withResolvers<RequestRecord>();

  const reader = reading(
    motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete(prompt),
    ),
    {
      ...stubHost({}, { record: over.resolve }),
      models: () => stalling({ type: 'text', text: 'Half' }),
    },
  );
  await reader.next();
  await reader.return?.();
  const { outcome } = await over.promise;
  const times = ended.mock.calls.length;
  ended.mockRestore();

  expect(outcome).toBe('aborted');
  expect(times).toBe(1);
}, 1_000);
