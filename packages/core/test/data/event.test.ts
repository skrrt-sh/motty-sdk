import { expect, test } from 'bun:test';
import {
  type Chunk,
  chunkOf,
  eventOf,
  type Failed,
  type Finish,
  type FinishReason,
  isTerminal,
  type StreamEvent,
  type Terminal,
  type Usage,
  usageOf,
} from '../../src/data/event.ts';

function describe(event: StreamEvent): string {
  switch (event.type) {
    case 'text':
    case 'refusal':
      return event.text;
    case 'reasoning':
      return event.text;
    case 'tool_call':
      return `${event.id} ${event.name ?? ''} ${event.arguments}`;
    case 'tool_result':
      return `${event.id} ${event.failed ?? false}`;
    case 'file':
      return event.mediaType ?? '';
    case 'citation':
      return event.title ?? event.url ?? '';
    case 'provider':
      return Object.keys(event.provider).join();
    case 'finish':
      return `${event.reason} ${event.usage?.output}`;
    case 'error':
      return `${event.error.status} ${event.error.code}`;
    default:
      return event satisfies never;
  }
}

test('every event narrows on its type', () => {
  expect(
    [
      { type: 'text', text: 'Hello' } satisfies Chunk,
      {
        type: 'reasoning',
        text: '',
        provider: { anthropic: { signature: 'sig' } },
      } satisfies Chunk,
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'search',
        arguments: '{"q":',
      } satisfies Chunk,
      {
        type: 'tool_call',
        id: 'call_2',
        name: 'web_search',
        arguments: '{}',
        hosted: true,
      } satisfies Chunk,
      {
        type: 'tool_result',
        id: 'call_2',
        output: [{ url: 'https://example.com' }],
      } satisfies Chunk,
      {
        type: 'tool_result',
        id: 'call_3',
        output: null,
        failed: true,
      } satisfies Chunk,
      {
        type: 'file',
        data: 'iVBORw0=',
        mediaType: 'image/png',
      } satisfies Chunk,
      { type: 'file', url: 'https://example.com/a.png' } satisfies Chunk,
      {
        type: 'citation',
        url: 'https://example.com',
        title: 'Example',
        text: 'quoted',
      } satisfies Chunk,
      { type: 'refusal', text: 'No' } satisfies Chunk,
      {
        type: 'provider',
        provider: {
          anthropic: { type: 'redacted_thinking', data: 'opaque' },
        },
      } satisfies Chunk,
      {
        type: 'finish',
        reason: 'tool_calls',
        usage: { input: 12, output: 7, cached: 4, reasoning: 0 },
      } satisfies Terminal,
      {
        type: 'error',
        error: { code: 'rate_limited', status: 429, message: 'Slow down' },
      } satisfies Terminal,
    ].map(describe),
  ).toEqual([
    'Hello',
    '',
    'call_1 search {"q":',
    'call_2 web_search {}',
    'call_2 false',
    'call_3 true',
    'image/png',
    '',
    'Example',
    'No',
    'anthropic',
    'tool_calls 7',
    '429 rate_limited',
  ]);
});

test('reasoning is filtered out of a chunk stream', async () => {
  async function* reply(): AsyncIterable<Chunk> {
    yield { type: 'reasoning', text: 'The lock order differs' };
    yield { type: 'text', text: 'deep reply' };
  }

  async function* withoutReasoning(
    chunks: AsyncIterable<Chunk>,
  ): AsyncIterable<Chunk> {
    for await (const chunk of chunks) {
      if (chunk.type !== 'reasoning') yield chunk;
    }
  }

  expect(await Array.fromAsync(withoutReasoning(reply()))).toEqual([
    { type: 'text', text: 'deep reply' },
  ]);
});

