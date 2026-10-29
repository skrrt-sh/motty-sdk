import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { moonshot } from '../src/moonshot.ts';

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
    status: 429,
    said: 'Your account org-f3575b7f8db2491484802c82c85d1e60 / proj-3e64ded3bb8f4d2ca52cf30e20059f8b <ak-a1b2c3d4e5f6g7h8i9j0> request reached organization TPD rate limit, current: 1500246, limit: 1500000',
    told: 'Your account request reached organization TPD rate limit, current: 1500246, limit: 1500000',
  },
  {
    status: 429,
    said: 'Limit of proj-3e64ded3bb8f4d2ca52cf30e20059f8b reached, in words not seen before',
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

test('a marker kept an hour asks the newest model to keep the whole prefix an hour, and is no warning; K2 is told nothing', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":300,"cache_write_tokens":600}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    moonshot({ key: 'sk-host', address: upstream.url.origin }),
  ]);
  const asked = (model: string) =>
    Array.fromAsync(
      models(
        model,
        {
          messages: [
            { role: 'system', text: 'A long manual', cache: { ttl: '1h' } },
            { role: 'user', text: 'What is 17*23?' },
          ],
        },
        AbortSignal.timeout(5000),
      ),
    );

  const newest = await asked('moonshot/kimi-k3.1-pro');
  await asked('moonshot/kimi-k2.6');

  expect(seen).toMatchObject([
    {
      prompt_cache_options: { mode: 'implicit', ttl: '1h' },
      messages: [
        { role: 'system', content: 'A long manual' },
        { role: 'user', content: 'What is 17*23?' },
      ],
    },
    { model: 'kimi-k2.6' },
  ]);
  expect(seen[1]).not.toHaveProperty('prompt_cache_options');
  expect(newest.at(-1)).toMatchObject({
    type: 'finish',
    usage: { input: 1000, output: 1, cached: 300, cacheWrite: 600 },
  });
  expect(newest.at(-1)).not.toHaveProperty('warnings');
});
