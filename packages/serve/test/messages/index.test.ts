import { expect, test } from 'bun:test';
import type { Json, Progress, StreamEvent } from '@mottyjs/core/host';
import { chatCompletions } from '../../src/chat-completions/index.ts';
import type { Decoded } from '../../src/codec.ts';
import { messages } from '../../src/messages/index.ts';
import { responses } from '../../src/responses/index.ts';
import { dict, list, parsed, text } from '../../src/wire/json.ts';

async function answered(decoded: Decoded, wire: Json[], stream: boolean) {
  async function* upstream() {
    for (const event of wire) yield { data: JSON.stringify(event) };
  }
  const events: (StreamEvent | Progress)[] = await Array.fromAsync(
    messages.events(upstream()),
  );
  if (stream) {
    async function* run() {
      yield* events;
    }
    const sent = await Array.fromAsync(decoded.streamed(run(), 'req_1'));
    return sent.map(({ data }) => parsed(data) ?? null);
  }
  const chunks = events.flatMap((event) =>
    event.type === 'finish' || event.type === 'error' ? [] : [event],
  );
  const finish = events.flatMap((event) =>
    event.type === 'finish' ? [event] : [],
  )[0] ?? { type: 'finish', reason: 'other' };
  return [decoded.collected(chunks, finish, 'req_1')];
}

function reply(wire: Json[], stream: boolean, thinking: Json) {
  return answered(
    messages.decode(
      {
        model: 'claude-opus-5-5',
        max_tokens: 1024,
        thinking,
        messages: [{ role: 'user', content: 'Hi' }],
      },
      new Headers(),
    ),
    wire,
    stream,
  );
}

// As the upstream streams a call of a tool that takes nothing.
function timeAsked(decoded: Decoded, stream: boolean) {
  return answered(
    decoded,
    [
      {
        type: 'message_start',
        message: {
          id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
          model: 'claude-haiku-5-5',
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
          name: 'get_time',
          input: {},
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 12 },
      },
      { type: 'message_stop' },
    ],
    stream,
  );
}

test('the codec serves the Messages path', () => {
  expect(messages.paths).toEqual(['/v1/messages']);
});

test('a request of this family reaches the upstream with the same meaning', () => {
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    system: [
      { type: 'text', text: 'You are a careful analyst.' },
      {
        type: 'text',
        text: '<the whole report>',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: 'JVBERi0xLjQ=',
            },
            title: 'Report',
            citations: { enabled: true },
          },
          {
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: 'Notes.' },
          },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/chart.png' },
          },
          { type: 'text', text: 'Did revenue grow?' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Check page two.',
            signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pk',
          },
          { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' },
          {
            type: 'text',
            text: 'It grew.',
            citations: [
              {
                type: 'page_location',
                cited_text: 'Revenue grew 12%.',
                document_index: 0,
                document_title: 'Report',
                start_page_number: 2,
                end_page_number: 3,
              },
            ],
          },
          {
            type: 'tool_use',
            id: 'toolu_01A09q90qw90lq917835lq9',
            name: 'get_quarter',
            input: { quarter: 'Q3' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01A09q90qw90lq917835lq9',
            content: [{ type: 'text', text: '12%' }],
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
      { role: 'system', content: 'Terse mode enabled.' },
    ],
    tools: [
      {
        name: 'get_quarter',
        description: 'Figures for one quarter',
        input_schema: {
          type: 'object',
          properties: { quarter: { type: 'string' } },
          required: ['quarter'],
          additionalProperties: false,
        },
        strict: true,
        eager_input_streaming: true,
      },
      { type: 'web_search_20260209', name: 'web_search', max_uses: 2 },
    ],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    stop_sequences: ['END'],
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: {
      effort: 'high',
      task_budget: { type: 'tokens', total: 64000 },
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { grew: { type: 'boolean' } } },
      },
    },
    metadata: { user_id: 'user-13803d75' },
    context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] },
    service_tier: 'auto',
    stream: true,
  };
  const { request } = messages.decode(
    body,
    new Headers({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'context-management-2025-06-27',
      'x-api-key': 'sk-ant-callers-own',
    }),
  );
  const sent = messages.encode('claude-opus-5-5', request);
  expect(sent.body).toEqual(body);
  // Of the caller's headers only its betas are sent on, never its key: a
  // field of the body means nothing without the beta that turns it on.
  expect(sent.headers).toEqual({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'context-management-2025-06-27',
  });
});

