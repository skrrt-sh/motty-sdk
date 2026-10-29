import { expect, test } from 'bun:test';
import { chatCompletions, messages, responses } from '../src/index.ts';

async function* sse(...sent: { type: string; [field: string]: unknown }[]) {
  for (const event of sent) {
    yield { event: event.type, data: JSON.stringify(event) };
  }
}

test.each([
  [
    'the Responses API, with its namespace',
    responses,
    {
      model: 'model-x',
      input: [
        { type: 'message', role: 'user', content: 'What time is it in Oslo?' },
        {
          namespace: 'time',
          call_id: 'call_1',
          name: 'now',
          type: 'function_call',
          arguments: '{"city":"Oslo"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: '12:00' },
      ],
      store: false,
      stream: true,
    },
  ],
  [
    'Chat Completions, under a flat name',
    chatCompletions,
    {
      model: 'model-x',
      messages: [
        { role: 'user', content: 'What time is it in Oslo?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'time__now', arguments: '{"city":"Oslo"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '12:00' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
  ],
])(
  'a call in a namespace a Responses caller echoed goes on to %s',
  (_, codec, sent) => {
    const { request } = responses.decode(
      {
        model: 'coder',
        input: [
          {
            type: 'message',
            role: 'user',
            content: 'What time is it in Oslo?',
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            namespace: 'time',
            name: 'now',
            arguments: '{"city":"Oslo"}',
          },
          { type: 'function_call_output', call_id: 'call_1', output: '12:00' },
        ],
      },
      new Headers(),
    );

    const { body, leftOut } = codec.encode('model-x', {
      messages: request.messages,
    });

    expect(body).toEqual(sent);
    expect(leftOut).toEqual([]);
  },
);

test.each([
  [
    'Chat Completions as a custom call',
    chatCompletions,
    {
      model: 'model-x',
      messages: [
        { role: 'user', content: 'List the files.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_2',
              type: 'custom',
              custom: { name: 'shell', input: 'ls -la' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_2', content: 'a.txt' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
  ],
])(
  'a call with free text for input a Responses caller echoed goes on to %s',
  (_, codec, sent) => {
    const { request } = responses.decode(
      {
        model: 'coder',
        input: [
          { type: 'message', role: 'user', content: 'List the files.' },
          {
            type: 'custom_tool_call',
            call_id: 'call_2',
            name: 'shell',
            input: 'ls -la',
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_2',
            output: 'a.txt',
          },
        ],
      },
      new Headers(),
    );

    const { body, leftOut } = codec.encode('model-x', {
      messages: request.messages,
    });

    expect(body).toEqual(sent);
    expect(leftOut).toEqual([]);
  },
);

test('a call with free text for input a Responses caller echoed goes on to Anthropic Messages as the one field of an object', () => {
  const { request } = responses.decode(
    {
      model: 'coder',
      input: [
        { type: 'message', role: 'user', content: 'List the files.' },
        {
          type: 'custom_tool_call',
          call_id: 'call_2',
          name: 'shell',
          input: 'ls -la',
        },
        { type: 'custom_tool_call_output', call_id: 'call_2', output: 'a.txt' },
      ],
    },
    new Headers(),
  );

  expect(
    messages.encode('model-x', { messages: request.messages }).body,
  ).toMatchObject({
    messages: [
      { role: 'user', content: 'List the files.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_2',
            name: 'shell',
            input: { input: 'ls -la' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_2', content: 'a.txt' },
        ],
      },
    ],
  });
});

test.each([
  [
    'Chat Completions, with its extra content',
    chatCompletions,
    {
      model: 'model-x',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              extra_content: { google: { thought_signature: 'CsQB' } },
              id: 'call_3',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_3', content: '15C' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
  ],
  [
    'Anthropic Messages, with no extra content',
    messages,
    {
      max_tokens: 64000,
      model: 'model-x',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_3',
              name: 'get_weather',
              input: { location: 'Paris' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_3', content: '15C' },
          ],
        },
      ],
      stream: true,
    },
  ],
])(
  'a call with extra content a Chat Completions caller echoed goes on to %s',
  (_, codec, sent) => {
    const { request } = chatCompletions.decode(
      {
        model: 'coder',
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_3',
                type: 'function',
                function: {
                  name: 'get_weather',
                  arguments: '{"location":"Paris"}',
                },
                extra_content: { google: { thought_signature: 'CsQB' } },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_3', content: '15C' },
        ],
      },
      new Headers(),
    );

    const { body, leftOut } = codec.encode('model-x', {
      messages: request.messages,
    });

    expect(body).toEqual(sent);
    expect(leftOut).toEqual([]);
  },
);

test.each([
  [
    'Chat Completions, with no caller',
    chatCompletions,
    {
      model: 'model-x',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'toolu_01',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"location":"Paris"}',
              },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'toolu_01', content: '15C' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
  ],
  [
    'Anthropic Messages, with its caller',
    messages,
    {
      max_tokens: 64000,
      model: 'model-x',
      messages: [
        { role: 'user', content: 'Weather in Paris?' },
        {
          role: 'assistant',
          content: [
            {
              caller: { type: 'direct' },
              type: 'tool_use',
              id: 'toolu_01',
              name: 'get_weather',
              input: { location: 'Paris' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: '15C' },
          ],
        },
      ],
      stream: true,
    },
  ],
])(
  'a call with a caller an Anthropic Messages caller echoed goes on to %s',
  (_, codec, sent) => {
    const { request } = messages.decode(
      {
        model: 'coder',
        max_tokens: 64,
        messages: [
          { role: 'user', content: 'Weather in Paris?' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'get_weather',
                input: { location: 'Paris' },
                caller: { type: 'direct' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_01', content: '15C' },
            ],
          },
        ],
      },
      new Headers(),
    );

    const { body, leftOut } = codec.encode('model-x', {
      messages: request.messages,
    });

    expect(body).toEqual(sent);
    expect(leftOut).toEqual([]);
  },
);

// Chat Completions writes the empty text as a content delta of no text.
test('a phase a Responses upstream tells only as its message ends adds no empty content for a Chat Completions caller', async () => {
  const { streamed } = chatCompletions.decode(
    {
      model: 'coder',
      stream: true,
      messages: [{ role: 'user', content: 'Go' }],
    },
    new Headers(),
  );

  const sent = await Array.fromAsync(
    streamed(
      responses.events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', content: [] },
          },
          {
            type: 'response.output_text.delta',
            output_index: 0,
            delta: 'Done',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'Done', annotations: [] }],
            },
          },
          { type: 'response.completed', response: {} },
        ),
      ),
      'req_1',
    ),
  );

  expect(
    sent.map(({ data }) => (data === '[DONE]' ? data : JSON.parse(data))),
  ).toEqual([
    {
      id: 'chatcmpl-req_1',
      object: 'chat.completion.chunk',
      created: expect.any(Number),
      model: 'coder',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'Done' },
          logprobs: null,
          finish_reason: null,
        },
      ],
    },
    {
      id: 'chatcmpl-req_1',
      object: 'chat.completion.chunk',
      created: expect.any(Number),
      model: 'coder',
      choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }],
    },
    '[DONE]',
  ]);
});

test('a phase a Responses upstream tells only as its message ends adds no empty text block for an Anthropic Messages caller', async () => {
  const { streamed } = messages.decode(
    {
      model: 'coder',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Go' }],
    },
    new Headers(),
  );

  const sent = await Array.fromAsync(
    streamed(
      responses.events(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', content: [] },
          },
          {
            type: 'response.output_text.delta',
            output_index: 0,
            delta: 'Done',
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'Done', annotations: [] }],
            },
          },
          { type: 'response.completed', response: {} },
        ),
      ),
      'req_1',
    ),
  );

  expect(sent.map(({ data }) => JSON.parse(data))).toEqual([
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
      delta: { type: 'text_delta', text: 'Done' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_sequence: null, stop_reason: 'end_turn' },
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: 'message_stop' },
  ]);
});
