import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { chatCompletions } from '../../src/chat-completions/index.ts';
import { encode } from '../../src/messages/encode.ts';

test('a prompt is sent as a streamed request with the version header', () => {
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'system', text: 'You are terse.' },
        { role: 'user', text: 'Hello' },
      ],
      options: { maxTokens: 1024 },
    }),
  ).toEqual({
    path: '/messages',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    },
    leftOut: [],
  });
});

test('a prompt with no limit still sends one', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [{ role: 'user', text: 'Hello' }],
  });
  expect(body).toMatchObject({ max_tokens: 64000 });
});

test('leading instructions of any role and shape are system blocks', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'system', text: 'You are terse.' },
      {
        role: 'developer',
        parts: [{ type: 'text', text: 'Answer in French.' }],
        cache: { ttl: '1h' },
      },
      { role: 'user', text: 'Hello' },
    ],
  });
  expect(body).toMatchObject({
    system: [
      { type: 'text', text: 'You are terse.' },
      {
        type: 'text',
        text: 'Answer in French.',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ],
    messages: [{ role: 'user', content: 'Hello' }],
  });
});

test('instructions after the first turn are a system turn in place', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'user', text: 'Hello' },
      { role: 'developer', text: 'Terse mode enabled.' },
    ],
  });
  expect(body).toMatchObject({
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'system', content: 'Terse mode enabled.' },
    ],
  });
  expect(body).not.toHaveProperty('system');
});

test('a tool message of another family is a user turn of results', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'user', text: 'Weather in Paris?' },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'A summary nobody here signed.' },
          { type: 'tool_call', id: 'call_1', name: 'get_weather', input: {} },
        ],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_result', id: 'call_1', text: '15C' }],
      },
    ],
    tools: [
      { type: 'function', name: 'get_weather', input: { type: 'object' } },
    ],
  });
  expect(body).toMatchObject({
    messages: [
      { role: 'user', content: 'Weather in Paris?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_1', name: 'get_weather', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: '15C' },
        ],
      },
    ],
    tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
  });
});

test('a turn left with no block is not sent', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'user', text: 'Hello' },
      { role: 'assistant', parts: [{ type: 'reasoning', text: 'Routing' }] },
      { role: 'user', text: 'Still there?' },
    ],
  });
  expect(body).toMatchObject({
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'user', content: 'Still there?' },
    ],
  });
});

test('a cache marker on a plain message puts its text in a block', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [{ role: 'user', text: 'A long document', cache: {} }],
  });
  expect(body).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'A long document',
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ],
  });
});

test('structured output and reasoning effort are sent in the output config', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [{ role: 'user', text: 'Name a city.' }],
    options: { reasoning: { effort: 'xhigh' } },
    output: {
      schema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  });
  expect(body).toMatchObject({
    output_config: {
      effort: 'xhigh',
      format: {
        type: 'json_schema',
        schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  });
});

test('a meaning-changing entry of another family fails the call', () => {
  const user = { role: 'user', text: 'Hello' } as const;
  expect(() =>
    encode('claude-opus-5-5', {
      messages: [user],
      options: { provider: { 'openai.responses': { store: true } } },
    }),
  ).toThrow(Unsupported);
  expect(() =>
    encode('claude-opus-5-5', {
      messages: [{ ...user, provider: { 'openai.chat': { audio: {} } } }],
    }),
  ).toThrow(Unsupported);
  expect(() =>
    encode('claude-opus-5-5', {
      messages: [user],
      tools: [{ type: 'custom', name: 'shell' }],
    }),
  ).toThrow(Unsupported);
});

test('an instruction between turns is sent where the API takes one', () => {
  const said = { role: 'system', content: 'Be terse.' };
  const result = { type: 'tool_result', tool_use_id: 'toolu_01', content: '1' };
  const searched = {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_01',
    content: [],
  };
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'system', text: 'Be terse.' },
        { role: 'developer', text: 'And kind.' },
        { role: 'assistant', text: 'Hello' },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', id: 'toolu_01', text: '1' }],
        },
        { role: 'system', text: 'Be terse.' },
        {
          role: 'assistant',
          parts: [{ type: 'provider', provider: { anthropic: searched } }],
        },
        { role: 'system', text: 'Be terse.' },
      ],
    }).body,
  ).toMatchObject({
    messages: [
      { role: 'user', content: 'Hi' },
      said,
      { role: 'system', content: 'And kind.' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: [result] },
      said,
      { role: 'assistant', content: [searched] },
      said,
    ],
  });
});