test('each thinking setting is sent upstream as the caller set it', () => {
  for (const settings of [
    {},
    { thinking: { type: 'disabled' } },
    { thinking: { type: 'disabled' }, output_config: { effort: 'low' } },
    { thinking: { type: 'enabled', budget_tokens: 10000 } },
    { thinking: { type: 'enabled', budget_tokens: 2048, display: 'omitted' } },
    { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } },
    { thinking: { type: 'adaptive', display: 'omitted' } },
    {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    },
    {
      thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
      output_config: { effort: 'high' },
    },
    {
      thinking: { type: 'between_tools' },
      output_config: { effort: 'medium' },
    },
    { output_config: { effort: 'xhigh' } },
  ]) {
    const body = {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'Hi' }],
      ...settings,
    };
    const { request } = messages.decode(body, new Headers());
    expect(messages.encode('claude-opus-5-5', request).body).toEqual({
      ...body,
      stream: true,
    });
  }
});

test('progress a caller sends back never reaches the upstream', () => {
  const { request } = messages.decode(
    {
      model: 'coder',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Routing to the fast model.',
              signature: '',
            },
            { type: 'text', text: 'Hello.' },
          ],
        },
        { role: 'user', content: 'More' },
      ],
    },
    new Headers(),
  );

  expect(messages.encode('claude-opus-5-5', request).body).toMatchObject({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
      { role: 'user', content: 'More' },
    ],
  });
});

test('reasoning of another family is a thinking block nobody signed, left out and reported when sent back', async () => {
  const thinking =
    'We need to compute 17 * 23. Let me think briefly: 17*20 = 340, plus 17*3 = 51, total 391.';
  const asked = {
    model: 'relay',
    max_tokens: 400,
    thinking: { type: 'enabled', budget_tokens: 1024 },
  };
  const question = { role: 'user', content: 'What is 17*23?' };
  const reply = messages
    .decode({ ...asked, messages: [question] }, new Headers())
    .collected(
      [
        { type: 'reasoning', text: thinking },
        { type: 'text', text: '391' },
      ],
      { type: 'finish', reason: 'stop', usage: { input: 20, output: 68 } },
      'req_1',
    );
  expect(reply).toMatchObject({
    content: [
      { type: 'thinking', thinking, signature: '' },
      { type: 'text', text: '391' },
    ],
  });

  for (const echoed of [
    { type: 'thinking', thinking, signature: '' },
    { type: 'thinking', thinking },
  ]) {
    const { model: _, ...request } = messages.decode(
      {
        ...asked,
        messages: [
          question,
          {
            role: 'assistant',
            content: [echoed, { type: 'text', text: '391' }],
          },
          { role: 'user', content: 'And 18*23?' },
        ],
      },
      new Headers(),
    ).request;
    const { body, leftOut } = messages.encode('claude-haiku-5-5', request);
    expect(body).toMatchObject({
      messages: [
        question,
        { role: 'assistant', content: [{ type: 'text', text: '391' }] },
        { role: 'user', content: 'And 18*23?' },
      ],
    });
    expect(leftOut).toEqual([
      {
        setting: 'reasoning',
        detail: 'Anthropic Messages has no field for reasoning it did not sign',
      },
    ]);
  }
});

