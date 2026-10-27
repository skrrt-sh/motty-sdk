import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { encode } from '../../src/chat-completions/encode.ts';
import { dict } from '../../src/wire/json.ts';

test('a prompt is sent as a streaming request that asks for usage', () => {
  expect(encode('gpt-x', { messages: [{ role: 'user', text: 'Hi' }] })).toEqual(
    {
      path: '/chat/completions',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: {
        model: 'gpt-x',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
        stream_options: { include_usage: true },
      },
      leftOut: [],
    },
  );
});

test('sampling, stops and the token limit are sent under the API`s names', () => {
  const { body } = encode('gpt-x', {
    messages: [],
    options: {
      temperature: 0.2,
      topP: 0.9,
      seed: 7,
      presencePenalty: 0.5,
      frequencyPenalty: -0.5,
      maxTokens: 256,
      stop: ['END'],
      user: 'user-1234',
      parallelToolCalls: false,
    },
  });

  expect(body).toMatchObject({
    temperature: 0.2,
    top_p: 0.9,
    seed: 7,
    presence_penalty: 0.5,
    frequency_penalty: -0.5,
    max_completion_tokens: 256,
    stop: ['END'],
    user: 'user-1234',
    parallel_tool_calls: false,
  });
});

test('an order to keep reasoning out of the reply is left out and reported', () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [],
    options: { reasoning: { effort: 'low', exclude: true } },
  });

  expect(body).toEqual({
    model: 'gpt-x',
    messages: [],
    reasoning_effort: 'low',
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.exclude',
      detail:
        'Chat Completions has no field for an order to keep reasoning out of the reply',
    },
  ]);
});

test('function and custom tools are sent in their shapes', () => {
  const { body } = encode('gpt-x', {
    messages: [],
    tools: [
      {
        type: 'function',
        name: 'weather',
        description: 'The weather in a city',
        input: { type: 'object', properties: { city: { type: 'string' } } },
        strict: true,
        cache: {},
      },
      {
        type: 'custom',
        name: 'shell',
        grammar: { syntax: 'regex', definition: '^ls( -[al]+)?$' },
      },
      { type: 'custom', name: 'note', description: 'Free text' },
      {
        type: 'provider',
        provider: { 'openai.chat': { type: 'web_search_preview' } },
      },
    ],
  });

  expect(body).toMatchObject({
    tools: [
      {
        type: 'function',
        function: {
          name: 'weather',
          description: 'The weather in a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
          strict: true,
        },
      },
      {
        type: 'custom',
        custom: {
          name: 'shell',
          format: {
            type: 'grammar',
            grammar: { syntax: 'regex', definition: '^ls( -[al]+)?$' },
          },
        },
      },
      { type: 'custom', custom: { name: 'note', description: 'Free text' } },
      { type: 'web_search_preview' },
    ],
  });
});

test('each tool choice is sent, a custom tool named as one', () => {
  const sent = (toolChoice: Parameters<typeof encode>[1]['options']) =>
    encode('gpt-x', {
      messages: [],
      tools: [
        { type: 'function', name: 'weather', input: {} },
        { type: 'custom', name: 'shell' },
      ],
      ...(toolChoice === undefined ? {} : { options: toolChoice }),
    }).body;

  expect(sent({ toolChoice: 'none' })).toMatchObject({ tool_choice: 'none' });
  expect(sent({ toolChoice: { tool: 'weather' } })).toMatchObject({
    tool_choice: { type: 'function', function: { name: 'weather' } },
  });
  expect(sent({ toolChoice: { tool: 'shell' } })).toMatchObject({
    tool_choice: { type: 'custom', custom: { name: 'shell' } },
  });
  expect(
    sent({ toolChoice: { allowed: ['weather', 'shell'], mode: 'required' } }),
  ).toMatchObject({
    tool_choice: {
      type: 'allowed_tools',
      allowed_tools: {
        mode: 'required',
        tools: [
          { type: 'function', function: { name: 'weather' } },
          { type: 'custom', custom: { name: 'shell' } },
        ],
      },
    },
  });
  expect(
    sent({
      toolChoice: { provider: { 'openai.chat': { type: 'web_search' } } },
    }),
  ).toMatchObject({ tool_choice: { type: 'web_search' } });
});

