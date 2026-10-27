import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { messages } from '../../src/index.ts';
import { decode } from '../../src/responses/decode.ts';
import { encode } from '../../src/responses/encode.ts';
import { dict } from '../../src/wire/json.ts';

test('a prompt goes out as a stream that nothing is stored of', () => {
  expect(encode('gpt-5', { messages: [{ role: 'user', text: 'Hi' }] })).toEqual(
    {
      path: '/responses',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: {
        model: 'gpt-5',
        input: [{ type: 'message', role: 'user', content: 'Hi' }],
        store: false,
        stream: true,
      },
      leftOut: [],
    },
  );
});

test('storing cannot be turned on by an option', () => {
  expect(
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: {
        provider: { 'openai.responses': { store: true, stream: false } },
      },
    }).body,
  ).toMatchObject({ store: false, stream: true });
});

test('options are written under the names this API gives them', () => {
  expect(
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      tools: [
        { type: 'function', name: 'weather', input: { type: 'object' } },
        { type: 'custom', name: 'patch' },
      ],
      options: {
        toolChoice: { tool: 'patch' },
        parallelToolCalls: false,
        maxTokens: 256,
        temperature: 0.2,
        topP: 0.9,
        user: 'u_1',
        seed: 7,
      },
    }).body,
  ).toEqual({
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
    tools: [
      {
        type: 'function',
        name: 'weather',
        parameters: { type: 'object' },
      },
      { type: 'custom', name: 'patch' },
    ],
    tool_choice: { type: 'custom', name: 'patch' },
    parallel_tool_calls: false,
    max_output_tokens: 256,
    temperature: 0.2,
    top_p: 0.9,
    user: 'u_1',
  });
});

test('reasoning asked for comes back as a summary to read', () => {
  expect(
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { reasoning: { effort: 'high', budgetTokens: 4096 } },
    }).body,
  ).toMatchObject({ reasoning: { effort: 'high', summary: 'auto' } });
});

test('muted reasoning asks for no summary, whatever was hinted', () => {
  const { body } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { effort: 'max', exclude: true },
      hints: { 'openai.responses': { reasoning: { summary: 'auto' } } },
    },
  });
  expect(body).toMatchObject({ reasoning: { effort: 'max' } });
  expect(body).not.toHaveProperty('reasoning.summary');
});

test('the summary a caller chose is the one asked for', () => {
  expect(
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: {
        reasoning: {},
        hints: { 'openai.responses': { reasoning: { summary: 'concise' } } },
        provider: {
          'openai.responses': { reasoning: { context: 'all_turns' } },
        },
      },
    }).body,
  ).toMatchObject({ reasoning: { summary: 'concise', context: 'all_turns' } });
});

test('with no reasoning option none is sent', () => {
  expect(
    encode('gpt-4.1', { messages: [{ role: 'user', text: 'Hi' }] }).body,
  ).not.toHaveProperty('reasoning');
});

test('structured output is a JSON schema format', () => {
  expect(
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      output: {
        name: 'answer',
        description: 'The answer',
        strict: true,
        schema: { type: 'object' },
      },
      options: {
        hints: { 'openai.responses': { text: { verbosity: 'low' } } },
      },
    }).body,
  ).toMatchObject({
    text: {
      verbosity: 'low',
      format: {
        type: 'json_schema',
        name: 'answer',
        description: 'The answer',
        strict: true,
        schema: { type: 'object' },
      },
    },
  });
});

test('a schema with no name is given one, and no schema asks for any JSON', () => {
  expect(
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      output: { schema: { type: 'object' } },
    }).body,
  ).toMatchObject({
    text: {
      format: {
        type: 'json_schema',
        name: 'output',
        schema: { type: 'object' },
      },
    },
  });
  expect(
    encode('gpt-5', { messages: [{ role: 'user', text: 'Hi' }], output: {} })
      .body,
  ).toMatchObject({ text: { format: { type: 'json_object' } } });
});

test("this family's own options and hints are put back on the wire", () => {
  expect(
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: {
        hints: {
          'openai.responses': {
            metadata: { ticket: 'T-1' },
            prompt_cache_key: 'k1',
          },
          anthropic: { cache_control: { type: 'ephemeral' } },
        },
        provider: { 'openai.responses': { truncation: 'auto' } },
      },
    }).body,
  ).toEqual({
    metadata: { ticket: 'T-1' },
    prompt_cache_key: 'k1',
    truncation: 'auto',
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
  });
});