test('a reply of this family reaches the caller as the upstream sent it', async () => {
  const content = [
    {
      type: 'thinking',
      thinking: 'Check the weather tool.',
      signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pk',
    },
    { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' },
    {
      type: 'text',
      text: 'It is sunny.',
      citations: [
        {
          type: 'web_search_result_location',
          url: 'https://example.com/weather',
          title: 'Weather',
          cited_text: 'Sunny all day.',
          encrypted_index: 'Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm',
        },
      ],
    },
    {
      type: 'tool_use',
      id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
      name: 'get_weather',
      input: { location: 'San Francisco, CA' },
    },
  ];

  const usage = {
    input_tokens: 25,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 2000,
    output_tokens: 89,
  };

  const wire: Json[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_req_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Check the weather tool.' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'signature_delta',
        signature: 'EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pk',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'redacted_thinking', data: 'EmwKAhgBEgy3va3pzix' },
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
      delta: { type: 'text_delta', text: 'It is sunny.' },
    },
    {
      type: 'content_block_delta',
      index: 2,
      delta: {
        type: 'citations_delta',
        citation: content[2]?.citations?.[0] ?? null,
      },
    },
    { type: 'content_block_stop', index: 2 },
    {
      type: 'content_block_start',
      index: 3,
      content_block: {
        type: 'tool_use',
        id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
        name: 'get_weather',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: { type: 'input_json_delta', partial_json: '{"location":' },
    },
    {
      type: 'content_block_delta',
      index: 3,
      delta: {
        type: 'input_json_delta',
        partial_json: ' "San Francisco, CA"}',
      },
    },
    { type: 'content_block_stop', index: 3 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage,
    },
    { type: 'message_stop' },
  ];
  expect(await reply(wire, true, { type: 'adaptive' })).toEqual(wire);
  expect(await reply(wire, false, { type: 'adaptive' })).toEqual([
    {
      id: 'msg_req_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content,
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage,
    },
  ]);
});

test('a failure inside the upstream stream reaches the caller as an error event', async () => {
  const sent = await reply(
    [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'It is' },
      },
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      },
    ],
    true,
    null,
  );
  expect(sent.at(-1)).toEqual({
    type: 'error',
    error: { type: 'overloaded_error', message: 'Overloaded' },
  });
});

test('a block the codec passes whole that a failing upstream never ended reaches the caller, and then the failure', async () => {
  const sent = await reply(
    [
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
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      },
    ],
    true,
    null,
  );
  expect(sent.slice(1)).toEqual([
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'mcp_tool_use',
        id: 'mcptoolu_014Q35RayjACSWkSj4X2yov1',
        name: 'echo',
        server_name: 'example-mcp',
        input: { INVALID_JSON: '{"param1":' },
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    },
  ]);
});

test("a first-event failure is answered as this API's error body", () => {
  const facts = messages.failure(
    529,
    new Headers({ 'retry-after': '3' }),
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  );
  expect(facts).toMatchObject({ code: 'overloaded', retryAfter: 3000 });
  expect(facts).not.toHaveProperty('status');
  expect(messages.error(facts)).toEqual({
    status: 529,
    body: {
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'Overloaded',
      },
    },
  });
});

test('what the adapter cuts is cut from a failed response and from a failure in a stream, the request`s id included', async () => {
  const cut = (text: string) => text.replaceAll('hunter2-hunter2', '[cut]');
  const told = {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: `${'Long. '.repeat(332)}hunter2-hunter2`,
      'hunter2-hunter2': `${'x'.repeat(292)} hunter2-hunter2`,
    },
    request_id: 'req_hunter2-hunter2',
  };
  const cleaned = {
    code: 'invalid_request',
    message: `${'Long. '.repeat(332)}[cut]`,
    provider: {
      anthropic: {
        request_id: 'req_[cut]',
        type: 'invalid_request_error',
        '[cut]': `${'x'.repeat(292)} [cut]`,
      },
    },
  };

  expect(
    messages.failure(400, new Headers(), JSON.stringify(told), cut),
  ).toMatchObject(cleaned);
  expect(
    await Array.fromAsync(
      messages.events(
        (async function* () {
          yield { data: JSON.stringify(told) };
        })(),
        cut,
      ),
    ),
  ).toMatchObject([{ type: 'error', error: cleaned }]);
});

