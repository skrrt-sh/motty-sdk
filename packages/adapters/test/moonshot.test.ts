import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/moonshot.ts';
import { moonshot } from '../src/moonshot.ts';

test('built from Kimi`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = moonshot({ key: 'sk-host' });

  expect(adapter.serves('moonshot/kimi-k3')).toBe(true);
  expect(adapter.serves('openrouter/moonshotai/kimi-k3')).toBe(false);
  expect(moonshot({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => moonshot({ key: undefined })).toThrow(
    'The moonshot adapter was given no key',
  );
  expect(() => moonshot({ key: '' })).toThrow();
  expect(() => moonshot({ key: ' \t' })).toThrow(
    'The moonshot adapter was given no key',
  );
});

test('a call goes to Chat Completions under the address with the key, and its reasoning, a tool call and usage are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"chatcmpl-6a1","object":"chat.completion.chunk","model":"kimi-k3","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"I need the weather tool."},"finish_reason":null}]}

data: {"id":"chatcmpl-6a1","object":"chat.completion.chunk","model":"kimi-k3","choices":[{"index":0,"delta":{"content":"Let me check."},"finish_reason":null}]}

data: {"id":"chatcmpl-6a1","object":"chat.completion.chunk","model":"kimi-k3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"get_weather:0","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Hangzhou\\"}"}}]},"finish_reason":null}]}

data: {"id":"chatcmpl-6a1","object":"chat.completion.chunk","model":"kimi-k3","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":19,"completion_tokens":21,"total_tokens":40}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    moonshot({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    { path: '/v1/chat/completions', key: 'Bearer sk-host' },
  ]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'I need the weather tool.' },
    { type: 'text', text: 'Let me check.' },
    {
      type: 'tool_call',
      id: 'get_weather:0',
      name: 'get_weather',
      arguments: '{"city":"Hangzhou"}',
    },
    { type: 'finish', reason: 'tool_calls', usage: { input: 19, output: 21 } },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('the newest model always reasons, so an order not to reason is left out and reported', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'reasoning.off',
        detail: 'Chat Completions has no field for an order not to reason',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('the newest model takes an effort at one of its three levels, the nearest for one it has not', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'medium' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'high',
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'reasoning.level',
        detail:
          'Chat Completions has no field for a reasoning effort the upstream has no level for, sent as the nearest it has',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('the newest model has no budget, which is left out and reported', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'kimi-k3',
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

test('a K2 model is told not to reason by its thinking switch', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k2.6',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      thinking: { type: 'disabled' },
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a K2 model has no effort: one turns its thinking switch on and the level is reported', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k2.6',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      thinking: { type: 'enabled' },
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'reasoning.effort',
        detail: 'Chat Completions has no field for a level of reasoning effort',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('a budget turns a K2 model`s thinking switch on, and its amount is reported', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k2.6',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      thinking: { type: 'enabled' },
      model: 'kimi-k2.6',
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

test('a coding model refuses the switch and has no effort, so neither word is sent', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k2.7-code',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'kimi-k2.7-code',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'reasoning.off',
        detail: 'Chat Completions has no field for an order not to reason',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('an older model has no word for reasoning at all', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/moonshot-v1-8k',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'reasoning.effort',
        detail: 'Chat Completions has no field for a level of reasoning effort',
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
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
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a temperature, a top-p and a penalty are fixed on a current model: each is left out and reported', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: {
          temperature: 0.2,
          topP: 0.5,
          presencePenalty: 1,
          frequencyPenalty: 1,
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'temperature.model',
        detail:
          'Chat Completions has no field for a temperature the model does not take',
      },
      {
        setting: 'topP.model',
        detail:
          'Chat Completions has no field for top-p sampling the model does not take',
      },
      {
        setting: 'presencePenalty.model',
        detail:
          'Chat Completions has no field for a presence penalty the model does not take',
      },
      {
        setting: 'frequencyPenalty.model',
        detail:
          'Chat Completions has no field for a frequency penalty the model does not take',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 4);
});

test('the one temperature and top-p a current model allows ask for nothing', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 1, topP: 0.95 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a K2 model that does not think allows another temperature', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k2.6',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 0.6, reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      thinking: { type: 'disabled' },
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an older model still samples, within its range', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/moonshot-v1-8k',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 1.5, presencePenalty: 1 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      presence_penalty: 1,
      temperature: 1,
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'temperature.range',
        detail:
          "Chat Completions has no field for a temperature outside the model's range, sent as the nearest inside",
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('reasoning goes back on the assistant turn as reasoning_content', async () => {
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
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'moonshot/kimi-k3',
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
          content: [{ type: 'text', text: 'Paris' }],
          reasoning_content: 'Paris is at 48 degrees.',
        },
        { role: 'user', content: 'And further south?' },
      ],
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 429,
    error: {
      type: 'exceeded_current_quota_error',
      message: 'Token quota is insufficient',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      type: 'engine_overloaded_error',
      message: 'The engine is currently overloaded, please try again later',
    },
    kind: 'overloaded',
  },
  {
    status: 429,
    error: {
      type: 'rate_limit_reached_error',
      message: 'Organization-level RPM limit reached',
    },
    kind: 'rate_limited',
  },
  {
    status: 400,
    error: {
      type: 'content_filter',
      message: 'The request was rejected because it was considered high risk',
    },
    kind: 'blocked',
  },
  {
    status: 404,
    error: {
      type: 'resource_not_found_error',
      message:
        'Model not found, or this account does not have permission to access the model',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: 'Input token length too long',
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: 'prompt tokens + max_tokens exceeds the model specification',
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    error: {
      type: 'invalid_request_error',
      message:
        'Invalid request: Your request exceeded model token limit: 262144 (requested: 300000)',
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    error: {
      type: 'invalid_request_error',
      message:
        'Request format error, missing required parameter, or invalid parameter type',
    },
    kind: 'invalid_request',
  },
  {
    status: 503,
    error: {
      type: 'server_unavailable',
      message: 'The service is temporarily unavailable',
    },
    kind: 'overloaded',
  },
])(
  '$error.type told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      moonshot({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'moonshot/kimi-k3',
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
      type: 'invalid_authentication_error',
      message: 'Invalid Authentication',
    },
    kind: 'upstream_refused',
  },
  {
    status: 401,
    error: {
      type: 'incorrect_api_key_error',
      message: 'Incorrect API key provided',
    },
    kind: 'upstream_refused',
  },
  {
    status: 403,
    error: {
      type: 'permission_denied_error',
      message: 'Your IP is not allowed to access this organization',
    },
    kind: 'upstream_refused',
  },
])(
  '$error.type told as $status is the host`s to mend, and its words are kept for the host, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      moonshot({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'moonshot/kimi-k3',
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
          provider: { moonshot: { message: error.message } },
        },
      },
    ]);
  },
);

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/moonshot.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['moonshot']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});