test('an output schema is sent as a JSON schema format, named', () => {
  const schema = {
    type: 'object',
    properties: { celsius: { type: 'number' } },
    required: ['celsius'],
  };

  expect(
    encode('gpt-x', {
      messages: [],
      output: {
        schema,
        name: 'forecast',
        description: 'A forecast',
        strict: true,
      },
    }).body,
  ).toMatchObject({
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'forecast',
        description: 'A forecast',
        strict: true,
        schema,
      },
    },
  });
  expect(
    encode('gpt-x', { messages: [], output: { schema } }).body,
  ).toMatchObject({
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'output', schema, strict: false },
    },
  });
});

test('an output with no schema is sent as JSON mode', () => {
  expect(encode('gpt-x', { messages: [], output: {} }).body).toMatchObject({
    response_format: { type: 'json_object' },
  });
});

test('this wire`s own options and hints are put back on the wire', () => {
  const { body } = encode('gpt-x', {
    messages: [],
    options: {
      provider: { 'openai.chat': { logprobs: true, top_logprobs: 3 } },
      hints: {
        'openai.chat': { metadata: { ticket: 'MOT-12' }, service_tier: 'flex' },
        anthropic: { cache_control: { type: 'ephemeral' } },
      },
    },
  });

  expect(body).toEqual({
    logprobs: true,
    top_logprobs: 3,
    metadata: { ticket: 'MOT-12' },
    service_tier: 'flex',
    model: 'gpt-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('neither a hint nor an option outranks a typed field or the stream', () => {
  const { body } = encode('gpt-x', {
    messages: [],
    options: {
      user: 'ann',
      provider: {
        'openai.chat': { user: 'bob', stream: false, model: 'o' },
      },
      hints: { 'openai.chat': { stream_options: { include_usage: false } } },
    },
  });

  expect(body).toMatchObject({
    user: 'ann',
    model: 'gpt-x',
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('a sampling setting said in the API`s own words is sent as said, and the neutral one beside it is reported', () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [],
    options: {
      temperature: 0.2,
      topP: 0.9,
      provider: { 'openai.chat': { temperature: 2 } },
    },
  });

  expect(body).toMatchObject({ temperature: 2, top_p: 0.9 });
  expect(leftOut).toEqual([
    {
      setting: 'sampling.own',
      detail:
        "Chat Completions has no field for a sampling setting the request also states in the API's own words",
    },
  ]);
});

test('a hint gives way to a neutral sampling setting', () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [],
    options: {
      temperature: 0.2,
      hints: { 'openai.chat': { temperature: 2 } },
    },
  });

  expect(body).toMatchObject({ temperature: 0.2 });
  expect(leftOut).toEqual([]);
});

test('an option map with an entry for each family is sent this one`s own', () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [],
    options: {
      provider: {
        anthropic: { thinking: { type: 'enabled', budget_tokens: 2000 } },
        'openai.chat': { logprobs: true },
      },
    },
  });

  expect(body).toEqual({
    logprobs: true,
    model: 'gpt-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut).toEqual([]);
});

test('an option of another family fails the call', () => {
  expect(() =>
    encode('gpt-x', {
      messages: [],
      options: { provider: { anthropic: { thinking: { type: 'enabled' } } } },
    }),
  ).toThrow('Chat Completions cannot carry an option of anthropic');
});

test('top-k sampling is left out and reported', () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [],
    options: { topK: 40 },
  });

  expect(body).not.toHaveProperty('top_k');
  expect(leftOut).toEqual([
    {
      setting: 'topK',
      detail: 'Chat Completions has no field for top-k sampling',
    },
  ]);
});

test('top-k sampling is sent to an upstream said to take it, and nothing is reported', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { topK: 40 } },
    { name: 'sampled', topK: true },
  );

  expect(body).toMatchObject({ top_k: 40 });
  expect(leftOut).toEqual([]);
});

test('top-k sampling a model does not take is left out and reported, though the upstream takes it', () => {
  const { body, leftOut } = encode(
    'model-x',
    { messages: [], options: { topK: 40 } },
    { name: 'sampled', topK: true },
    {},
    () => ({
      temperature: [0, 2],
      topP: [0, 1],
      topK: false,
      presencePenalty: true,
      frequencyPenalty: true,
      together: true,
      effort: true,
    }),
  );

  expect(body).not.toHaveProperty('top_k');
  expect(leftOut).toEqual([
    {
      setting: 'topK.model',
      detail:
        'Chat Completions has no field for top-k sampling the model does not take',
    },
  ]);
});

