import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { dashscope } from '../src/dashscope.ts';

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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
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

test('an order not to reason sets the thinking flag to false', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      enable_thinking: false,
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('top-k sampling is sent to a Qwen model, and nothing is reported', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { topK: 40 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      top_k: 40,
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('top-k sampling is left out for a model of another maker served here, and reported', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/kimi-k3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { topK: 40 },
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
    warnings: [{ setting: 'topK.model' }],
  });
});

test('an effort is not sent: it sets the thinking flag, and its level is reported', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      enable_thinking: true,
      model: 'qwen3.7-plus',
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

test('a budget sets the thinking flag and goes beside it', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      enable_thinking: true,
      thinking_budget: 2000,
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 400,
    error: {
      code: 'Arrearage',
      message:
        'Access denied, please make sure your account is in good standing.',
      type: 'Arrearage',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: 'PrepaidBillOverdue',
      message: 'The prepaid bill is overdue.',
      type: 'PrepaidBillOverdue',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: 'insufficient_quota',
      message:
        'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota',
    },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: 'Throttling.ServiceOverloaded',
      message:
        'InternalError.Algo: An error occurred in model serving, error message is: [Too many requests.]',
      type: 'Throttling.ServiceOverloaded',
    },
    kind: 'overloaded',
  },
  {
    status: 400,
    error: {
      code: 'data_inspection_failed',
      message: 'Input data may contain inappropriate content.',
      type: 'data_inspection_failed',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    error: {
      code: 'invalid_parameter_error',
      message: 'Range of input length should be [1, 129024]',
      type: 'invalid_request_error',
    },
    kind: 'context_too_long',
  },
  {
    status: 400,
    error: {
      code: 'InvalidParameter',
      message: 'Model not exist.',
      type: 'InvalidParameter',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    error: {
      code: 'invalid_parameter_error',
      message: 'The tool_choice parameter must be "auto" or "none".',
      type: 'invalid_request_error',
    },
    kind: 'invalid_request',
  },
])(
  '$error.code told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      dashscope({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'dashscope/qwen3.7-plus',
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

test('a marker is sent as a marker of five minutes, an hour is reported, and the cache written is read', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_input_tokens":990}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [
          { role: 'system', text: 'A long manual', cache: { ttl: '1h' } },
          { role: 'user', text: 'What is 17*23?' },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'A long manual',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
        { role: 'user', content: 'What is 17*23?' },
      ],
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    usage: { input: 1000, output: 1, cached: 0, cacheWrite: 990 },
    warnings: [{ setting: 'cache.ttl' }],
  });
});