test('an instruction that stands before user turns waits past them', () => {
  const said = { role: 'system', content: 'Be terse.' };
  const call = { type: 'tool_use', id: 'toolu_01', name: 'get', input: {} };
  const result = { type: 'tool_result', tool_use_id: 'toolu_01', content: '1' };
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'assistant', text: 'Hello' },
        { role: 'developer', text: 'Be terse.' },
        { role: 'user', text: 'More' },
        {
          role: 'assistant',
          parts: [
            { type: 'tool_call', id: 'toolu_01', name: 'get', input: {} },
          ],
        },
        { role: 'system', text: 'Be terse.' },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', id: 'toolu_01', text: '1' }],
        },
        { role: 'system', text: 'Be terse.' },
        { role: 'user', text: 'Go' },
      ],
    }).body,
  ).toMatchObject({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'More' },
      said,
      { role: 'assistant', content: [call] },
      { role: 'user', content: [result] },
      { role: 'user', content: 'Go' },
      said,
      said,
    ],
  });
});

test('an instruction moved past a user turn is reported; one sent in place is not', () => {
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'system', text: 'Be terse.' },
        { role: 'user', text: 'Go' },
      ],
    }),
  ).toMatchObject({
    body: {
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'user', content: 'Go' },
        { role: 'system', content: 'Be terse.' },
      ],
    },
    leftOut: [
      {
        setting: 'message.moved',
        detail:
          'Anthropic Messages has no field for an instruction before a user turn, sent after it',
      },
    ],
  });
  expect(
    encode('claude-opus-5-5', {
      messages: [
        { role: 'user', text: 'Hi' },
        { role: 'system', text: 'Be terse.' },
        { role: 'assistant', text: 'Hello' },
        { role: 'user', text: 'Go' },
      ],
    }).leftOut,
  ).toEqual([]);
});

test('an instruction no user turn comes before fails the call', () => {
  const instruction = { role: 'developer', text: 'Be terse.' } as const;
  for (const messages of [
    [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
      instruction,
    ],
    [
      { role: 'user', text: 'Hi' },
      { role: 'assistant', text: 'Hello' },
      instruction,
      { role: 'assistant', text: 'And' },
    ],
    [
      {
        role: 'system',
        text: 'Only this turn.',
        provider: { anthropic: { clear_at: 'next_user_message' } },
      },
      { role: 'assistant', text: 'Hello' },
    ],
  ] as const) {
    expect(() => encode('claude-opus-5-5', { messages })).toThrow(Unsupported);
  }
});

test("an instruction's own fields are sent, and alone they go anywhere", () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'system', text: 'You are terse.' },
      {
        role: 'system',
        parts: [],
        hints: { anthropic: { output_config: { effort: 'low' } } },
      },
      { role: 'user', text: 'Hi' },
      {
        role: 'system',
        text: 'Only this turn.',
        provider: { anthropic: { clear_at: 'next_user_message' } },
      },
      { role: 'assistant', text: 'Hello' },
      {
        role: 'system',
        text: '',
        hints: { anthropic: { output_config: { effort: 'high' } } },
      },
      { role: 'user', text: 'More' },
    ],
  });
  expect(body).toMatchObject({
    system: 'You are terse.',
    messages: [
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'user', content: 'Hi' },
      {
        role: 'system',
        content: 'Only this turn.',
        clear_at: 'next_user_message',
      },
      { role: 'assistant', content: 'Hello' },
      { role: 'system', content: [], output_config: { effort: 'high' } },
      { role: 'user', content: 'More' },
    ],
  });
});