test("another family's option that changes the meaning fails the call", () => {
  expect(() =>
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { provider: { anthropic: { thinking: { type: 'enabled' } } } },
    }),
  ).toThrow(Unsupported);
});

test('an option this API has no form for fails the call', () => {
  const sent =
    (options: NonNullable<Parameters<typeof encode>[1]['options']>) => () =>
      encode('gpt-5', { messages: [{ role: 'user', text: 'Hi' }], options });
  expect(sent({ stop: ['END'] })).toThrow(
    'The Responses API cannot carry stop sequences',
  );
  expect(sent({ stop: [] })).not.toThrow();
});

test('top-k sampling is left out and reported', () => {
  const { body, leftOut } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { topK: 40 },
  });

  expect(body).not.toHaveProperty('top_k');
  expect(leftOut).toEqual([
    {
      setting: 'topK',
      detail: 'The Responses API has no field for top-k sampling',
    },
  ]);
});

test('a hint this API has no field for is left out', () => {
  const { body } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { seed: 7, reasoning: { effort: 'low', budgetTokens: 2000 } },
  });

  expect(body).toEqual({
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
    reasoning: { effort: 'low', summary: 'auto' },
  });
});

test('the two penalties are read from a request and written to one', () => {
  const { request } = decode({
    model: 'coder',
    input: 'Hi',
    presence_penalty: 0.3,
    frequency_penalty: 0.2,
  });
  expect(request.options).toEqual({
    presencePenalty: 0.3,
    frequencyPenalty: 0.2,
  });
  expect(
    encode('gpt-4.1-nano', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { presencePenalty: 0.3, frequencyPenalty: 0.2 },
    }),
  ).toMatchObject({
    body: { presence_penalty: 0.3, frequency_penalty: 0.2 },
    leftOut: [],
  });
});

test.each([
  [{ effort: 'high' } as const, { effort: 'high', summary: 'auto' }],
  [{ budgetTokens: 2048 }, { summary: 'auto' }],
  [{ effort: 'high', exclude: true } as const, { effort: 'high' }],
  [{ effort: 'none' } as const, { effort: 'none', summary: 'auto' }],
])(
  'reasoning %j is sent the same with a connection that states reasoning and without one',
  (reasoning, sent) => {
    const bare = encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { reasoning },
    });
    const stated = encode(
      'gpt-5',
      { messages: [{ role: 'user', text: 'Hi' }], options: { reasoning } },
      {
        reasoning: { effort: 'low', summary: 'detailed' },
        service_tier: 'flex',
      },
    );

    expect(bare.body).toMatchObject({ reasoning: sent });
    expect(stated.body).toEqual({
      ...dict(bare.body),
      service_tier: 'flex',
    });
  },
);

test('a mute alone sends no reasoning, and none of the connection`s', () => {
  expect(
    encode(
      'gpt-5',
      {
        messages: [{ role: 'user', text: 'Hi' }],
        options: { reasoning: { exclude: true } },
      },
      { reasoning: { effort: 'low', summary: 'detailed' } },
    ).body,
  ).not.toHaveProperty('reasoning');
});

test.each([[undefined], [{}]])(
  'a request whose reasoning is %j is sent the connection`s as stated',
  (reasoning) => {
    expect(
      encode(
        'gpt-5',
        {
          messages: [{ role: 'user', text: 'Hi' }],
          options: reasoning === undefined ? {} : { reasoning },
        },
        { reasoning: { effort: 'low' } },
      ).body,
    ).toMatchObject({ reasoning: { effort: 'low' } });
    expect(
      encode(
        'gpt-5',
        {
          messages: [{ role: 'user', text: 'Hi' }],
          options: reasoning === undefined ? {} : { reasoning },
        },
        { reasoning: { effort: 'low' } },
      ).body,
    ).not.toHaveProperty('reasoning.summary');
  },
);

test('the author`s own reasoning replaces the connection`s whole', () => {
  expect(
    encode(
      'gpt-5',
      {
        messages: [{ role: 'user', text: 'Hi' }],
        options: {
          provider: {
            'openai.responses': { reasoning: { summary: 'concise' } },
          },
        },
      },
      { reasoning: { effort: 'low', summary: 'detailed' } },
    ).body,
  ).toHaveProperty('reasoning', { summary: 'concise' });
});