test.each([false, true])(
  'a call with no arguments reaches a Chat Completions caller as an empty object, which goes back upstream (stream %p)',
  async (stream) => {
    const sent = await timeAsked(
      chatCompletions.decode(
        {
          model: 'coder',
          stream,
          messages: [{ role: 'user', content: 'What time is it?' }],
        },
        new Headers(),
      ),
      stream,
    );
    const written = sent
      .flatMap((frame) => {
        const { choices } = dict(frame);
        const { message, delta } = dict(list(choices)[0]);
        const { tool_calls: calls } = dict(stream ? delta : message);
        return list(calls).map((call) => {
          const { function: named } = dict(call);
          const { arguments: said } = dict(named);
          return text(said);
        });
      })
      .join('');
    expect(written).toBe('{}');

    const { request } = chatCompletions.decode(
      {
        model: 'coder',
        messages: [
          { role: 'user', content: 'What time is it?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
                type: 'function',
                function: { name: 'get_time', arguments: written },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
            content: '12:04',
          },
        ],
      },
      new Headers(),
    );
    const { messages: turns } = dict(
      messages.encode('claude-haiku-5-5', request).body,
    );
    expect(list(turns)[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
          name: 'get_time',
          input: {},
        },
      ],
    });
  },
);

test.each([false, true])(
  'a call with no arguments reaches a Responses caller as an empty object, which goes back upstream (stream %p)',
  async (stream) => {
    const sent = await timeAsked(
      responses.decode(
        { model: 'coder', stream, input: 'What time is it?' },
        new Headers(),
      ),
      stream,
    );
    const { response, ...whole } = dict(sent.at(-1));
    const { output } = dict(stream ? response : whole);
    const [call] = list(output);
    const { arguments: written } = dict(call);
    expect(written).toBe('{}');
    if (stream) {
      expect(sent).toContainEqual(
        expect.objectContaining({
          type: 'response.function_call_arguments.done',
          arguments: '{}',
        }),
      );
    }

    const { request } = responses.decode(
      {
        model: 'coder',
        input: [
          { role: 'user', content: 'What time is it?' },
          call ?? null,
          {
            type: 'function_call_output',
            call_id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
            output: '12:04',
          },
        ],
      },
      new Headers(),
    );
    const { messages: turns } = dict(
      messages.encode('claude-haiku-5-5', request).body,
    );
    expect(list(turns)[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
          name: 'get_time',
          input: {},
        },
      ],
    });
  },
);

test.each([
  [
    'Chat Completions',
    chatCompletions,
    {
      messages: [
        { role: 'user', content: 'What time is it?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_time', arguments: '' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '12:04' },
      ],
    },
  ],
  [
    'Responses',
    responses,
    {
      input: [
        { role: 'user', content: 'What time is it?' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'get_time',
          arguments: '',
        },
        { type: 'function_call_output', call_id: 'call_1', output: '12:04' },
      ],
    },
  ],
])(
  'arguments a %s caller sends back empty are the input of a tool that takes none',
  (_, codec, echoed) => {
    const { request } = codec.decode(
      { model: 'coder', ...echoed },
      new Headers(),
    );
    const { messages: sent } = dict(
      messages.encode('claude-haiku-5-5', request).body,
    );
    const { content } = dict(list(sent)[1]);
    expect(content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'get_time', input: {} },
    ]);
  },
);

test('what an upstream of this family says that the codec does not read reaches the caller', async () => {
  const container = { id: 'container_011', expires_at: '2026-10-12T10:00:00Z' };
  const block = {
    type: 'tool_use',
    id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
    name: 'get_weather',
    caller: { type: 'direct' },
    future_block_field: { kept: true },
  };
  const wire: Json[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5-20260901',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        container: null,
        future_message_field: 'kept',
        usage: {
          input_tokens: 25,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 2000,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 100,
          },
          output_tokens: 1,
          service_tier: 'standard',
          inference_geo: 'us',
        },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { ...block, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"location": "Paris"}',
      },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'tool_use',
        stop_sequence: null,
        container,
        future_delta_field: 'kept',
      },
      usage: {
        output_tokens: 89,
        server_tool_use: { web_search_requests: 1 },
        future_count: 3,
      },
      context_management: { applied_edits: [] },
      future_event_field: 'kept',
    },
    { type: 'message_stop' },
  ];
  const usage = {
    input_tokens: 25,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 2000,
    cache_creation: {
      ephemeral_5m_input_tokens: 0,
      ephemeral_1h_input_tokens: 100,
    },
    output_tokens: 89,
    service_tier: 'standard',
    inference_geo: 'us',
    server_tool_use: { web_search_requests: 1 },
    future_count: 3,
  };
  expect(await reply(wire, true, { type: 'adaptive' })).toEqual([
    {
      type: 'message_start',
      message: {
        id: 'msg_req_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    ...wire.slice(1, 4),
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'tool_use',
        stop_sequence: null,
        container,
        future_delta_field: 'kept',
        future_message_field: 'kept',
      },
      usage,
      context_management: { applied_edits: [] },
      future_event_field: 'kept',
    },
    { type: 'message_stop' },
  ]);
  expect(await reply(wire, false, { type: 'adaptive' })).toEqual([
    {
      id: 'msg_req_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ ...block, input: { location: 'Paris' } }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      container,
      future_delta_field: 'kept',
      future_message_field: 'kept',
      context_management: { applied_edits: [] },
      future_event_field: 'kept',
      usage,
    },
  ]);
});

