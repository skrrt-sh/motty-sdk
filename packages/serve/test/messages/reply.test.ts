import { expect, test } from 'bun:test';
import type { Progress, StreamEvent } from '@mottyjs/core/host';
import { streamed, writer } from '../../src/messages/reply.ts';
import { parsed } from '../../src/wire/json.ts';

async function written(events: (StreamEvent | Progress)[], shown = true) {
  async function* run() {
    yield* events;
  }
  return Array.fromAsync(streamed(run(), 'req_1', 'coder', shown));
}

test('progress is a thinking block with no signature, ahead of the answer', () => {
  const write = writer(true);
  expect([
    ...write({ type: 'progress', piece: 0, text: 'Routing' }),
    ...write({ type: 'progress', piece: 0, text: ' to fast' }),
    ...write({ type: 'progress', piece: 1, text: 'Asking fast' }),
    ...write({ type: 'text', text: 'Hi' }),
  ]).toEqual([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Routing' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: ' to fast' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'thinking_delta', thinking: 'Asking fast' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: { type: 'text_delta', text: 'Hi' },
    },
  ]);
});

test('progress is not written for a caller who muted reasoning', () => {
  expect(
    writer(false)({ type: 'progress', piece: 0, text: 'Routing' }),
  ).toEqual([]);
});