test('reasoning said in this API`s own words is sent as said, and the effort and the mute beside it are reported', () => {
  const { body, leftOut } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { effort: 'high', exclude: true },
      provider: {
        'openai.responses': {
          reasoning: { effort: 'low', summary: 'detailed' },
        },
      },
    },
  });

  expect(body).toHaveProperty('reasoning', {
    effort: 'low',
    summary: 'detailed',
  });
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.own',
      detail:
        "The Responses API has no field for a reasoning option the request also states in the API's own words",
    },
  ]);
});

test('an effort is written beside own words that state none, and nothing is reported', () => {
  const { body, leftOut } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { effort: 'high' },
      provider: { 'openai.responses': { reasoning: { context: 'all_turns' } } },
    },
  });

  expect(body).toHaveProperty('reasoning', {
    context: 'all_turns',
    effort: 'high',
    summary: 'auto',
  });
  expect(leftOut).toEqual([]);
});

test.each([
  [{ reasoning: { effort: 'max', exclude: true } } as const, { effort: 'max' }],
  [
    {
      reasoning: {},
      provider: {
        'openai.responses': {
          reasoning: { effort: 'high', summary: 'detailed' },
        },
      },
    },
    { effort: 'high', summary: 'detailed' },
  ],
])(
  'a hinted effort and summary that %j replaces are reported',
  (options, sent) => {
    const { body, leftOut } = encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: {
        ...options,
        hints: {
          'openai.responses': { reasoning: { effort: 'low', summary: 'auto' } },
        },
      },
    });

    expect(body).toHaveProperty('reasoning', sent);
    expect(leftOut).toEqual([
      {
        setting: 'reasoning.hint',
        detail:
          'The Responses API has no field for a hint of thinking the reasoning asked for does not take',
      },
    ]);
  },
);

test('a hint of reasoning that is sent is not reported', () => {
  const { body, leftOut } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      reasoning: { effort: 'high' },
      hints: { 'openai.responses': { reasoning: { summary: 'concise' } } },
    },
  });

  expect(body).toHaveProperty('reasoning', {
    summary: 'concise',
    effort: 'high',
  });
  expect(leftOut).toEqual([]);
});

test('a temperature and a penalty the model does not take are left out of the request and reported', () => {
  const { body, leftOut } = encode(
    'gpt-5',
    {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { temperature: 0.2, frequencyPenalty: 0.5 },
    },
    {},
    undefined,
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
  expect(body).not.toHaveProperty('frequency_penalty');
  expect(leftOut).toEqual([
    {
      setting: 'temperature.model',
      detail:
        'The Responses API has no field for a temperature the model does not take',
    },
    {
      setting: 'frequencyPenalty.model',
      detail:
        'The Responses API has no field for a frequency penalty the model does not take',
    },
  ]);
});

test('a temperature outside the range of the model is sent as the nearest inside and reported', () => {
  const { body, leftOut } = encode(
    'gpt-4.1',
    {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { temperature: 2.5 },
    },
    {},
    undefined,
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

  expect(body).toMatchObject({ temperature: 2 });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['temperature.range']);
});

test('a sampling setting said in the API`s own words is sent as said, and the neutral one beside it is reported', () => {
  const { body, leftOut } = encode('gpt-4.1', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      temperature: 0.2,
      provider: { 'openai.responses': { temperature: 1.5 } },
    },
  });

  expect(body).toMatchObject({ temperature: 1.5 });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['sampling.own']);
});

