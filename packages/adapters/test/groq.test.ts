import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/groq.ts';
import { groq } from '../src/groq.ts';

test('built from Groq`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = groq({ key: 'sk-host' });

  expect(adapter.serves('groq/qwen/qwen3-32b')).toBe(true);
  expect(adapter.serves('openrouter/qwen/qwen3-32b')).toBe(false);
  expect(groq({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => groq({ key: undefined })).toThrow(
    'The groq adapter was given no key',
  );
  expect(() => groq({ key: '' })).toThrow();
  expect(() => groq({ key: ' \t' })).toThrow(
    'The groq adapter was given no key',
  );
});

test('a call goes to Chat Completions under the address with the key, and reasoning between think tags cut across chunks, a tool call and usage are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"0629","object":"chat.completion.chunk","model":"qwen/qwen3-32b","choices":[{"index":0,"delta":{"role":"assistant","content":"<thi"},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen/qwen3-32b","choices":[{"index":0,"delta":{"content":"nk>I need the weather tool.</th"},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen/qwen3-32b","choices":[{"index":0,"delta":{"content":"ink>Let me check."},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen/qwen3-32b","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_function_7k2","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Hangzhou\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen/qwen3-32b","choices":[],"usage":{"prompt_tokens":58,"completion_tokens":40,"total_tokens":98}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    groq({ key: 'sk-host', address: `${upstream.url}openai/v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/qwen/qwen3-32b',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    { path: '/openai/v1/chat/completions', key: 'Bearer sk-host' },
  ]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'I need the weather tool.' },
    { type: 'text', text: 'Let me check.' },
    {
      type: 'tool_call',
      id: 'call_function_7k2',
      name: 'get_weather',
      arguments: '{"city": "Hangzhou"}',
    },
    { type: 'finish', reason: 'tool_calls', usage: { input: 58, output: 40 } },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a model that sends its reasoning in a field of its own is read the same, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"chatcmpl-9d0","object":"chat.completion.chunk","model":"openai/gpt-oss-120b","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"17*23 is 391."},"finish_reason":null}]}

data: {"id":"chatcmpl-9d0","object":"chat.completion.chunk","model":"openai/gpt-oss-120b","choices":[{"index":0,"delta":{"content":"391"},"finish_reason":null}]}

