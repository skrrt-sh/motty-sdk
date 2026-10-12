import { expect, test } from 'bun:test';
import { collected } from '../../src/messages/message.ts';
import { writer } from '../../src/messages/reply.ts';

test('a collected answer is one message with every block assembled', () => {
  const location = {
    type: 'char_location',
    cited_text: 'The grass is green.',
    document_index: 0,
    document_title: 'Facts',
    start_char_index: 0,
    end_char_index: 19,
  };
  expect(
    collected(
      [
        { type: 'progress', piece: 0, text: 'Routing' },
        { type: 'progress', piece: 0, text: ' to smart' },
        { type: 'reasoning', text: 'Let me ', block: 0 },
        { type: 'reasoning', text: 'see.', block: 0 },
        {
          type: 'reasoning',
          text: '',
          block: 0,
          provider: { anthropic: { signature: 'EqQBCgIYAhIM' } },
        },
        {
          type: 'provider',
          block: 1,
          provider: { anthropic: { type: 'redacted_thinking', data: 'Emw' } },
        },
        { type: 'text', text: 'Green', block: 2 },
        { type: 'text', text: '.', block: 2 },
        { type: 'citation', block: 2, provider: { anthropic: location } },
        {
          type: 'tool_call',
          id: 'toolu_01',
          name: 'get_weather',
          arguments: '',
          block: 3,
        },
        {
          type: 'tool_call',
          id: 'toolu_01',
          arguments: '{"location":',
          block: 3,
        },
        { type: 'tool_call', id: 'toolu_01', arguments: '"Paris"}', block: 3 },
        {
          type: 'tool_call',
          id: 'toolu_02',
          name: 'get_time',
          arguments: '',
          block: 4,
        },
      ],
      {
        type: 'finish',
        reason: 'tool_calls',
        usage: { input: 472, output: 89, cached: 400 },
      },
      'req_1',
      'coder',
      true,
    ),
  ).toEqual({
    id: 'msg_req_1',
    type: 'message',
    role: 'assistant',
    model: 'coder',
    content: [
      { type: 'thinking', thinking: 'Routing to smart', signature: '' },
      { type: 'thinking', thinking: 'Let me see.', signature: 'EqQBCgIYAhIM' },
      { type: 'redacted_thinking', data: 'Emw' },
      { type: 'text', text: 'Green.', citations: [location] },
      {
        type: 'tool_use',
        id: 'toolu_01',
        name: 'get_weather',
        input: { location: 'Paris' },
      },
      { type: 'tool_use', id: 'toolu_02', name: 'get_time', input: {} },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 72,
      cache_read_input_tokens: 400,
      output_tokens: 89,
    },
  });
});

test('an answer with nothing in it is an empty message', () => {
  expect(
    collected([], { type: 'finish', reason: 'stop' }, 'req_2', 'coder', false),
  ).toEqual({
    id: 'msg_req_2',
    type: 'message',
    role: 'assistant',
    model: 'coder',
    content: [],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
});

test('arguments that are not a JSON object are kept as the text they were', () => {
  for (const raw of ['{"a":', '[1]', '"x"']) {
    expect(
      collected(
        [{ type: 'tool_call', id: 'toolu_01', name: 'get', arguments: raw }],
        { type: 'finish', reason: 'length' },
        'req_3',
        'coder',
        false,
      ),
    ).toMatchObject({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'get',
          input: { INVALID_JSON: raw },
        },
      ],
      stop_reason: 'max_tokens',
    });
  }
});

test('the whole reply holds the same input text the stream sends', () => {
  const call = {
    type: 'tool_call',
    id: 'toolu_01',
    name: 'get',
    arguments: '{"a":',
  } as const;
  const { content } = collected(
    [call],
    { type: 'finish', reason: 'length' },
    'req_3',
    'coder',
    false,
  );
  expect(writer(false)(call)).toContainEqual({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"a":' },
  });
  expect(content).toEqual([
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'get',
      input: { INVALID_JSON: '{"a":' },
    },
  ]);
});

test('a call with no arguments has an empty input', () => {
  expect(
    collected(
      [{ type: 'tool_call', id: 'toolu_01', name: 'now', arguments: '' }],
      { type: 'finish', reason: 'tool_calls' },
      'req_3',
      'coder',
      false,
    ),
  ).toMatchObject({
    content: [{ type: 'tool_use', id: 'toolu_01', name: 'now', input: {} }],
  });
});

test('calls whose fragments take turns are one block each', () => {
  expect(
    collected(
      [
        { type: 'tool_call', id: 'a', name: 'f', arguments: '{"x":' },
        { type: 'tool_call', id: 'b', name: 'g', arguments: '{"y":' },
        { type: 'tool_call', id: 'a', arguments: '1}' },
        { type: 'tool_call', id: 'b', arguments: '2}' },
      ],
      { type: 'finish', reason: 'tool_calls' },
      'req_4',
      'coder',
      false,
    ),
  ).toHaveProperty('content', [
    { type: 'tool_use', id: 'a', name: 'f', input: { x: 1 } },
    { type: 'tool_use', id: 'b', name: 'g', input: { y: 2 } },
  ]);
});

test('a collected message holds what the ending said of it, in the delta and beside it', () => {
  expect(
    collected(
      [
        {
          type: 'tool_call',
          id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
          name: 'get_weather',
          arguments: '{"location": "Paris"}',
          provider: { anthropic: { caller: { type: 'direct' } } },
        },
      ],
      {
        type: 'finish',
        reason: 'tool_calls',
        rawReason: 'tool_use',
        usage: { input: 25, output: 40 },
        provider: {
          anthropic: {
            container: { id: 'container_011' },
            usage: { service_tier: 'standard' },
            message_delta: { context_management: { applied_edits: [] } },
          },
        },
      },
      'req_1',
      'coder',
      false,
    ),
  ).toEqual({
    id: 'msg_req_1',
    type: 'message',
    role: 'assistant',
    model: 'coder',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
        name: 'get_weather',
        input: { location: 'Paris' },
        caller: { type: 'direct' },
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    container: { id: 'container_011' },
    context_management: { applied_edits: [] },
    usage: { input_tokens: 25, output_tokens: 40, service_tier: 'standard' },
  });
});

test("a collected message's own fields are never replaced by what rides on the finish", () => {
  expect(
    collected(
      [{ type: 'text', text: 'Hello', block: 0 }],
      {
        type: 'finish',
        reason: 'stop',
        rawReason: 'end_turn',
        usage: { input: 25, output: 40 },
        provider: {
          anthropic: {
            id: 'msg_other',
            type: 'x',
            role: 'user',
            model: 'other',
            content: 'gone',
            container: { id: 'container_011' },
            message_delta: {
              id: 'msg_other',
              type: 'x',
              role: 'user',
              model: 'other',
              content: 'gone',
              context_management: { applied_edits: [] },
            },
          },
        },
      },
      'req_1',
      'coder',
      false,
    ),
  ).toEqual({
    id: 'msg_req_1',
    type: 'message',
    role: 'assistant',
    model: 'coder',
    content: [{ type: 'text', text: 'Hello' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    container: { id: 'container_011' },
    context_management: { applied_edits: [] },
    usage: { input_tokens: 25, output_tokens: 40 },
  });
});