test('an effort the model does not take is left out with the summary asked for beside it, and reported', () => {
  const { body, leftOut } = encode(
    'gpt-4.1',
    {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { reasoning: { effort: 'high' } },
    },
    {},
    undefined,
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

  expect(body).not.toHaveProperty('reasoning');
  expect(leftOut).toEqual([
    {
      setting: 'reasoning.model',
      detail:
        'The Responses API has no field for a reasoning effort the model does not take',
    },
  ]);
});

test('an effort in the API`s own words is sent as said to a model the rule refuses it for', () => {
  const { body, leftOut } = encode(
    'gpt-4.1',
    {
      messages: [{ role: 'user', text: 'Hi' }],
      options: {
        provider: { 'openai.responses': { reasoning: { effort: 'low' } } },
      },
    },
    {},
    undefined,
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

  expect(body).toMatchObject({ reasoning: { effort: 'low' } });
  expect(leftOut).toEqual([]);
});

test('the rule is asked whether the model takes an effort, then with what the request says of reasoning', () => {
  const said = (
    options: NonNullable<Parameters<typeof encode>[1]['options']>,
    defaults: Parameters<typeof encode>[2] = {},
  ) => {
    const asked: [string, boolean | undefined][] = [];
    encode(
      'gpt-5.5',
      { messages: [{ role: 'user', text: 'Hi' }], options },
      defaults,
      undefined,
      (model, how) => {
        asked.push([model, how]);
        return undefined;
      },
    );
    return asked;
  };

  expect(said({})).toEqual([
    ['gpt-5.5', true],
    ['gpt-5.5', undefined],
  ]);
  expect(said({ reasoning: { effort: 'none' } })).toEqual([
    ['gpt-5.5', true],
    ['gpt-5.5', false],
  ]);
  expect(said({ reasoning: { effort: 'low' } })).toEqual([
    ['gpt-5.5', true],
    ['gpt-5.5', true],
  ]);
  expect(
    said({
      provider: { 'openai.responses': { reasoning: { effort: 'none' } } },
    }),
  ).toEqual([
    ['gpt-5.5', true],
    ['gpt-5.5', false],
  ]);
  expect(said({}, { reasoning: { effort: 'none' } })).toEqual([
    ['gpt-5.5', true],
    ['gpt-5.5', false],
  ]);
});

test('an option map with an entry for each family is sent this one`s own', () => {
  const { body, leftOut } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: {
      provider: {
        anthropic: { thinking: { type: 'enabled', budget_tokens: 2000 } },
        'openai.chat': { logprobs: true },
        'openai.responses': { truncation: 'auto' },
      },
    },
  });

  expect(body).toEqual({
    truncation: 'auto',
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
  });
  expect(leftOut).toEqual([]);
});

test('a router`s cache marker is written with its lifetime where the codec is made for one', () => {
  const { body, leftOut } = encode(
    'gpt-5',
    {
      messages: [{ role: 'user', text: 'A long manual', cache: { ttl: '1h' } }],
    },
    {},
    'cache_control',
  );

  expect(body).toMatchObject({
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'A long manual',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
    ],
  });
  expect(leftOut).toEqual([]);
});

test('a temperature the request states replaces the connection`s, also when the model takes neither', () => {
  const { body, leftOut } = encode(
    'gpt-5.5',
    {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { temperature: 0.7 },
    },
    { temperature: 0.2, top_p: 0.9 },
    undefined,
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
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
  });
  expect(leftOut.map(({ setting }) => setting)).toEqual(['temperature.model']);
});

test.each([
  [{ anthropic: { thinking: { type: 'enabled' } }, openai: {} }, {}],
  [{ openai: { service_tier: 'flex' } }, { service_tier: 'flex' }],
  [{ openai: { some_new_field: 1 } }, { some_new_field: 1 }],
  [
    {
      openai: { metadata: { ticket: 'T-1' } },
      'openai.chat': { logit_bias: { '50256': -1 } },
    },
    { metadata: { ticket: 'T-1' } },
  ],
  [{ openai: { a: 1 }, 'openai.responses': { a: 2 } }, { a: 2 }],
  [{ openai: { n: 2 }, 'openai.responses': { n: 1 } }, { n: 1 }],
])('the options %j are sent as the fields %j', (provider, fields) => {
  const { body, leftOut } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { provider },
  });

  expect(body).toEqual({
    ...fields,
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
  });
  expect(leftOut).toEqual([]);
});

test.each([
  [
    { openai: { logit_bias: { '50256': -100 } } },
    'The Responses API cannot carry logit_bias, which another API of openai has',
  ],
  [
    { openai: { store: true, reasoning_effort: 'low' } },
    'The Responses API cannot carry reasoning_effort, which another API of openai has',
  ],
  [
    { 'openai.chat': { store: true } },
    'The Responses API cannot carry an option of openai.chat',
  ],
])('the options %j fail the call: %s', (provider, message) => {
  const sent = () =>
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { provider },
    });

  expect(sent).toThrow(Unsupported);
  expect(sent).toThrow(message);
});