test('a refusal of this family reaches the caller with its details', async () => {
  const details = { type: 'refusal', category: 'cyber', explanation: null };
  const wire: Json[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_req_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: 'message_delta',
      delta: {
        stop_reason: 'refusal',
        stop_sequence: null,
        stop_details: details,
      },
      usage: { input_tokens: 25, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ];
  expect(await reply(wire, true, { type: 'adaptive' })).toEqual(wire);
  expect(await reply(wire, false, { type: 'adaptive' })).toEqual([
    {
      id: 'msg_req_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: 'refusal',
      stop_sequence: null,
      stop_details: details,
      usage: { input_tokens: 25, output_tokens: 0 },
    },
  ]);
});

test('a block the codec passes whole reaches the caller with what its deltas said', async () => {
  const call = {
    type: 'mcp_tool_use',
    id: 'mcptoolu_014Q35RayjACSWkSj4X2yov1',
    name: 'echo',
    server_name: 'example-mcp',
  };
  const wire: Json[] = [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { ...call, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"param1": "value1"}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'compaction', content: null },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'compaction_delta', content: 'Summary so far' },
    },
    { type: 'content_block_stop', index: 1 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 25, output_tokens: 9 },
    },
    { type: 'message_stop' },
  ];
  const called = { ...call, input: { param1: 'value1' } };
  const compacted = { type: 'compaction', content: 'Summary so far' };
  expect((await reply(wire, true, { type: 'adaptive' })).slice(1, -2)).toEqual([
    { type: 'content_block_start', index: 0, content_block: called },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: compacted },
    { type: 'content_block_stop', index: 1 },
  ]);
  expect(await reply(wire, false, { type: 'adaptive' })).toMatchObject([
    { content: [called, compacted] },
  ]);
});

test('a body field the codec does not read reaches an upstream of this family as it was sent', () => {
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'Weather?' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
            name: 'get_weather',
            input: { location: 'Paris' },
            caller: { type: 'direct' },
            future_block_field: { kept: true },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_01T1x1fJ34qAmk2tNTrN7Up6',
            content: 'Sunny',
            future_block_field: 'kept',
          },
        ],
      },
    ],
    context_management: { edits: [{ type: 'clear_thinking_20251015' }] },
    cache_control: { type: 'ephemeral', ttl: '1h' },
    service_tier: 'standard_only',
    metadata: { user_id: 'user-13803d75' },
    future_body_field: { kept: [1, null, {}] },
    stream: true,
  };
  const { request } = messages.decode(body, new Headers());
  expect(messages.encode('claude-opus-5-5', request).body).toEqual(body);
});

test('every header of this API`s own but its version reaches the upstream, and no other', () => {
  const { request } = messages.decode(
    {
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hi' }],
    },
    new Headers({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'context-management-2025-06-27,compact-2026-01-12',
      'anthropic-dangerous-direct-browser-access': 'true',
      'anthropic-not-known-yet': 'on',
      'x-api-key': 'sk-ant-callers-own',
      authorization: 'Bearer sk-ant-callers-own',
      'x-stainless-lang': 'js',
    }),
  );
  expect(messages.encode('claude-opus-5-5', request).headers).toEqual({
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'context-management-2025-06-27,compact-2026-01-12',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-not-known-yet': 'on',
  });
});
