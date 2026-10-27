import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { zai } from '../src/zai.ts';

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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
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

test('an order not to reason turns the thinking switch off, and tool arguments are asked to stream', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: true,
      thinking: { type: 'disabled' },
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an effort goes at one of the three levels, the nearest for one it has not', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'medium' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: true,
      reasoning_effort: 'high',
      model: 'glm-5.3',
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

test('a schema is asked for as any JSON object, and reported', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
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
      tool_stream: true,
      response_format: { type: 'json_object' },
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'output.schema',
        detail:
          'Chat Completions has no field for the schema of a JSON output, to an upstream that takes any JSON object',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('a temperature and a top-p outside the range go as the nearest inside, a penalty has no field, and the limit is named as this API names it', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: {
          temperature: 1.5,
          topP: 0,
          presencePenalty: 1,
          maxTokens: 50,
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: true,
      max_tokens: 50,
      temperature: 1,
      top_p: 0.01,
      model: 'glm-5.3',
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
      {
        setting: 'topP.range',
        detail:
          "Chat Completions has no field for top-p sampling outside the model's range, sent as the nearest inside",
      },
      {
        setting: 'presencePenalty.model',
        detail:
          'Chat Completions has no field for a presence penalty the model does not take',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 3);
});

test('the host`s own body field replaces the one the adapter sets', async () => {
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
    zai({
      key: 'sk-host',
      address: upstream.url.origin,
      body: { tool_stream: false, do_sample: false },
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-4.5',
      { messages: [{ role: 'user', text: 'What is 17*23?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: false,
      do_sample: false,
      model: 'glm-4.5',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 429,
    error: {
      code: '1113',
      message: 'Insufficient balance or no resource package. Please recharge.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1305',
      message:
        'The service may be temporarily overloaded, please try again later',
    },
    kind: 'overloaded',
  },
  {
    status: 429,
    error: {
      code: '1311',
      message:
        'Your current subscription plan does not yet include access to glm-5.3',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    error: { code: '1261', message: 'Prompt too long' },
    kind: 'context_too_long',
  },
  {
    status: 400,
    error: {
      code: '1301',
      message:
        'System detected potentially unsafe or sensitive content in input or generation.',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    error: {
      code: '1212',
      message: 'Current model does not support stream call method',
    },
    kind: 'unsupported',
  },
])(
  'code $error.code told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      zai({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'zai/glm-5.3',
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
    error: {
      code: '1315',
      message:
        'This API Key is limited to enterprise coding package scenarios.',
    },
    kind: 'upstream_refused',
  },
])(
  'code $error.code told as $status is the host`s to mend, and its words are kept for the host, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      zai({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'zai/glm-5.3',
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
          provider: { zai: { message: error.message } },
        },
      },
    ]);
  },
);
