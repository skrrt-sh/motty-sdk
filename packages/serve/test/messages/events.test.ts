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
      id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
      arguments: '',
      ended: true,
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
  [
    'tool_use',
    {},
    [{ type: 'tool_call', id: 'toolu_01', arguments: '', ended: true }],
  ],
  ['server_tool_use', { hosted: true }, []],
])(
  'a %s block that ends with no input said is told as an empty object, once',
  async (type, hosted, whole) => {
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
      ...whole,
    ]);
    expect(chunks).toHaveLength(4 + whole.length);
  },
);

test('a call that is the last block of a reply cut at its limit is not said to have ended', async () => {
  const chunks = await read(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_01', name: 'write' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"text":"half' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'max_tokens' } },
    { type: 'message_stop' },
  );
  expect(chunks.slice(0, -1)).toEqual([
    {
      type: 'tool_call',
      id: 'toolu_01',
      name: 'write',
      arguments: '',
      block: 0,
    },
    {
      type: 'tool_call',
      id: 'toolu_01',
      arguments: '{"text":"half',
      block: 0,
    },
  ]);
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

test('a frame that cannot be read fails the stream once', async () => {
  async function* upstream() {
    yield {
      event: 'message_start',
      data: '{"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}',
    };
    yield { event: 'content_block_delta', data: '{"type":"content_block_de' };
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

test('what a message says beside the fields read here rides on the finish', async () => {
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
          container: null,
          future_message_field: { kept: true },
          usage: {
            input_tokens: 25,
            output_tokens: 1,
            cache_creation: { ephemeral_1h_input_tokens: 100 },
            service_tier: 'standard',
            inference_geo: 'us',
            server_tool_use: null,
          },
        },
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
          container: {
            id: 'container_011',
            expires_at: '2026-10-12T10:00:00Z',
          },
          future_delta_field: 'kept',
        },
        usage: {
          output_tokens: 40,
          server_tool_use: { web_search_requests: 1 },
          future_count: 3,
        },
        context_management: { applied_edits: [] },
        future_event_field: 'kept',
      },
      { type: 'message_stop' },
    ),
  ).toEqual([
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'end_turn',
      id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
      model: 'claude-opus-5-5',
      usage: { input: 25, output: 40 },
      provider: {
        anthropic: {
          future_message_field: { kept: true },
          container: {
            id: 'container_011',
            expires_at: '2026-10-12T10:00:00Z',
          },
          future_delta_field: 'kept',
          usage: {
            cache_creation: { ephemeral_1h_input_tokens: 100 },
            service_tier: 'standard',
            inference_geo: 'us',
            server_tool_use: { web_search_requests: 1 },
            future_count: 3,
          },
          message_delta: {
            context_management: { applied_edits: [] },
            future_event_field: 'kept',
          },
        },
      },
    },
  ]);
});

test('a block told whole is told when it ends, with what its deltas said', async () => {
  const chunks = await read(
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'mcp_tool_use',
        id: 'mcptoolu_014Q35RayjACSWkSj4X2yov1',
        name: 'echo',
        server_name: 'example-mcp',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"param1":' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: ' "value1"}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'mcp_tool_result',
        tool_use_id: 'mcptoolu_014Q35RayjACSWkSj4X2yov1',
        is_error: false,
        content: [{ type: 'text', text: 'value1' }],
      },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'compaction', content: null },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: {
        type: 'compaction_delta',
        content: 'Summary so far',
        encrypted_content: 'EuYBCkQYAiJA',
      },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'text_delta', text: 'Done.' },
    },
    { type: 'content_block_stop', index: 3 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 15 },
    },
    { type: 'message_stop' },
  );
  expect(chunks.slice(0, -1)).toEqual([
    {
      type: 'provider',
      block: 0,
      provider: {
        anthropic: {
          type: 'mcp_tool_use',
          id: 'mcptoolu_014Q35RayjACSWkSj4X2yov1',
          name: 'echo',
          server_name: 'example-mcp',
          input: { param1: 'value1' },
        },
      },
    },
    {
      type: 'provider',
      block: 1,
      provider: {
        anthropic: {
          type: 'mcp_tool_result',
          tool_use_id: 'mcptoolu_014Q35RayjACSWkSj4X2yov1',
          is_error: false,
          content: [{ type: 'text', text: 'value1' }],
        },
      },
    },
    {
      type: 'provider',
      block: 2,
      provider: {
        anthropic: {
          type: 'compaction',
          content: 'Summary so far',
          encrypted_content: 'EuYBCkQYAiJA',
        },
      },
    },
    { type: 'text', text: 'Done.', block: 3 },
  ]);
});

test('a block told whole that never ends is still told before the finish', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'compaction', content: 'Summary so far' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
      { type: 'message_stop' },
    ),
  ).toMatchObject([
    {
      type: 'provider',
      block: 0,
      provider: {
        anthropic: { type: 'compaction', content: 'Summary so far' },
      },
    },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('a block told whole is still told when the upstream itself fails, and the failure is thrown as it was', async () => {
  const failure = new Error('socket closed');
  async function* upstream() {
    yield {
      data: JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'compaction', content: 'Summary' },
      }),
    };
    throw failure;
  }
  const stream = events(upstream());

  expect(await stream.next()).toEqual({
    done: false,
    value: {
      type: 'provider',
      block: 0,
      provider: { anthropic: { type: 'compaction', content: 'Summary' } },
    },
  });
  await expect(stream.next()).rejects.toBe(failure);
});