test('text with nothing in it is never sent', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      { role: 'system', text: '' },
      { role: 'user', text: '' },
      { role: 'user', parts: [{ type: 'text', text: '' }], cache: {} },
      {
        role: 'user',
        parts: [
          { type: 'text', text: '' },
          { type: 'text', text: 'Hi' },
        ],
      },
    ],
  });
  expect(body).toMatchObject({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  });
  expect(body).not.toHaveProperty('system');
});

test.each([
  ['image', { type: 'image', url: 'https://x.test/cat.png' }],
  ['document', { type: 'file', id: 'file_011C' }],
] as const)(
  'an instruction holding an %s fails the call: the field of its own takes text alone',
  (block, part) => {
    const sent = () =>
      encode('claude-opus-5-5', {
        messages: [
          { role: 'system', parts: [part] },
          { role: 'user', text: 'Hi' },
        ],
      });
    expect(sent).toThrow(Unsupported);
    expect(sent).toThrow(
      `Anthropic Messages takes no ${block} block as instructions`,
    );
  },
);

test('results of parallel calls, a turn each from another API, go in one user turn', () => {
  const { request } = chatCompletions.decode(
    {
      model: 'coder',
      messages: [
        { role: 'user', content: 'Weather in Oslo and Rome?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Oslo"}' },
            },
            {
              id: 'call_b',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Rome"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: '4C' },
        {
          role: 'tool',
          tool_call_id: 'call_b',
          content: [
            {
              type: 'text',
              text: '21C',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'And Paris?' },
      ],
    },
    new Headers(),
  );
  expect(
    encode('claude-haiku-5-5', { messages: request.messages }).body,
  ).toMatchObject({
    messages: [
      { role: 'user', content: 'Weather in Oslo and Rome?' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_a' },
          { type: 'tool_use', id: 'call_b' },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_a', content: '4C' },
          {
            type: 'tool_result',
            tool_use_id: 'call_b',
            content: [
              {
                type: 'text',
                text: '21C',
                cache_control: { type: 'ephemeral' },
              },
            ],
          },
        ],
      },
      { role: 'user', content: 'And Paris?' },
    ],
  });
});

test('a turn of results is gathered with its own marker and failure flag, and one with fields of its own stays apart', () => {
  expect(
    encode('claude-haiku-5-5', {
      messages: [
        {
          role: 'tool',
          cache: { ttl: '1h' },
          parts: [{ type: 'tool_result', id: 'call_a', text: '4C' }],
        },
        {
          role: 'tool',
          parts: [
            { type: 'tool_result', id: 'call_b', text: 'boom', failed: true },
          ],
        },
        {
          role: 'tool',
          hints: { anthropic: { note: 'kept' } },
          parts: [{ type: 'tool_result', id: 'call_c', text: '9C' }],
        },
      ],
    }).body,
  ).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_a',
            content: '4C',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'call_b',
            content: 'boom',
            is_error: true,
          },
        ],
      },
      {
        role: 'user',
        note: 'kept',
        content: [
          { type: 'tool_result', tool_use_id: 'call_c', content: '9C' },
        ],
      },
    ],
  });
});

