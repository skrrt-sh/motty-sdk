import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
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

test.each([
  [{ effort: 'high' } as const, { effort: 'high', summary: 'auto' }],
  [{ budgetTokens: 2048 }, { summary: 'auto' }],
  [{ effort: 'high', exclude: true } as const, { effort: 'high' }],
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

test('a request whose reasoning asks for nothing is sent the connection`s as stated', () => {
  const { body } = encode(
    'gpt-5',
    { messages: [{ role: 'user', text: 'Hi' }], options: { reasoning: {} } },
    { reasoning: { effort: 'low' } },
  );
  expect(body).toHaveProperty('reasoning', { effort: 'low' });
});

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

test.each([
  [{ openai: { some_new_field: 1 } }, { some_new_field: 1 }],
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

test('an option under the provider`s key that only Chat Completions has fails the call', () => {
  expect(() =>
    encode('gpt-5', {
      messages: [{ role: 'user', text: 'Hi' }],
      options: { provider: { openai: { logit_bias: { '50256': -100 } } } },
    }),
  ).toThrow(
    new Unsupported(
      'The Responses API cannot carry logit_bias, which another API of openai has',
    ),
  );
});

test.each([
  ['of 64 characters', { user: 'u'.repeat(64) }, {}, 'u'.repeat(64), false],
  ['of 65 characters', { user: 'u'.repeat(65) }, {}, undefined, true],
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
