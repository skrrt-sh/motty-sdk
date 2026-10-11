import { expect, test } from 'bun:test';
import type { Json } from '@mottyjs/core/host';
import { events } from '../../src/messages/events.ts';
import { partsOf } from '../../src/messages/parts.ts';

async function read(...wire: Json[]) {
  async function* upstream() {
    for (const event of wire) yield { data: JSON.stringify(event) };
  }
  return Array.fromAsync(events(upstream()));
}

test('a text stream is text chunks and one finish with usage', async () => {
  expect(
    await read(
      {
        type: 'message_start',
        message: {
          id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 25,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 2000,
            output_tokens: 1,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      { type: 'ping' },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '!' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: 'message_stop' },
    ),
  ).toEqual([
    { type: 'text', text: 'Hello', block: 0 },
    { type: 'text', text: '!', block: 0 },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 2125, output: 15, cached: 2000, cacheWrite: 100 },
      rawReason: 'end_turn',
      id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
      model: 'claude-opus-5-5',
    },
  ]);
});

test("thinking is reasoning, and its signature rides as this family's own", async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me see.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'redacted_thinking', data: 'EmwKAhgB' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: 'message_stop' },
    ),
  ).toMatchObject([
    { type: 'reasoning', text: 'Let me see.', block: 0 },
    {
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
    },
    {
      type: 'reasoning',
      text: '',
      block: 1,
      provider: { anthropic: { type: 'redacted_thinking', data: 'EmwKAhgB' } },
    },
    { type: 'finish' },
  ]);
});

test('a thinking block that comes whole is its text, then its signature alone', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'thinking',
          thinking: 'Let me see.',
          signature: 'EqQBCgIYAhIM',
        },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: 'message_stop' },
    ),
  ).toMatchObject([
    { type: 'reasoning', text: 'Let me see.', block: 0 },
    {
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
    },
    { type: 'finish' },
  ]);
});

test('input JSON deltas are fragments of the tool call they belong to', async () => {
  const chunks = await read(
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
        name: 'get_weather',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"location":' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: ' "San Francisco, CA"}',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB',
        name: 'web_search',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query": "weather"}' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 89 },
    },
    { type: 'message_stop' },
  );
  expect(chunks.slice(0, -1)).toEqual([
    {
      type: 'tool_call',
      id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
      name: 'get_weather',
      arguments: '',
      block: 0,
    },
    {
      type: 'tool_call',
      id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
      arguments: '{"location":',
      block: 0,
    },
    {
      type: 'tool_call',
      id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
      arguments: ' "San Francisco, CA"}',
      block: 0,
    },
    {
      type: 'tool_call',
      id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB',
      name: 'web_search',
      arguments: '',
      hosted: true,
      block: 1,
      provider: { anthropic: { type: 'server_tool_use' } },
    },
    {
      type: 'tool_call',
      id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB',
      arguments: '{"query": "weather"}',
      block: 1,
    },
  ]);
  const joined = chunks
    .flatMap((chunk) =>
      chunk.type === 'tool_call' && chunk.block === 0 ? [chunk.arguments] : [],
    )
    .join('');
  expect(JSON.parse(joined)).toEqual({ location: 'San Francisco, CA' });
  expect(chunks.at(-1)).toMatchObject({
    type: 'finish',
    reason: 'tool_calls',
    rawReason: 'tool_use',
  });
});

test.each([
  ['tool_use', {}],
  ['server_tool_use', { hosted: true }],
])(
  'a %s block that ends with no input said is told as an empty object, once',
  async (type, hosted) => {
    const chunks = await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type, id: 'toolu_01', name: 'get_time', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
      },
      { type: 'message_stop' },
    );
    expect(chunks.slice(0, -1)).toMatchObject([
      { type: 'tool_call', id: 'toolu_01', name: 'get_time', ...hosted },
      { type: 'tool_call', id: 'toolu_01', arguments: '', block: 0 },
      { type: 'tool_call', id: 'toolu_01', arguments: '{}', block: 0 },
    ]);
    expect(chunks).toHaveLength(4);
  },
);

test("a citation delta is a citation with the upstream's own form kept", async () => {
  const citation = {
    type: 'char_location',
    cited_text: 'The grass is green.',
    document_index: 0,
    document_title: 'Facts',
    start_char_index: 0,
    end_char_index: 19,
  };
  const chunks = await read(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'citations_delta', citation },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Green.' },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 15 },
    },
    { type: 'message_stop' },
  );
  expect(chunks[0]).toEqual({
    type: 'citation',
    title: 'Facts',
    text: 'The grass is green.',
    block: 0,
    provider: { anthropic: citation },
  });
});

test('every stop reason ends the stream with its finish reason', async () => {
  for (const [raw, reason] of [
    ['end_turn', 'stop'],
    ['max_tokens', 'length'],
    ['stop_sequence', 'stop'],
    ['tool_use', 'tool_calls'],
    ['pause_turn', 'pause'],
    ['refusal', 'content_filter'],
  ] as const) {
    const [finish] = await read(
      {
        type: 'message_delta',
        delta: { stop_reason: raw, stop_sequence: null },
        usage: { output_tokens: 3 },
      },
      { type: 'message_stop' },
    );
    expect(finish).toMatchObject({ type: 'finish', reason, rawReason: raw });
  }
});

