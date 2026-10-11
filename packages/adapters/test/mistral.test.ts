import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/mistral.ts';
import { mistral } from '../src/mistral.ts';

test('built from Mistral`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = mistral({ key: 'sk-host' });

  expect(adapter.serves('mistral/mistral-medium-3-5')).toBe(true);
  expect(adapter.serves('openrouter/mistralai/mistral-medium-3-5')).toBe(false);
  expect(mistral({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => mistral({ key: undefined })).toThrow(
    'The mistral adapter was given no key',
  );
  expect(() => mistral({ key: '' })).toThrow();
  expect(() => mistral({ key: ' \t' })).toThrow(
    'The mistral adapter was given no key',
  );
});

test('a call goes to Chat Completions under the address with the key, and content that is a list while the model thinks and a string after, a tool call and usage are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"0d93cd053f4c4b3ca627ccd07cf2f18c","object":"chat.completion.chunk","created":1773842038,"model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"0d93cd053f4c4b3ca627ccd07cf2f18c","object":"chat.completion.chunk","created":1773842038,"model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"I need the "}]}]},"finish_reason":null}]}

data: {"id":"0d93cd053f4c4b3ca627ccd07cf2f18c","object":"chat.completion.chunk","created":1773842038,"model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"weather tool."}]},{"type":"text","text":"Let me"}]},"finish_reason":null}]}

data: {"id":"0d93cd053f4c4b3ca627ccd07cf2f18c","object":"chat.completion.chunk","created":1773842038,"model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":" check."},"finish_reason":null}]}

data: {"id":"0d93cd053f4c4b3ca627ccd07cf2f18c","object":"chat.completion.chunk","created":1773842038,"model":"mistral-medium-3-5","choices":[{"index":0,"delta":{"content":"","tool_calls":[{"id":"D681PevKs","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Paris\\"}"},"index":0}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":1013,"total_tokens":1043,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":1008}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-medium-3-5',
      { messages: [{ role: 'user', text: 'Weather in Paris?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    { path: '/v1/chat/completions', key: 'Bearer sk-host' },
  ]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'I need the ' },
    { type: 'reasoning', text: 'weather tool.' },
    { type: 'text', text: 'Let me' },
    { type: 'text', text: ' check.' },
    {
      type: 'tool_call',
      id: 'D681PevKs',
      name: 'get_weather',
      arguments: '{"city": "Paris"}',
    },
    {
      type: 'finish',
      reason: 'tool_calls',
      usage: { input: 1013, output: 30, cached: 1008 },
    },
  ]);
  expect(events).toHaveLength(6);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an answer the model`s own length limit ended is an ending by length, under Mistral`s word for it', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"And so"},"finish_reason":"model_length"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      { messages: [{ role: 'user', text: 'Go on.' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    { type: 'text', text: 'And so' },
    { type: 'finish', reason: 'length', rawReason: 'model_length' },
  ]);
});

test('an answer Mistral ends with its word for an error is a failed call worth another try, with what came and the usage, and no finish', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"And so"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}],"usage":{"prompt_tokens":7,"total_tokens":9,"completion_tokens":2}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      { messages: [{ role: 'user', text: 'Go on.' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    { type: 'text', text: 'And so' },
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream failed before it finished',
        retryable: true,
        provider: { mistral: { finish_reason: 'error' } },
        upstream: true,
      },
      usage: { input: 7, output: 2 },
    },
  ]);
});

test('the request holds only fields Mistral lists: no stream options, the seed and the output limit under its names, and an end user left out and reported', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: {
          seed: 7,
          maxTokens: 64,
          user: 'user-1',
          toolChoice: 'required',
          stop: ['\n\n'],
        },
        tools: [
          {
            type: 'function',
            name: 'multiply',
            input: { type: 'object', properties: {} },
          },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tools: [
        {
          type: 'function',
          function: {
            name: 'multiply',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      tool_choice: 'required',
      stop: ['\n\n'],
      max_tokens: 64,
      random_seed: 7,
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      { setting: 'user', detail: 'Mistral has no field for an end user' },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('a connection`s own fields go in Mistral`s names, and the request`s seed replaces the connection`s', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    mistral({
      key: 'sk-host',
      address: upstream.url.origin,
      body: { safe_prompt: true, random_seed: 1 },
    }),
  ]);

  await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );
  await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      { messages: [{ role: 'user', text: 'hi' }], options: { seed: 7 } },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      safe_prompt: true,
      random_seed: 1,
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    },
    {
      safe_prompt: true,
      random_seed: 7,
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    },
  ]);
});