data: {"id":"chatcmpl-9d0","object":"chat.completion.chunk","model":"openai/gpt-oss-120b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":12,"total_tokens":92}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    groq({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/openai/gpt-oss-120b',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([{ path: '/chat/completions', key: 'Bearer sk-host' }]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: '17*23 is 391.' },
    { type: 'text', text: '391' },
    { type: 'finish', reason: 'stop', usage: { input: 80, output: 12 } },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an order not to reason is the effort itself, and no reasoning format is asked for', async () => {
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
    groq({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/qwen/qwen3-32b',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'none',
      model: 'qwen/qwen3-32b',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an effort goes under OpenAI`s name at the level given', async () => {
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
    groq({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/openai/gpt-oss-120b',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'high',
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

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
    groq({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/qwen/qwen3-32b',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'qwen/qwen3-32b',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'reasoning.budgetTokens',
        detail:
          'Chat Completions has no field for a reasoning budget in tokens',
      },
    ],
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
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    groq({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/qwen/qwen3-32b',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        output: {
          schema: {
            type: 'object',
            properties: { product: { type: 'integer' } },
            required: ['product'],
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
          name: 'output',
          schema: {
            type: 'object',
            properties: { product: { type: 'integer' } },
            required: ['product'],
          },
          strict: false,
        },
      },
      model: 'qwen/qwen3-32b',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('no rule is known for what a model samples with, so a setting is sent as given', async () => {
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
    groq({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/qwen/qwen3-32b',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 2.5, topP: 0.9 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      temperature: 2.5,
      top_p: 0.9,
      model: 'qwen/qwen3-32b',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('reasoning goes back inside the assistant turn`s text, between the tags it came in', async () => {
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
    groq({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/qwen/qwen3-32b',
      {
        messages: [
          { role: 'user', text: 'Which is further north, Paris or Rome?' },
          {
            role: 'assistant',
            parts: [
              { type: 'reasoning', text: 'Paris is at 48 degrees.' },
              { type: 'text', text: 'Paris' },
            ],
          },
          { role: 'user', text: 'And further south?' },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      messages: [
        { role: 'user', content: 'Which is further north, Paris or Rome?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<think>Paris is at 48 degrees.</think>Paris',
            },
          ],
        },
        { role: 'user', content: 'And further south?' },
      ],
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 498,
    error: {
      type: 'flex_tier_error',
      message:
        'The flex tier is at capacity and the request will not be processed',
    },
    kind: 'overloaded',
  },
  {
    status: 429,
    error: {
      type: 'capacity_exceeded',
      message: 'The service is at capacity, try again later',
    },
    kind: 'overloaded',
  },
  {
    status: 413,
    error: {
      type: 'tokens',
      code: 'rate_limit_exceeded',
      message:
        'Request too large for model `qwen/qwen3-32b`: Limit 6000, Requested 20480, please reduce your message size and try again.',
    },
    kind: 'invalid_request',
  },
  {
    status: 429,
    error: {
      type: 'requests',
      code: 'rate_limit_exceeded',
      message:
        'Rate limit reached for model `qwen/qwen3-32b`. Please try again in 2.5s.',
    },
    kind: 'rate_limited',
  },
  {
    status: 404,
    error: {
      type: 'invalid_request_error',
      code: 'model_not_found',
      message:
        'The model `qwen/none` does not exist or you do not have access to it.',
    },
    kind: 'unknown_model',
  },
])(
  '$error.type told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      groq({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'groq/qwen/qwen3-32b',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: { code: kind, message: error.message, upstream: true },
      },
    ]);
  },
);

test.each([
  {
    status: 401,
    error: {
      type: 'invalid_request_error',
      code: 'invalid_api_key',
      message: 'Invalid API Key',
    },
    kind: 'upstream_refused',
  },
])(
  '$error.code told as $status is the host`s to mend, and its words are kept for the host, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      groq({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'groq/qwen/qwen3-32b',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: kind,
          message: "The upstream refused the host's credentials or account",
          upstream: true,
          provider: { groq: { message: error.message } },
        },
      },
    ]);
  },
);

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/groq.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['groq']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});

test.each([
  {
    status: 429,
    said: 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01m17c8ntqe9ba25dtdms847wq` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
    told: 'Rate limit reached for model `openai/gpt-oss-120b` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s.',
  },
  {
    status: 429,
    said: 'Limit of org_01m17c8ntqe9ba25dtdms847wq reached, in words not seen before',
    told: 'Limit of reached, in words not seen before',
  },
])(
  'what names the host`s account, and the way to its billing page, are cut from what the caller is told and kept for the host: $told',
  async ({ status, said, told }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error: { message: said, code: 'rate_limit_exceeded' } },
          { status },
        ),
    });
    const { models } = adapted([
      groq({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'groq/qwen/qwen3-32b',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: 'rate_limited',
          message: told,
          provider: { groq: { message: said } },
        },
      },
    ]);
  },
);

test.each([
  {
    status: 404,
    code: 'model_not_found',
    said: 'The model `org_01-preview` does not exist',
  },
  {
    status: 400,
    code: 'invalid_request_error',
    said: "tool call validation failed: attempted to call tool 'org_01m17c8ntqe9ba25dtdms847wq' which was not in request.tools",
  },
])(
  'a request told back to the caller keeps a name of the caller`s own, whatever its shape: $said',
  async ({ status, code, said }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ error: { message: said, code } }, { status }),
    });
    const { models } = adapted([
      groq({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'groq/qwen/qwen3-32b',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([{ type: 'error', error: { message: said } }]);
  },
);