test.each([
  {
    status: 429,
    said: 'Your account org-0123456789abcdef0123456789abcdef<ak-a1b2c3d4e5f6g7h8i9j0> request reached organization max RPM: 3, please try again after 1 seconds',
    told: 'Your account request reached organization max RPM: 3, please try again after 1 seconds',
  },
  {
    status: 429,
    said: 'Limit of org-0123456789abcdef0123456789abcdef <cak-a1b2c3d4e5f6g7h8i9j0> reached, in words not seen before',
    told: 'Limit of reached, in words not seen before',
  },
])(
  'what names the host`s account and its key is cut from what the caller is told, and kept for the host: $told',
  async ({ status, said, told }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error: { message: said, type: 'rate_limit_reached_error' } },
          { status },
        ),
    });
    const { models } = adapted([
      moonshot({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'moonshot/kimi-k3',
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
          provider: { moonshot: { message: said } },
        },
      },
    ]);
  },
);

test.each([
  'Invalid request: tool name <ak-47> is not allowed',
  'Invalid request: tool name <ak-a1b2c3d4e5f6g7h8i9j0> is not allowed',
  'Invalid request: function org-0123456789abcdef0123456789abcdef is not defined',
])(
  'a request told back to the caller keeps a name of the caller`s own, whatever its shape: %s',
  async (said) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error: { message: said, type: 'invalid_request_error' } },
          { status: 400 },
        ),
    });
    const { models } = adapted([
      moonshot({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'moonshot/kimi-k3',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([{ type: 'error', error: { message: said } }]);
  },
);