test.each([
  { effort: 'none', sent: 'none', warned: [] },
  { effort: 'high', sent: 'high', warned: [] },
  { effort: 'max', sent: 'xhigh', warned: ['reasoning.level'] },
] as const)(
  'an effort of $effort goes under OpenAI`s name as $sent, the order not to reason included',
  async ({ effort, sent, warned }) => {
    const seen: unknown[] = [];
    using upstream = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seen.push(await request.json());
        return new Response(
          `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const { models } = adapted([
      mistral({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'mistral/mistral-medium-3-5',
        {
          messages: [{ role: 'user', text: 'What is 17*23?' }],
          options: { reasoning: { effort } },
        },
        AbortSignal.timeout(5000),
      ),
    );

    expect(seen).toEqual([
      {
        reasoning_effort: sent,
        model: 'mistral-medium-3-5',
        messages: [{ role: 'user', content: 'What is 17*23?' }],
        stream: true,
      },
    ]);
    const [finish] = events.slice(-1);
    expect(
      finish?.type === 'finish'
        ? (finish.warnings ?? []).map(({ setting }) => setting)
        : undefined,
    ).toEqual([...warned]);
  },
);

test('a budget has no field, and is left out and reported', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-medium-3-5',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'mistral-medium-3-5',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [{ setting: 'reasoning.budgetTokens' }],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('a JSON output goes with its schema', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"product\\":391}"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        output: {
          name: 'product',
          strict: true,
          schema: {
            type: 'object',
            properties: { product: { type: 'integer' } },
            required: ['product'],
            additionalProperties: false,
          },
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'product',
          schema: {
            type: 'object',
            properties: { product: { type: 'integer' } },
            required: ['product'],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a temperature and a top-p outside Mistral`s ranges are sent as the nearest inside, and top-k has no field', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 2, topP: 0, topK: 40, presencePenalty: 1 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      temperature: 1.5,
      top_p: 0.01,
      presence_penalty: 1,
      model: 'mistral-small-latest',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
    },
  ]);
  const [finish] = events.slice(-1);
  expect(
    finish?.type === 'finish'
      ? (finish.warnings ?? []).map(({ setting }) => setting).sort()
      : undefined,
  ).toEqual(['temperature.range', 'topK', 'topP.range']);
});

test('reasoning goes back as a thinking chunk of the assistant turn`s content, as its reference asks', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"1173"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-medium-3-5',
      {
        messages: [
          { role: 'user', text: 'What is 17 * 23?' },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: '340 + 51 = 391.' },
              { type: 'text', text: '17 * 23 = 391.' },
            ],
          },
          { role: 'user', text: 'Now multiply that by 3.' },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      messages: [
        { role: 'user', content: 'What is 17 * 23?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: [{ type: 'text', text: '340 + 51 = 391.' }],
            },
            { type: 'text', text: '17 * 23 = 391.' },
          ],
        },
        { role: 'user', content: 'Now multiply that by 3.' },
      ],
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 404,
    body: {
      object: 'error',
      message: 'The model does not exist.',
      type: 'invalid_request_error',
      param: 'model',
      code: 'unknown_model',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    body: {
      object: 'error',
      message: 'The model does not exist.',
      type: 'invalid_request_error',
      param: 'model',
      code: 'unknown_model',
    },
    kind: 'unknown_model',
  },
  {
    status: 429,
    body: {
      object: 'error',
      message: 'Requests rate limit exceeded.',
      type: 'rate_limit_error',
    },
    kind: 'rate_limited',
  },
  {
    status: 400,
    body: {
      object: 'error',
      message: 'The temperature is outside the range from 0 to 1.5.',
      type: 'invalid_request_error',
      param: 'temperature',
    },
    kind: 'invalid_request',
  },
  {
    status: 500,
    body: {
      object: 'error',
      message: 'An unexpected error occurred.',
      type: 'server_error',
    },
    kind: 'upstream_failed',
  },
  {
    status: 503,
    body: {
      object: 'error',
      message: 'The service is temporarily overloaded.',
      type: 'server_error',
    },
    kind: 'overloaded',
  },
])(
  '$body.type told as $status at the top of the body is $kind, in the upstream`s words, by its reference',
  async ({ status, body, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json(body, { status }),
    });
    const { models } = adapted([
      mistral({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'mistral/mistral-small-latest',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: kind,
          message: body.message,
          upstream: true,
          provider: { mistral: { status, type: body.type } },
        },
      },
    ]);
  },
);

test('a field Mistral refuses is told with what was wrong and where, by its reference', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          detail: [
            {
              type: 'less_than_equal',
              loc: ['body', 'temperature'],
              msg: 'Input should be less than or equal to 1.5',
              input: 2,
              ctx: { le: 1.5 },
            },
            {
              type: 'extra_forbidden',
              loc: ['body', 'top_k'],
              msg: 'Extra inputs are not permitted',
              input: 40,
            },
          ],
        },
        { status: 422 },
      ),
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'invalid_request',
        status: 422,
        message:
          'body.temperature: Input should be less than or equal to 1.5; body.top_k: Extra inputs are not permitted',
        upstream: true,
      },
    },
  ]);
});

test.each([
  {
    status: 401,
    body: { detail: 'Invalid API Key' },
    said: 'Invalid API Key',
  },
  {
    status: 401,
    body: {
      object: 'error',
      message: 'The API key is missing, invalid, or expired.',
      type: 'authentication_error',
    },
    said: 'The API key is missing, invalid, or expired.',
  },
  {
    status: 400,
    body: {
      object: 'error',
      message: 'The API key was revoked.',
      type: 'authentication_error',
    },
    said: 'The API key was revoked.',
  },
])(
  'a refused key told as $status is the host`s to mend, and its words are kept for the host',
  async ({ status, body, said }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json(body, { status }),
    });
    const { models } = adapted([
      mistral({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'mistral/mistral-small-latest',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: 'upstream_refused',
          message: "The upstream refused the host's credentials or account",
          upstream: true,
          provider: { mistral: { message: said } },
        },
      },
    ]);
  },
);

test('a body that is no JSON is told by its status', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () => new Response('upstream connect error', { status: 502 }),
  });
  const { models } = adapted([
    mistral({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'mistral/mistral-small-latest',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    { type: 'error', error: { code: 'upstream_failed', upstream: true } },
  ]);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/mistral.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['mistral']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