test('the body holds no part of the prompt it was made from', () => {
  const input = { type: 'object', required: ['city'] };
  const { body } = encode('gpt-x', {
    messages: [],
    tools: [{ type: 'function', name: 'weather', input }],
  });

  input.required.push('day');

  expect(body).toMatchObject({
    tools: [{ function: { parameters: { required: ['city'] } } }],
  });
});

test.each([
  [{ effort: 'high' } as const],
  [{ budgetTokens: 2048 }],
  [{ exclude: true }],
])(
  'reasoning %j is sent the same with a connection that states reasoning under any name and without one',
  (reasoning) => {
    for (const dialect of [
      { name: 'openai.chat' },
      { name: 'openrouter', asks: 'reasoning' },
      { name: 'deepseek', asks: 'thinking', limit: 'max_tokens' },
    ] as const) {
      const bare = encode(
        'small',
        { messages: [{ role: 'user', text: 'Hi' }], options: { reasoning } },
        dialect,
      );
      const stated = encode(
        'small',
        { messages: [{ role: 'user', text: 'Hi' }], options: { reasoning } },
        dialect,
        {
          reasoning_effort: 'low',
          reasoning: { effort: 'low', exclude: true },
          thinking: { type: 'disabled' },
          temperature: 0.2,
        },
      );

      expect(stated.body).toEqual({ temperature: 0.2, ...dict(bare.body) });
      expect(stated.leftOut).toEqual(bare.leftOut);
    }
  },
);

test.each([[{}]])(
  'a request whose reasoning is %j is sent the connection`s as stated',
  (reasoning) => {
    expect(
      encode(
        'small',
        {
          messages: [{ role: 'user', text: 'Hi' }],
          options: reasoning === undefined ? {} : { reasoning },
        },
        { name: 'deepseek', asks: 'thinking', limit: 'max_tokens' },
        { thinking: { type: 'disabled' }, reasoning_effort: 'low' },
      ).body,
    ).toMatchObject({
      thinking: { type: 'disabled' },
      reasoning_effort: 'low',
    });
  },
);

test('a limit replaces the connection`s under either name, and a request with none takes it', () => {
  const stated = encode(
    'small',
    { messages: [{ role: 'user', text: 'Hi' }], options: { maxTokens: 64 } },
    { name: 'openai.chat' },
    { max_tokens: 8192 },
  );
  const named = encode(
    'small',
    { messages: [{ role: 'user', text: 'Hi' }], options: { maxTokens: 64 } },
    { name: 'deepseek', limit: 'max_tokens' },
    { max_completion_tokens: 8192 },
  );
  const silent = encode(
    'small',
    { messages: [{ role: 'user', text: 'Hi' }] },
    { name: 'openai.chat' },
    { max_tokens: 8192 },
  );

  expect(stated.body).toMatchObject({ max_completion_tokens: 64 });
  expect(stated.body).not.toHaveProperty('max_tokens');
  expect(named.body).toMatchObject({ max_tokens: 64 });
  expect(named.body).not.toHaveProperty('max_completion_tokens');
  expect(silent.body).toMatchObject({ max_tokens: 8192 });
});

test.each([[{ name: 'openai.chat' }]] as const)(
  'an effort said in this API`s own words is sent as said by %j, and the effort beside it is reported',
  (dialect) => {
    const { body, leftOut } = encode(
      'small',
      {
        messages: [{ role: 'user', text: 'Hi' }],
        options: {
          reasoning: { effort: 'high' },
          provider: { 'openai.chat': { reasoning_effort: 'low' } },
        },
      },
      dialect,
    );

    expect(body).toMatchObject({ reasoning_effort: 'low' });
    expect(leftOut).toEqual([
      {
        setting: 'reasoning.own',
        detail:
          "Chat Completions has no field for a reasoning option the request also states in the API's own words",
      },
    ]);
  },
);

test.each([
  [{ reasoning: { effort: 'high' } } as const, 'high'],
  [{ provider: { 'openai.chat': { reasoning_effort: 'medium' } } }, 'medium'],
])('a hinted effort that %j replaces is reported', (options, sent) => {
  const { body, leftOut } = encode('small', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      ...options,
      hints: { 'openai.chat': { reasoning_effort: 'low' } },
    },
  });

  expect(body).toMatchObject({ reasoning_effort: sent });
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.hint',
      detail:
        'Chat Completions has no field for a hint of thinking the reasoning asked for does not take',
    },
  ]);
});