test('a hint under the provider`s key that only the other API has is left out and reported', () => {
  const { body, leftOut } = encode('gpt-5', {
    messages: [{ role: 'user', text: 'Hi' }],
    options: { hints: { openai: { prediction: {}, service_tier: 'flex' } } },
  });

  expect(body).toEqual({
    service_tier: 'flex',
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: 'Hi' }],
    store: false,
    stream: true,
  });
  expect(leftOut).toEqual([
    {
      setting: 'openai.prediction',
      detail: 'The Responses API has no field for prediction',
    },
  ]);
});

test('below the options the provider`s key is read for a hint alone', () => {
  const { body } = encode('gpt-5', {
    messages: [
      {
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'Hi',
            hints: { openai: { a: 1 } },
            provider: { 'openai.responses': { b: 2 } },
          },
        ],
      },
    ],
  });

  expect(body).toMatchObject({
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Hi', a: 1, b: 2 }],
      },
    ],
  });
});

test.each([
  [
    'a tool option',
    {
      tools: [
        {
          type: 'function',
          name: 'weather',
          input: {},
          provider: { anthropic: { defer_loading: true }, openai: {} },
        },
      ],
    },
  ],
  [
    'a tool choice',
    {
      options: { toolChoice: { provider: { openai: { type: 'web_search' } } } },
    },
  ],
  [
    'a text part',
    {
      messages: [
        {
          role: 'user',
          parts: [{ type: 'text', text: 'Hi', provider: { openai: { a: 1 } } }],
        },
      ],
    },
  ],
] as const)(
  '%s under the provider`s key is not this API`s: its two APIs share no shape for one',
  (what, prompt) => {
    expect(() =>
      encode('gpt-5', { messages: [{ role: 'user', text: 'Hi' }], ...prompt }),
    ).toThrow(`The Responses API cannot carry ${what} of `);
  },
);

test.each([
  ['of 64 characters', { user: 'u'.repeat(64) }, {}, 'u'.repeat(64), false],
  [
    'of 64 characters said in this API`s own words',
    { provider: { 'openai.responses': { user: 'p'.repeat(64) } } },
    {},
    'p'.repeat(64),
    false,
  ],
  ['of 65 characters', { user: 'u'.repeat(65) }, {}, undefined, true],
  [
    'of 65 characters said in this API`s own words',
    { provider: { 'openai.responses': { user: 'p'.repeat(65) } } },
    {},
    undefined,
    true,
  ],
  [
    'too long, which gives way to none said as a hint or in this API`s own words, long or short',
    {
      user: 'u'.repeat(65),
      hints: { 'openai.responses': { user: 'h'.repeat(65) } },
      provider: { 'openai.responses': { user: 'short' } },
    },
    {},
    undefined,
    true,
  ],
  [
    'too long, which gives way to none of the connection, which would name another caller',
    { user: 'u'.repeat(65) },
    { user: 'connection' },
    undefined,
    true,
  ],
  ['that was not said', { maxTokens: 256 }, {}, undefined, false],
] as const)(
  'a user %s is sent whole or left out and reported, never cut short',
  (_, options, defaults, sent, reported) => {
    const { body, leftOut } = encode(
      'gpt-5',
      { messages: [{ role: 'user', text: 'Hi' }], options },
      defaults,
    );
    const { user } = dict(body);
    expect(user).toBe(sent);
    expect(leftOut).toEqual(
      reported
        ? [
            {
              setting: 'user.long',
              detail:
                'The Responses API has no field for a user longer than 64 characters',
            },
          ]
        : [],
    );
  },
);

test('the long user id of an Anthropic Messages caller is left out of the request and reported', () => {
  const { request } = messages.decode(
    {
      model: 'coder',
      max_tokens: 64,
      metadata: { user_id: 'u'.repeat(150) },
      messages: [{ role: 'user', content: 'Hi' }],
    },
    new Headers(),
  );
  expect(request.options?.user).toBe('u'.repeat(150));
  const { body, leftOut } = encode('gpt-5', request);
  expect(body).not.toHaveProperty('user');
  expect(leftOut).toContainEqual({
    setting: 'user.long',
    detail:
      'The Responses API has no field for a user longer than 64 characters',
  });
});
