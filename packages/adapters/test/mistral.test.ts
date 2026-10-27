import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { mistral } from '../src/mistral.ts';

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

test.each([
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

test.each([
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