test('the stop sequence and the refusal details ride on the finish', async () => {
  const [stopped] = await read(
    {
      type: 'message_delta',
      delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  );
  expect(stopped).toMatchObject({
    provider: { anthropic: { stop_sequence: 'END' } },
  });
  const [refused] = await read(
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'refusal',
        stop_sequence: null,
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      },
      usage: { output_tokens: 0 },
    },
    { type: 'message_stop' },
  );
  expect(refused).toMatchObject({
    reason: 'content_filter',
    provider: {
      anthropic: {
        stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      },
    },
  });
});

test('the final counts replace the first ones', async () => {
  const [finish] = await read(
    {
      type: 'message_start',
      message: {
        id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 25, output_tokens: 1 },
      },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: 30,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2000,
        output_tokens: 40,
        output_tokens_details: { thinking_tokens: 12 },
      },
    },
    { type: 'message_stop' },
  );
  expect(finish).toMatchObject({
    usage: {
      input: 2030,
      output: 40,
      cached: 2000,
      cacheWrite: 0,
      reasoning: 12,
    },
  });
});

test('a later message delta adds to the ending and wipes nothing', async () => {
  for (const later of [
    {},
    { stop_reason: null, stop_sequence: null },
    { stop_details: null },
  ]) {
    expect(
      await read(
        { type: 'message_start', message: { usage: { input_tokens: 9 } } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' },
          usage: { output_tokens: 5 },
        },
        { type: 'message_delta', delta: later, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ),
    ).toEqual([
      {
        type: 'finish',
        reason: 'stop',
        rawReason: 'stop_sequence',
        usage: { input: 9, output: 7 },
        provider: { anthropic: { stop_sequence: 'END' } },
      },
    ]);
  }
});

test('an error event ends the stream with its neutral code', async () => {
  expect(
    await read(
      {
        type: 'message_start',
        message: {
          id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
          model: 'claude-opus-5-5',
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      },
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      },
    ),
  ).toEqual([
    { type: 'text', text: 'Hel', block: 0 },
    {
      type: 'error',
      error: {
        code: 'overloaded',
        message: 'Overloaded',
        provider: { anthropic: { type: 'overloaded_error' } },
        upstream: true,
      },
      usage: { input: 25, output: 1 },
    },
  ]);
});

test('a ping and an event not known here are ignored', async () => {
  expect(
    await read(
      { type: 'ping' },
      { type: 'usage_report', tokens: 5 },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'future_delta' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: 'message_stop' },
    ),
  ).toMatchObject([{ type: 'finish', reason: 'stop' }]);
});

test.each([
  '{"type":"content_block_de',
  `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"f","input":${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}}}`,
])('a frame that cannot be read fails the stream once', async (data) => {
  async function* upstream() {
    yield {
      event: 'message_start',
      data: '{"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}',
    };
    yield { event: 'content_block_delta', data };
    yield { event: 'message_stop', data: '{"type":"message_stop"}' };
  }
  expect(await Array.fromAsync(events(upstream()))).toEqual([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream sent an event that cannot be read',
        retryable: true,
        upstream: true,
      },
      usage: { input: 25, output: 1 },
    },
  ]);
  async function* text() {
    yield { data: '[DONE]' };
  }
  expect(await Array.fromAsync(events(text()))).toMatchObject([
    { type: 'error', error: { code: 'upstream_failed' } },
  ]);
});

test('a stream cut before its stop reason fails; one cut after finishes', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      },
    ),
  ).toMatchObject([
    { type: 'text', text: 'Hel' },
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream closed the stream before it finished',
        retryable: true,
      },
    },
  ]);
  expect(await read()).toMatchObject([{ type: 'error' }]);
  expect(
    await read({ type: 'message_delta', delta: {}, usage: {} }),
  ).toMatchObject([{ type: 'error', error: { code: 'upstream_failed' } }]);
  expect(
    await read({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 15 },
    }),
  ).toMatchObject([{ type: 'finish', reason: 'stop', usage: { output: 15 } }]);
});

test('blocks with malformed fields are skipped, not guessed', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', name: 'x' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 5 },
      },
      { type: 'content_block_delta', index: 1, delta: 'text' },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: 'message_stop' },
    ),
  ).toMatchObject([{ type: 'finish' }]);
});

test('an ending said under a key named as the prototype is no ending', async () => {
  async function* upstream() {
    yield {
      data: '{"type":"message_delta","delta":{"__proto__":{"stop_reason":"max_tokens"}},"usage":{"__proto__":{"output_tokens":999}}}',
    };
  }
  expect(await Array.fromAsync(events(upstream()))).toEqual([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream closed the stream before it finished',
        retryable: true,
        upstream: true,
      },
      usage: {},
    },
  ]);
});

test('a streamed citation whose title is null is titled by its document, as one sent whole is', async () => {
  const citation = {
    type: 'char_location',
    cited_text: 'It grew 4%.',
    document_index: 0,
    document_title: 'Annual report',
    title: null,
    start_char_index: 0,
    end_char_index: 11,
  };
  const [streamed] = await read({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'citations_delta', citation },
  });
  const [, whole] = partsOf({
    type: 'text',
    text: 'It grew.',
    citations: [citation],
  });
  const told = {
    title: 'Annual report',
    text: 'It grew 4%.',
    provider: { anthropic: citation },
  };
  expect(whole).toEqual({ type: 'citation', ...told });
  expect(streamed).toEqual({ type: 'citation', ...told, block: 0 });
});