test('a delta read here that comes inside a block told whole is part of that block', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'future_block', text: '', thinking: 'Hm' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hel' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'lo' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'm.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'EqQB' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'citations_delta', citation: { cited_text: 'Hello' } },
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
    {
      type: 'provider',
      block: 0,
      provider: {
        anthropic: {
          type: 'future_block',
          text: 'Hello',
          thinking: 'Hmm.',
          signature: 'EqQB',
          citations: [{ cited_text: 'Hello' }],
        },
      },
    },
    { type: 'finish', reason: 'stop' },
  ]);
});

test.each([
  [
    'the stream is cut',
    { type: 'ping' },
    { code: 'upstream_failed', message: expect.stringContaining('closed') },
  ],
  [
    'the upstream fails',
    { type: 'error', error: { type: 'overloaded_error', message: 'Busy' } },
    { code: 'overloaded' },
  ],
])(
  'a block told whole whose input was cut when %s is told with input that reads as failed',
  async (_, last, error) => {
    expect(
      await read(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'mcp_tool_use', id: 'mcptoolu_01', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        },
        last,
      ),
    ).toMatchObject([
      {
        type: 'provider',
        block: 0,
        provider: {
          anthropic: {
            type: 'mcp_tool_use',
            id: 'mcptoolu_01',
            input: { INVALID_JSON: '{"q":' },
          },
        },
      },
      { type: 'error', error },
    ]);
  },
);

test('a block that starts where one told whole never ended is told after it, and is not part of it', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_01',
          content: [],
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
        delta: { type: 'text_delta', text: 'hello' },
      },
      { type: 'content_block_stop', index: 0 },
    ),
  ).toMatchObject([
    {
      type: 'provider',
      block: 0,
      provider: {
        anthropic: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_01',
          content: [],
        },
      },
    },
    { type: 'text', text: 'hello', block: 0 },
    { type: 'error' },
  ]);
});

test('blocks told whole that name no place are each told', async () => {
  expect(
    await read(
      { type: 'content_block_start', content_block: { type: 'a_block', v: 1 } },
      { type: 'content_block_start', content_block: { type: 'b_block', v: 2 } },
      { type: 'content_block_stop' },
    ),
  ).toMatchObject([
    { type: 'provider', provider: { anthropic: { type: 'a_block', v: 1 } } },
    { type: 'provider', provider: { anthropic: { type: 'b_block', v: 2 } } },
    { type: 'error' },
  ]);
});

test('a block told whole that never ends is told before the block that starts after it', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'compaction', content: 'Summary' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'f' },
      },
      { type: 'content_block_stop', index: 1 },
    ),
  ).toMatchObject([
    { type: 'provider', block: 0 },
    { type: 'tool_call', id: 'toolu_01', name: 'f', block: 1 },
    { type: 'tool_call', id: 'toolu_01', arguments: '{}', block: 1 },
    { type: 'error' },
  ]);
});

test('a block held through a hundred thousand deltas is built once, not once for each', async () => {
  const said = Array.from({ length: 100_000 }, (_, at) => ({ [`k${at}`]: 1 }));
  const [told] = await read(
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'future_block' },
    },
    ...said.map((fields) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'future_delta', ...fields },
    })),
    { type: 'content_block_stop', index: 0 },
  );
  expect(told).toEqual({
    type: 'provider',
    block: 0,
    provider: {
      anthropic: {
        type: 'future_block',
        ...Object.fromEntries(said.flatMap((fields) => Object.entries(fields))),
      },
    },
  });
});

test('a tool_use block keeps every field not read here, an empty one and one named as a field of another block too', async () => {
  const unread = {
    signature: 'SG',
    text: 'T',
    thinking: 'TH',
    caller: null,
    a: [],
    b: {},
    c: 0,
    d: '',
    e: false,
  };
  const [call] = await read({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'f',
      input: {},
      ...unread,
    },
  });
  expect(call).toEqual({
    type: 'tool_call',
    id: 'toolu_01',
    name: 'f',
    arguments: '',
    block: 0,
    provider: { anthropic: unread },
  });
});

test('input said after its block ended is not the call`s', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'f' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'LATE' },
      },
    ),
  ).toMatchObject([
    { type: 'tool_call', id: 'toolu_01', arguments: '' },
    { type: 'tool_call', id: 'toolu_01', arguments: '{}' },
    { type: 'error' },
  ]);
});

test('a block that starts with no kind is no block', async () => {
  expect(
    await read(
      {
        type: 'content_block_start',
        index: 0,
        content_block: { text: 'kindless' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ),
  ).toMatchObject([{ type: 'finish', reason: 'stop' }]);
});