test.each([
  [
    { effort: 'high' } as const,
    {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
    },
  ],
  [
    { budgetTokens: 2048 },
    {
      thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
    },
  ],
  [
    { effort: 'high', exclude: true } as const,
    {
      thinking: { type: 'adaptive', display: 'omitted' },
      output_config: { effort: 'high' },
    },
  ],
  [{ exclude: true }, {}],
  [{ effort: 'none' } as const, { output_config: { effort: 'low' } }],
])(
  'reasoning %j is sent the same with a connection that states thinking and without one',
  (reasoning, sent) => {
    const bare = encode('claude-opus-5-5', {
      messages: [{ role: 'user', text: 'Hello' }],
      options: { reasoning },
    });
    const { body, leftOut } = encode(
      'claude-opus-5-5',
      { messages: [{ role: 'user', text: 'Hello' }], options: { reasoning } },
      {
        thinking: { type: 'enabled', budget_tokens: 4000, display: 'omitted' },
        output_config: { effort: 'low' },
        top_k: 40,
      },
    );

    expect(bare.body).toEqual({
      ...sent,
      max_tokens: 64000,
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(body).toEqual({
      ...sent,
      top_k: 40,
      max_tokens: 64000,
      model: 'claude-opus-5-5',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(leftOut).toEqual(bare.leftOut);
  },
);

test('a request that says nothing of reasoning is sent the connection`s as stated', () => {
  expect(
    encode(
      'claude-opus-5-5',
      { messages: [{ role: 'user', text: 'Hello' }] },
      {
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: 'low' },
      },
    ),
  ).toMatchObject({
    body: {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
      max_tokens: 64000,
    },
    leftOut: [],
  });
});

test('the author`s own thinking replaces the connection`s whole, with and without an effort', () => {
  const silent = encode(
    'claude-sonnet-5-5',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: {
        provider: { anthropic: { thinking: { type: 'between_tools' } } },
      },
    },
    { thinking: { type: 'adaptive', display: 'summarized' } },
  );
  const asked = encode(
    'claude-sonnet-5-5',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: {
        reasoning: { effort: 'high' },
        provider: { anthropic: { thinking: { type: 'between_tools' } } },
      },
    },
    {
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'low' },
    },
  );

  expect(silent.body).toMatchObject({ thinking: { type: 'between_tools' } });
  expect(silent.body).not.toHaveProperty('output_config');
  expect(asked.body).toMatchObject({
    thinking: { type: 'between_tools' },
    output_config: { effort: 'high' },
  });
  expect(asked.leftOut).toEqual([]);
});

test('a connection`s system is sent when the request has none, and its limit fills a request with none', () => {
  expect(
    encode(
      'claude-opus-5-5',
      { messages: [{ role: 'user', text: 'Hello' }] },
      { system: 'Be terse.', max_tokens: 8192 },
    ).body,
  ).toEqual({
    system: 'Be terse.',
    max_tokens: 8192,
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  });
});

test('the rule is asked by the name the upstream knows the model by', () => {
  const { body, leftOut } = encode(
    'claude-opus-4-7',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: { temperature: 0.2 },
    },
    {},
    (model) =>
      model === 'claude-opus-4-7'
        ? {
            temperature: 1,
            topP: 0.99,
            topK: false,
            presencePenalty: false,
            frequencyPenalty: false,
            together: false,
            effort: true,
          }
        : undefined,
  );

  expect(body).not.toHaveProperty('temperature');
  expect(leftOut).toEqual([
    {
      setting: 'temperature.model',
      detail:
        'Anthropic Messages has no field for a temperature the model does not take',
    },
  ]);
});

test('with no rule sampling is sent as given', () => {
  const { body, leftOut } = encode('claude-opus-4-7', {
    messages: [{ role: 'user', text: 'Hello' }],
    options: { temperature: 0.2, topP: 0.9, topK: 40 },
  });

  expect(body).toMatchObject({ temperature: 0.2, top_p: 0.9, top_k: 40 });
  expect(leftOut).toEqual([]);
});

test('a message with an entry for each family is sent this one`s own', () => {
  const { body } = encode('claude-opus-5-5', {
    messages: [
      {
        role: 'user',
        text: 'Hello',
        provider: { 'openai.chat': { y: 2 }, anthropic: { x: 1 } },
      },
    ],
  });

  expect(body).toMatchObject({
    messages: [{ role: 'user', content: 'Hello', x: 1 }],
  });
});

test('a temperature the request states replaces the connection`s, also when the model takes neither', () => {
  const { body, leftOut } = encode(
    'claude-opus-5-5',
    {
      messages: [{ role: 'user', text: 'Hello' }],
      options: { temperature: 0.7 },
    },
    { temperature: 0.2, top_k: 40 },
    () => ({
      temperature: 1,
      topP: 0.99,
      topK: false,
      presencePenalty: false,
      frequencyPenalty: false,
      together: false,
      effort: true,
    }),
  );

  expect(body).toEqual({
    top_k: 40,
    max_tokens: 64000,
    model: 'claude-opus-5-5',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['temperature.model']);
});