test('a hinted effort that is sent is not reported', () => {
  const { body, leftOut } = encode('small', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { hints: { 'openai.chat': { reasoning_effort: 'low' } } },
  });

  expect(body).toMatchObject({ reasoning_effort: 'low' });
  expect(leftOut).toEqual([]);
});

test('a temperature the model does not take is left out of the request and reported', () => {
  const { body, leftOut } = encode(
    'gpt-5',
    { messages: [], options: { temperature: 0.2 } },
    { name: 'openai.chat' },
    {},
    () => ({
      temperature: 1,
      topP: 1,
      topK: false,
      presencePenalty: false,
      frequencyPenalty: false,
      together: true,
      effort: true,
    }),
  );

  expect(body).not.toHaveProperty('temperature');
  expect(leftOut).toEqual([
    {
      setting: 'temperature.model',
      detail:
        'Chat Completions has no field for a temperature the model does not take',
    },
  ]);
});

test('an effort the model does not take is left out and reported', () => {
  const { body, leftOut } = encode(
    'gpt-4.1',
    { messages: [], options: { reasoning: { effort: 'high' } } },
    { name: 'openai.chat' },
    {},
    () => ({
      temperature: [0, 2],
      topP: [0, 1],
      topK: false,
      presencePenalty: true,
      frequencyPenalty: true,
      together: true,
      effort: false,
    }),
  );

  expect(body).not.toHaveProperty('reasoning_effort');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.model',
      detail:
        'Chat Completions has no field for a reasoning effort the model does not take',
    },
  ]);
});

test('an effort the model does not take leaves a mute in the reasoning object of a dialect', () => {
  const { body, leftOut } = encode(
    'openai/gpt-4.1',
    {
      messages: [],
      options: { reasoning: { effort: 'high', exclude: true } },
    },
    { name: 'openrouter', asks: 'reasoning' },
    {},
    () => ({
      temperature: [0, 2],
      topP: [0, 1],
      topK: false,
      presencePenalty: true,
      frequencyPenalty: true,
      together: true,
      effort: false,
    }),
  );

  expect(body).toMatchObject({ reasoning: { exclude: true } });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['reasoning.model']);
});

test('the rule is asked whether the model takes an effort, then with what the request says of reasoning', () => {
  const said = (
    options: NonNullable<Parameters<typeof encode>[1]['options']>,
    dialect: Parameters<typeof encode>[2] = { name: 'openai.chat' },
    defaults: Parameters<typeof encode>[3] = {},
  ) => {
    const asked: (boolean | undefined)[] = [];
    encode(
      'gpt-5.5',
      { messages: [], options },
      dialect,
      defaults,
      (_, how) => {
        asked.push(how);
        return undefined;
      },
    );
    return asked;
  };

  expect(said({})).toEqual([true, undefined]);
  expect(said({ reasoning: { effort: 'none' } })).toEqual([true, false]);
  expect(said({ reasoning: { effort: 'low' } })).toEqual([true, true]);
  expect(
    said({ provider: { 'openai.chat': { reasoning_effort: 'none' } } }),
  ).toEqual([true, false]);
  expect(
    said({}, { name: 'openai.chat' }, { reasoning_effort: 'none' }),
  ).toEqual([true, false]);
  expect(
    said(
      { reasoning: { budgetTokens: 2000 } },
      { name: 'r', asks: 'reasoning' },
    ),
  ).toEqual([true, true]);
  expect(
    said({ reasoning: { effort: 'none' } }, { name: 'r', asks: 'reasoning' }),
  ).toEqual([true, false]);
});

test('a model that samples only when told not to reason is sent a temperature beside an effort of none', () => {
  const { body, leftOut } = encode(
    'gpt-5.5',
    {
      messages: [],
      options: { temperature: 0.2, reasoning: { effort: 'none' } },
    },
    { name: 'openai.chat' },
    {},
    (_, reasons) =>
      reasons === false
        ? undefined
        : {
            temperature: 1,
            topP: 1,
            topK: false,
            presencePenalty: false,
            frequencyPenalty: false,
            together: true,
            effort: true,
          },
  );

  expect(body).toMatchObject({ temperature: 0.2, reasoning_effort: 'none' });
  expect(leftOut).toEqual([]);
});