test('a tool call arrives as fragments under one id', () => {
  const fragments = [
    { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{"q":' },
    { type: 'tool_call', id: 'call_1', arguments: '"motty"}' },
  ] satisfies Chunk[];

  expect(fragments.map((fragment) => fragment.arguments).join('')).toBe(
    '{"q":"motty"}',
  );
});

test('a block number keeps two adjacent blocks of one kind apart', () => {
  const chunks = [
    { type: 'reasoning', text: 'First, ', block: 0 },
    { type: 'reasoning', text: 'the locks.', block: 0 },
    { type: 'reasoning', text: 'Then the order.', block: 1 },
    { type: 'text', text: 'It deadlocks.', block: 2 },
    { type: 'provider', provider: {}, block: 3 },
  ] satisfies Chunk[];

  expect(Map.groupBy(chunks, (chunk) => chunk.block).size).toBe(4);
});

test('a generated file carries its bytes with a media type, or a url', () => {
  // @ts-expect-error
  const untyped: Chunk = { type: 'file', data: 'iVBORw0=' };

  expect(untyped.type).toBe('file');
});

test('a generated file the provider holds is named by its id alone', () => {
  const held: Chunk = { type: 'file', id: 'file_1' };
  const typed: Chunk = { type: 'file', id: 'file_2', mediaType: 'image/png' };
  // @ts-expect-error
  const twice: Chunk = { type: 'file', id: 'file_3', url: 'https://a.test' };

  expect([held.type, typed.type, twice.type]).toEqual(['file', 'file', 'file']);
});

test('a tool result says when the provider ran the tool', () => {
  const result: Chunk = {
    type: 'tool_result',
    id: 'call_1',
    output: [],
    hosted: true,
  };

  expect(result.hosted).toBe(true);
});

test('a chunk carries no hints, which only a request has', () => {
  // @ts-expect-error
  const hinted: Chunk = { type: 'text', text: 'Hello', hints: {} };

  expect(hinted.type).toBe('text');
});

test('a reader cannot write to a chunk or a terminal event', () => {
  const chunk: Chunk = { type: 'text', text: 'Hello' };
  const finish: Terminal = { type: 'finish', reason: 'stop', usage: {} };
  // @ts-expect-error
  chunk.text = 'Goodbye';
  // @ts-expect-error
  chunk.block = 1;
  // @ts-expect-error
  finish.reason = 'length';
  // @ts-expect-error
  if (finish.usage !== undefined) finish.usage.input = 1;

  expect([chunk.type, finish.type]).toEqual(['text', 'finish']);
});

test('a finish may report no usage, and usage no count', () => {
  const silent: Terminal = { type: 'finish', reason: 'stop' };
  const empty: Usage = {};
  const zero: Usage = { cached: 0 };

  expect('usage' in silent).toBe(false);
  expect(['input' in empty, zero.cached]).toEqual([false, 0]);
});

test('an error inside a stream has no status', () => {
  const failed: Terminal = {
    type: 'error',
    error: { code: 'overloaded', message: 'Try again' },
  };

  expect('status' in failed.error).toBe(false);
});

test('a finish carries what the upstream said about the call', () => {
  const finish: Terminal = {
    type: 'finish',
    reason: 'pause',
    usage: { input: 12, output: 7 },
    rawReason: 'pause_turn',
    id: 'msg_1',
    model: 'acme/small-2026',
    warnings: [{ setting: 'topK' }, { setting: 'seed', detail: 'emulated' }],
    provider: { anthropic: { stop_sequence: null } },
  };

  expect(finish.reason).toBe('pause');
});

test('a terminal event is not a chunk', () => {
  const finish: Chunk = {
    // @ts-expect-error a finish ends the stream, it is not content
    type: 'finish',
    reason: 'stop',
    usage: { input: 1, output: 1, cached: 0, reasoning: 0 },
  };
  // @ts-expect-error content does not end a stream
  const text: Terminal = { type: 'text', text: 'Hello' };

  expect([finish.type, text.type]).toEqual(['finish', 'text']);
});

test('the error event carries retry facts as plain data', () => {
  const failed: StreamEvent = {
    type: 'error',
    error: {
      code: 'overloaded',
      status: 529,
      message: 'Try again',
      retryAfter: 1500,
      retryable: true,
      provider: { anthropic: { type: 'overloaded_error' } },
    },
    usage: { input: 12, output: 0 },
  };
  const thrown: StreamEvent = {
    type: 'error',
    // @ts-expect-error facts, never an error instance
    error: new Error('Try again'),
  };

  expect([failed.type, thrown.type]).toEqual(['error', 'error']);
});

test('events hold plain data only', () => {
  const opaque: Chunk = {
    type: 'provider',
    // @ts-expect-error a function is not plain data
    provider: { openai: { parse: () => 'logprobs' } },
  };
  const whole: Chunk = {
    type: 'tool_call',
    id: 'call_1',
    name: 'search',
    // @ts-expect-error arguments stream as text, not as a parsed value
    arguments: { q: 'motty' },
  };

  expect([opaque.type, whole.type]).toEqual(['provider', 'tool_call']);
});

test('usage and the finish reason are closed sets', () => {
  const reported: Usage = { input: 1, output: 1 };
  const detailed: Usage = {
    input: 9,
    output: 5,
    cached: 4,
    cacheWrite: 2,
    reasoning: 3,
  };
  const other: FinishReason = 'other';
  // @ts-expect-error one family's wire name is not the common set
  const reason: FinishReason = 'end_turn';
  const finish: Terminal = {
    type: 'finish',
    reason: 'length',
    // @ts-expect-error no count the upstream did not report
    usage: { input: 1, output: 1, total: 2 },
  };

  expect('cached' in reported).toBe(false);
  expect(`${detailed.cacheWrite} ${other} ${reason} ${finish.type}`).toBe(
    '2 other end_turn finish',
  );
});

test.each([
  [{ type: 'text', text: 'Hello' }],
  [{ type: 'text', text: '', block: 0, provider: { openai: { index: 0 } } }],
  [{ type: 'reasoning', text: 'Compare the two locks' }],
  [{ type: 'refusal', text: 'I cannot help with that' }],
  [{ type: 'tool_call', id: 'call_1', arguments: '{"q":' }],
  [
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'search',
      arguments: '',
      hosted: true,
    },
  ],
  [{ type: 'tool_result', id: 'call_1', output: null }],
  [
    {
      type: 'tool_result',
      id: 'call_1',
      output: { hits: [1, 2] },
      failed: false,
      hosted: true,
    },
  ],
  [{ type: 'file', data: 'iVBORw0=', mediaType: 'image/png' }],
  [{ type: 'file', url: 'https://example.com/a.png' }],
  [{ type: 'file', id: 'file_1', mediaType: 'image/png' }],
  [{ type: 'citation' }],
  [{ type: 'citation', title: 'Docs', url: 'https://example.com', text: 'x' }],
  [{ type: 'provider', provider: { openai: { logprobs: [] } } }],
])('%j enters as the chunk it is', (chunk) => {
  expect([chunkOf(chunk) === chunk, eventOf(chunk) === chunk]).toEqual([
    true,
    true,
  ]);
});

test.each([
  [undefined],
  [null],
  ['text'],
  [42],
  [[{ type: 'text', text: 'Hello' }]],
  [{}],
  [{ text: 'Hello' }],
  [{ type: 7, text: 'Hello' }],
  [{ type: 'image', url: 'https://example.com/a.png' }],
  [{ type: 'text' }],
  [{ type: 'text', text: 7 }],
  [{ type: 'text', text: new Date(0) }],
  [{ type: 'text', text: () => 'Hello' }],
  [{ type: 'text', text: 'Hello', block: 1n }],
  [{ type: 'text', text: 'Hello', block: Number.NaN }],
  [{ type: 'text', text: 'Hello', block: '0' }],
  [{ type: 'text', text: 'Hello', provider: 'openai' }],
  [{ type: 'text', text: 'Hello', provider: [] }],
  [{ type: 'text', text: 'Hello', provider: null }],
  [{ type: 'reasoning', text: null }],
  [{ type: 'refusal', text: ['no'] }],
  [{ type: 'tool_call', arguments: '{}' }],
  [{ type: 'tool_call', id: 1, arguments: '{}' }],
  [{ type: 'tool_call', id: 'call_1' }],
  [{ type: 'tool_call', id: 'call_1', arguments: { q: 'motty' } }],
  [{ type: 'tool_call', id: 'call_1', arguments: '', name: 7 }],
  [{ type: 'tool_call', id: 'call_1', arguments: '', hosted: 'yes' }],
  [{ type: 'tool_result', output: 'found' }],
  [{ type: 'tool_result', id: 'call_1' }],
  [{ type: 'tool_result', id: 'call_1', output: () => 'found' }],
  [{ type: 'tool_result', id: 'call_1', output: 5n }],
  [{ type: 'tool_result', id: 'call_1', output: Number.POSITIVE_INFINITY }],
  [{ type: 'tool_result', id: 'call_1', output: 'found', failed: 1 }],
  [{ type: 'tool_result', id: 'call_1', output: 'found', hosted: 'no' }],
  [{ type: 'file' }],
  [{ type: 'file', mediaType: 'image/png' }],
  [{ type: 'file', data: 'iVBORw0=' }],
  [{ type: 'file', data: new Uint8Array(4), mediaType: 'image/png' }],
  [{ type: 'file', data: 'iVBORw0=', mediaType: 'image/png', id: 'file_1' }],
  [{ type: 'file', url: 'https://example.com/a.png', id: 'file_1' }],
  [{ type: 'file', url: new URL('https://example.com/a.png') }],
  [{ type: 'file', id: 1 }],
  [{ type: 'file', id: 'file_1', mediaType: 7 }],
  [{ type: 'citation', title: 7 }],
  [{ type: 'citation', url: new URL('https://example.com') }],
  [{ type: 'citation', text: false }],
  [{ type: 'provider' }],
  [{ type: 'provider', provider: 'openai' }],
])('%p is not an event', (value) => {
  expect([chunkOf(value), eventOf(value)]).toEqual([undefined, undefined]);
});

test.each([
  [{ type: 'progress', text: 'Reading the diff' }],
  [{ type: 'progress', chunk: { type: 'text', text: 'Hello' } }],
])('progress %j cannot be forged as an event', (value) => {
  expect([chunkOf(value), eventOf(value)]).toEqual([undefined, undefined]);
});

test('provider data, tool output and warnings pass unchecked', () => {
  const chunk = {
    type: 'tool_result',
    id: 'call_1',
    output: { at: new Date(0) },
    provider: { openai: { parse: () => 'logprobs' } },
  };
  const finish = { type: 'finish', reason: 'stop', warnings: [7] };
  expect([
    Object.is(chunkOf(chunk), chunk),
    Object.is(eventOf(finish), finish),
  ]).toEqual([true, true]);
});

test.each([
  [{ type: 'finish', reason: 'stop' }],
  [
    {
      type: 'finish',
      reason: 'tool_calls',
      usage: { input: 12, output: 0, cached: 4, cacheWrite: 2, reasoning: 1 },
      rawReason: 'tool_use',
      id: 'msg_1',
      model: 'acme/small',
      warnings: [{ setting: 'seed' }],
      provider: { anthropic: { stop_sequence: null } },
    },
  ],
])('%j enters as the terminal event it is', (event) => {
  expect(eventOf(event) === event).toBe(true);
});

test('a failure that enters is marked as from outside and is otherwise as it was sent', () => {
  expect<unknown>(
    eventOf({
      type: 'error',
      error: { code: 'db_down', status: 503, message: 'busy', shard: 7 },
      usage: { input: 12 },
      trace: 't_1',
    }),
  ).toStrictEqual({
    type: 'error',
    error: {
      code: 'db_down',
      status: 503,
      message: 'busy',
      shard: 7,
      upstream: true,
    },
    usage: { input: 12 },
    trace: 't_1',
  });
});

test('a failure its host calls its own enters unmarked, and that word is not kept', () => {
  const sent = {
    type: 'error',
    error: { code: 'unsupported', message: 'No audio here', upstream: false },
    usage: { input: 3 },
  };

  expect<unknown>(eventOf(sent)).toStrictEqual({
    type: 'error',
    error: { code: 'unsupported', message: 'No audio here' },
    usage: { input: 3 },
  });
  expect(sent.error.upstream).toBe(false);
});

test.each([[true], [null], ['false'], [0], [{}]])(
  'a failure whose host says %p of it is marked as from outside',
  (upstream) => {
    expect(
      eventOf({
        type: 'error',
        error: { code: 'rate_limited', message: 'busy', upstream },
      }),
    ).toHaveProperty('error.upstream', true);
  },
);

test.each([
  [{ type: 'finish', reason: 'stop' }],
  [{ type: 'error', error: { code: 'overloaded', message: 'busy' } }],
])('the terminal event %j is not a chunk', (event) => {
  expect(chunkOf(event)).toBeUndefined();
});

test.each([
  [{ type: 'finish' }],
  [{ type: 'finish', reason: 'end_turn' }],
  [{ type: 'finish', reason: 7 }],
  [{ type: 'finish', reason: 'stop', rawReason: 7 }],
  [{ type: 'finish', reason: 'stop', id: 1 }],
  [{ type: 'finish', reason: 'stop', model: ['acme/small'] }],
  [{ type: 'finish', reason: 'stop', warnings: 'seed' }],
  [{ type: 'finish', reason: 'stop', provider: 'anthropic' }],
  [{ type: 'error' }],
  [{ type: 'error', error: 'overloaded' }],
  [{ type: 'error', error: null }],
  [{ type: 'error', error: { message: 'busy' } }],
  [{ type: 'error', error: { code: 503, message: 'busy' } }],
  [{ type: 'error', error: new Error('busy') }],
])('%p is not a terminal event', (value) => {
  expect(eventOf(value)).toBeUndefined();
});

test.each([
  [{ input: 12, output: -1 }, { input: 12 }],
  [{ input: 12, output: 1.5 }, { input: 12 }],
  [{ input: 12, output: Number.NaN }, { input: 12 }],
  [{ input: 12, output: Number.POSITIVE_INFINITY }, { input: 12 }],
  [{ input: 12, output: 2 ** 53 }, { input: 12 }],
  [{ input: 12, output: '3' }, { input: 12 }],
  [{ input: 12, output: 3n }, { input: 12 }],
  [{ input: 12, output: null }, { input: 12 }],
  [{ input: () => 12, cached: 0 }, { cached: 0 }],
  ['lots', {}],
  [null, {}],
  [12, {}],
])('usage %p costs the wrong counts and keeps the event', (usage, kept) => {
  expect([
    eventOf({ type: 'finish', reason: 'stop', usage }),
    eventOf({
      type: 'error',
      error: { code: 'overloaded', message: 'busy' },
      usage,
    }),
  ]).toStrictEqual([
    { type: 'finish', reason: 'stop', usage: kept },
    {
      type: 'error',
      error: { code: 'overloaded', message: 'busy', upstream: true },
      usage: kept,
    },
  ]);
});

test('a count of zero is a count', () => {
  const finish = { type: 'finish', reason: 'stop', usage: { cached: 0 } };
  expect(eventOf(finish) === finish).toBe(true);
});

test('usage with nothing wrong is given back as it is', () => {
  const usage = { input: 12, cached: 0 };
  expect(usageOf(usage) === usage).toBe(true);
});

test('usage from any reporter keeps only its whole counts', () => {
  expect([
    usageOf({ input: 12, output: 1.5, cached: '4', reasoning: 0 }),
    usageOf('lots'),
    usageOf(undefined),
  ]).toStrictEqual([{ input: 12, reasoning: 0 }, {}, {}]);
});

test('a cost is an amount, whole or not, and is kept beside the counts', () => {
  const usage = { input: 12, cost: 0.0000023 };
  expect(usageOf(usage) === usage).toBe(true);
});

test('a cost that is not an amount is dropped and the counts kept', () => {
  expect([
    usageOf({ input: 12, cost: -1 }),
    usageOf({ input: 12, cost: Number.POSITIVE_INFINITY }),
    usageOf({ input: 12, cost: '0.5' }),
    usageOf({ input: 12, cost: 0 }),
  ]).toStrictEqual([
    { input: 12 },
    { input: 12 },
    { input: 12 },
    { input: 12, cost: 0 },
  ]);
});

test.each([
  [{ type: 'finish', reason: 'stop' } satisfies StreamEvent, true],
  [
    {
      type: 'error',
      error: { code: 'overloaded', message: 'busy' },
    } satisfies StreamEvent,
    true,
  ],
  [{ type: 'text', text: 'Hello' } satisfies StreamEvent, false],
  [{ type: 'provider', provider: {} } satisfies StreamEvent, false],
  [{ type: 'progress', piece: 0, text: 'Reading' }, false],
])('%j is terminal: %p', (event, terminal) => {
  expect(isTerminal(event)).toBe(terminal);
});

test('the terminal check narrows an event to how it ended, and what is left to a chunk', () => {
  function ended(event: StreamEvent): string {
    if (!isTerminal(event)) {
      const chunk: Chunk = event;
      return chunk.type;
    }
    const terminal: Finish | Failed = event;
    return terminal.type === 'finish' ? terminal.reason : terminal.error.code;
  }

  expect([
    ended({ type: 'text', text: 'Hello' }),
    ended({ type: 'finish', reason: 'length' }),
    ended({ type: 'error', error: { code: 'overloaded', message: 'busy' } }),
  ]).toEqual(['text', 'length', 'overloaded']);
});

test('the terminal check keeps what else a stream holds apart from its end', () => {
  function told(sent: StreamEvent | { type: 'progress'; text: string }) {
    if (isTerminal(sent)) return sent.type;
    return sent.type === 'progress' ? sent.text : sent.type;
  }

  expect([
    told({ type: 'progress', text: 'Reading' }),
    told({ type: 'finish', reason: 'stop' }),
  ]).toEqual(['Reading', 'finish']);
});

test('the error of a failed event is the facts of an error, read-only', () => {
  const failed: Failed = {
    type: 'error',
    error: {
      code: 'overloaded',
      message: 'busy',
      provider: { acme: { id: 'e_1' } },
      upstream: true,
    },
  };
  // @ts-expect-error
  failed.error.message = 'idle';
  // @ts-expect-error
  failed.error.provider = {};

  expect(failed.error.code).toBe('overloaded');
});