test("a model's reasoning is a thinking block closed by its signature", () => {
  const write = writer(false);
  expect([
    ...write({ type: 'reasoning', text: 'Let me see.', block: 0 }),
    ...write({
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
    }),
    ...write({ type: 'finish', reason: 'stop' }),
  ]).toMatchObject([
    { type: 'content_block_start', index: 0 },
    { delta: { type: 'thinking_delta', thinking: 'Let me see.' } },
    { delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta' },
    { type: 'message_stop' },
  ]);
});

test('fragments of a tool call are one tool_use block of input deltas', () => {
  const write = writer(false);
  expect([
    ...write({
      type: 'tool_call',
      id: 'toolu_01',
      name: 'get_weather',
      arguments: '',
    }),
    ...write({ type: 'tool_call', id: 'toolu_01', arguments: '{"location":' }),
    ...write({ type: 'tool_call', id: 'toolu_01', arguments: ' "Paris"}' }),
    ...write({
      type: 'tool_call',
      id: 'srvtoolu_01',
      name: 'web_search',
      arguments: '{}',
      hosted: true,
    }),
    ...write({ type: 'finish', reason: 'tool_calls' }),
  ]).toEqual([
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_01',
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
      delta: { type: 'input_json_delta', partial_json: ' "Paris"}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'server_tool_use',
        id: 'srvtoolu_01',
        name: 'web_search',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{}' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]);
});

test('a citation is a delta on the text it annotates', () => {
  const location = {
    type: 'char_location',
    cited_text: 'The grass is green.',
    document_index: 0,
    document_title: 'Facts',
    start_char_index: 0,
    end_char_index: 19,
  };
  const write = writer(false);
  expect([
    ...write({ type: 'text', text: 'Green.', block: 0 }),
    ...write({ type: 'citation', block: 0, provider: { anthropic: location } }),
  ]).toMatchObject([
    { type: 'content_block_start', index: 0 },
    { delta: { type: 'text_delta', text: 'Green.' } },
    { index: 0, delta: { type: 'citations_delta', citation: location } },
  ]);
});

test("another family's citation has no form here and is left out", () => {
  const write = writer(false);
  write({ type: 'text', text: 'Green.', block: 0 });
  expect(
    write({
      type: 'citation',
      block: 0,
      url: 'https://example.com/a',
      title: 'A page',
      text: 'Quoted.',
    }),
  ).toEqual([]);
  expect(
    write({
      type: 'citation',
      block: 0,
      url: 'https://example.com/a',
      provider: { 'openai.responses': { type: 'url_citation' } },
    }),
  ).toEqual([]);
});

test('redacted thinking goes out as the block it came as', () => {
  const redacted = { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' };
  const write = writer(false);
  expect([
    ...write({
      type: 'reasoning',
      text: '',
      block: 0,
      provider: { anthropic: redacted },
    }),
    ...write({ type: 'text', text: 'Yes', block: 1 }),
  ]).toEqual([
    { type: 'content_block_start', index: 0, content_block: redacted },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Yes' },
    },
  ]);
});

test("a block of this family goes out whole; another family's does not", () => {
  const redacted = { type: 'compaction', content: 'Summary so far' };
  const write = writer(false);
  expect([
    ...write({ type: 'provider', provider: { anthropic: redacted } }),
    ...write({ type: 'provider', provider: { 'openai.responses': { a: 1 } } }),
    ...write({ type: 'tool_result', id: 'ws_1', output: 'x', hosted: true }),
    ...write({ type: 'file', url: 'https://example.com/out.png' }),
    ...write({ type: 'refusal', text: 'I cannot help with that.' }),
  ]).toEqual([
    { type: 'content_block_start', index: 0, content_block: redacted },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'I cannot help with that.' },
    },
  ]);
});

test("a text answer is written in this API's event sequence", async () => {
  const events = await written([
    { type: 'text', text: 'Hello', block: 0 },
    { type: 'text', text: ' there', block: 0 },
    { type: 'finish', reason: 'stop', usage: { input: 25, output: 15 } },
  ]);
  expect(events.map(({ event }) => event)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  expect(events.map(({ data }) => parsed(data))).toEqual([
    {
      type: 'message_start',
      message: {
        id: 'msg_req_1',
        type: 'message',
        role: 'assistant',
        model: 'coder',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
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
      delta: { type: 'text_delta', text: 'Hello' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' there' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 25, output_tokens: 15 },
    },
    { type: 'message_stop' },
  ]);
});

test('the finish carries the stop sequence and the usage with cache counts', () => {
  expect(
    writer(false)({
      type: 'finish',
      reason: 'stop',
      rawReason: 'stop_sequence',
      usage: { input: 1300, output: 9, cached: 1200, cacheWrite: 50 },
      provider: { anthropic: { stop_sequence: 'END' } },
    }),
  ).toEqual([
    {
      type: 'message_delta',
      delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' },
      usage: {
        input_tokens: 50,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 1200,
        output_tokens: 9,
      },
    },
    { type: 'message_stop' },
  ]);
});

test('a failure after the stream began ends it with an error event', async () => {
  const events = await written([
    { type: 'text', text: 'Hel', block: 0 },
    {
      type: 'error',
      error: {
        code: 'overloaded',
        status: 529,
        message: 'The upstream is overloaded',
        upstream: true,
      },
    },
  ]);
  expect(events.at(-1)).toEqual({
    event: 'error',
    data: JSON.stringify({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'The upstream is overloaded',
      },
    }),
  });
  expect(events.map(({ event }) => event)).not.toContain('message_stop');
});

test('fragments of calls that take turns are one block for each call', () => {
  const write = writer(false);
  expect([
    ...write({ type: 'tool_call', id: 'a', name: 'f', arguments: '{"x":' }),
    ...write({ type: 'tool_call', id: 'b', name: 'g', arguments: '{"y":' }),
    ...write({ type: 'tool_call', id: 'a', arguments: '1}' }),
    ...write({ type: 'tool_call', id: 'b', arguments: '2}' }),
    ...write({ type: 'finish', reason: 'tool_calls' }),
  ]).toEqual([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'a', name: 'f', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"x":' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '1}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'b', name: 'g', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"y":2}' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]);
});

test('three calls taking turns wait for the first, then go out in order', () => {
  const write = writer(false);
  const types = [
    ...write({ type: 'tool_call', id: 'a', name: 'f', arguments: '{"x":1}' }),
    ...write({ type: 'tool_call', id: 'b', name: 'g', arguments: '{' }),
    ...write({ type: 'tool_call', id: 'c', name: 'h', arguments: '{}' }),
    ...write({ type: 'tool_call', id: 'b', arguments: '}' }),
    ...write({ type: 'text', text: 'Done.' }),
  ].map(({ type, index, content_block: block }) => [type, index, block]);
  expect(types.filter(([type]) => type === 'content_block_start')).toEqual([
    [
      'content_block_start',
      0,
      { type: 'tool_use', id: 'a', name: 'f', input: {} },
    ],
    [
      'content_block_start',
      1,
      { type: 'tool_use', id: 'b', name: 'g', input: {} },
    ],
    [
      'content_block_start',
      2,
      { type: 'tool_use', id: 'c', name: 'h', input: {} },
    ],
    ['content_block_start', 3, { type: 'text', text: '' }],
  ]);
});

test('a call that follows one whose input is whole streams at once', () => {
  const write = writer(false);
  write({ type: 'tool_call', id: 'a', name: 'f', arguments: '{"x":1}' });
  expect(
    write({ type: 'tool_call', id: 'b', name: 'g', arguments: '{"y":' }),
  ).toEqual([
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'b', name: 'g', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"y":' },
    },
  ]);
});

test('a fragment that comes after its block ended opens no second block', () => {
  const write = writer(false);
  write({ type: 'tool_call', id: 'a', name: 'f', arguments: '{"x":' });
  write({ type: 'text', text: 'Wait.' });
  expect(write({ type: 'tool_call', id: 'a', arguments: '1}' })).toEqual([]);
});

test('text with nothing in it opens no block', () => {
  const write = writer(false);
  expect([
    ...write({ type: 'text', text: '', block: 0 }),
    ...write({ type: 'refusal', text: '' }),
    ...write({ type: 'finish', reason: 'stop' }),
  ]).toMatchObject([{ type: 'message_delta' }, { type: 'message_stop' }]);
});

test('the reasoning count is written with the usage', () => {
  expect(
    writer(false)({
      type: 'finish',
      reason: 'stop',
      usage: { input: 10, output: 503, reasoning: 480 },
    }),
  ).toMatchObject([
    {
      usage: {
        input_tokens: 10,
        output_tokens: 503,
        output_tokens_details: { thinking_tokens: 480 },
      },
    },
    { type: 'message_stop' },
  ]);
});