test('a temperature the request states replaces the connection`s, also when the model takes neither', () => {
  const { body, leftOut } = encode(
    'gpt-5.5',
    { messages: [], options: { temperature: 0.7 } },
    { name: 'openai.chat' },
    { temperature: 0.2, top_p: 0.9 },
    () => ({
      temperature: 1,
      topP: 1,
      topK: false,
      presencePenalty: false,
      frequencyPenalty: false,
      together: true,
      effort: true,
    }),
  );

  expect(body).toEqual({
    top_p: 0.9,
    model: 'gpt-5.5',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['temperature.model']);
});

test.each([
  [{ anthropic: { thinking: { type: 'enabled' } }, openai: {} }, {}],
  [
    { openai: { store: true }, 'openai.chat': { logit_bias: { '50256': -1 } } },
    { store: true, logit_bias: { '50256': -1 } },
  ],
  [
    { openai: { truncation: 'auto' }, 'openai.chat': { truncation: 'off' } },
    { truncation: 'off' },
  ],
])('the options %j are sent as the fields %j', (provider, fields) => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [],
    options: { provider },
  });

  expect(body).toEqual({
    ...fields,
    model: 'gpt-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut).toEqual([]);
});

test.each([
  [
    { openai: { previous_response_id: 'r1' } },
    'Chat Completions cannot carry previous_response_id, which another API of openai has',
  ],
  [
    { 'openai.responses': { store: true } },
    'Chat Completions cannot carry an option of openai.responses',
  ],
])('the options %j fail the call: %s', (provider, message) => {
  const sent = () => encode('gpt-x', { messages: [], options: { provider } });

  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow(message);
});

test('a hint under the provider`s key that only the other API has is left out and reported', () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [],
    options: {
      hints: { openai: { previous_response_id: 'r1', service_tier: 'flex' } },
    },
  });

  expect(body).toEqual({
    service_tier: 'flex',
    model: 'gpt-x',
    messages: [],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(leftOut).toEqual([
    {
      setting: 'openai.previous_response_id',
      detail: 'Chat Completions has no field for previous_response_id',
    },
  ]);
});

test('below the options the provider`s key is read for a hint alone', () => {
  const { body } = encode('gpt-x', {
    messages: [
      {
        role: 'user',
        provider: { 'openai.chat': { b: 2 } },
        parts: [{ type: 'text', text: 'Hi', hints: { openai: { c: 3 } } }],
      },
    ],
  });

  expect(body).toMatchObject({
    messages: [
      { role: 'user', b: 2, content: [{ type: 'text', text: 'Hi', c: 3 }] },
    ],
  });
});

test.each([
  [
    'a tool choice',
    {
      options: { toolChoice: { provider: { openai: { type: 'web_search' } } } },
    },
  ],
] as const)(
  '%s under the provider`s key is not this API`s: its two APIs share no shape for one',
  (what, prompt) => {
    expect(() =>
      encode('gpt-x', { messages: [{ role: 'user', text: 'Hi' }], ...prompt }),
    ).toThrow(`Chat Completions cannot carry ${what} of `);
  },
);

test('what a tool holds for this API is written back where it sat', () => {
  const { body } = encode('gpt-x', {
    messages: [],
    tools: [
      {
        type: 'function',
        name: 'now',
        input: { type: 'object' },
        hints: {
          'openai.chat': {
            cache_control: { type: 'ephemeral' },
            function: { vendor: 1, name: 'other' },
          },
        },
      },
      {
        type: 'custom',
        name: 'shell',
        provider: { 'openai.chat': { defer: true, custom: { vendor: 1 } } },
      },
    ],
  });

  expect(body).toHaveProperty('tools', [
    {
      cache_control: { type: 'ephemeral' },
      type: 'function',
      function: { vendor: 1, name: 'now', parameters: { type: 'object' } },
    },
    { defer: true, type: 'custom', custom: { vendor: 1, name: 'shell' } },
  ]);
});

test('a user longer than the Responses API takes is sent as said', () => {
  const { body, leftOut } = encode('gpt-x', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { user: 'u'.repeat(150) },
  });
  expect(body).toHaveProperty('user', 'u'.repeat(150));
  expect(leftOut).toEqual([]);
});

test('a field a tool was not given is not written from what it holds', () => {
  const { body } = encode('gpt-x', {
    messages: [],
    tools: [
      {
        type: 'function',
        name: 'now',
        input: { type: 'object' },
        hints: {
          'openai.chat': {
            custom: { vendor: 1 },
            function: { description: 'stray', strict: true },
          },
        },
      },
    ],
  });

  expect(body).toHaveProperty('tools', [
    {
      type: 'function',
      function: { name: 'now', parameters: { type: 'object' } },
    },
  ]);
});
