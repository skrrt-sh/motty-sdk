import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { together } from '../src/together.ts';

test('reasoning under the other name, and reasoning between think tags from the one model that sends it so, are read the same, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Kimi and GLM think here."},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"<think>\\n0.9 is larger"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"role":"assistant","content":" than 0.11.\\n</think>\\n9.9 is bigger."},"finish_reason":"eos"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/deepseek-ai/DeepSeek-R1',
      { messages: [{ role: 'user', text: 'Weather in Paris?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([{ path: '/chat/completions', key: 'Bearer sk-host' }]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'Kimi and GLM think here.' },
    { type: 'reasoning', text: '\n0.9 is larger' },
    { type: 'reasoning', text: ' than 0.11.\n' },
    { type: 'text', text: '\n9.9 is bigger.' },
    { type: 'finish', reason: 'stop', rawReason: 'eos' },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('cached tokens a model reports at the top of usage, with no details around them, are read, by its reference', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Five days."},"finish_reason":"eos"}],"usage":{"prompt_tokens":3417,"completion_tokens":3,"total_tokens":3420,"cached_tokens":3327}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
      { messages: [{ role: 'user', text: 'How long do refunds take?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    { type: 'text', text: 'Five days.' },
    {
      type: 'finish',
      reason: 'stop',
      rawReason: 'eos',
      usage: { input: 3417, output: 3, cached: 3327 },
    },
  ]);
});

test('an order not to reason turns the flag of a hybrid model off, and the output limit and top-k go under Together`s names', async () => {
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
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/zai-org/GLM-5.2',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' }, maxTokens: 64, topK: 40 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning: { enabled: false },
      max_tokens: 64,
      top_k: 40,
      model: 'zai-org/GLM-5.2',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an effort goes under OpenAI`s name at one of three levels, the nearest for one it has not', async () => {
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
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/deepseek-ai/DeepSeek-V4-Pro-0813',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'max' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'high',
      model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [{ setting: 'reasoning.level' }],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('the model with an effort and no flag is not told to stop reasoning, which is reported', async () => {
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
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/openai/gpt-oss-120b',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [{ setting: 'reasoning.off' }],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('the model that always reasons is sent neither a flag nor an effort, which is reported', async () => {
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
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/deepseek-ai/DeepSeek-R1',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'low' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'deepseek-ai/DeepSeek-R1',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [{ setting: 'reasoning.effort' }],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('reasoning goes back under the name `reasoning_content` to a model that sent it so', async () => {
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
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/moonshotai/Kimi-K3',
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

  expect(seen).toEqual([
    {
      model: 'moonshotai/Kimi-K3',
      messages: [
        { role: 'user', content: 'Which is further north, Paris or Rome?' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Paris' }],
          reasoning_content: 'Paris is at 48 degrees.',
        },
        { role: 'user', content: 'And further south?' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 403,
    error: {
      message:
        'Input token count + max_tokens must be less than the context length of the model.',
      type: 'invalid_request_error',
      param: null,
      code: null,
    },
    kind: 'context_too_long',
  },
  {
    status: 404,
    error: {
      message: 'Unable to access model gpt-4o.',
      type: 'invalid_request_error',
      param: null,
      code: null,
    },
    kind: 'unknown_model',
  },
])(
  'a failure told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      together({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'together/zai-org/GLM-5.2',
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
  [
    'a page of the network before it',
    () =>
      new Response(
        '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1></body></html>',
        { status: 403, headers: { 'content-type': 'text/html' } },
      ),
  ],
])(
  'a 403 with %s says nothing of the prompt, and is a refusal as any upstream`s 403 is',
  async (_, fetch) => {
    using upstream = Bun.serve({ port: 0, fetch });
    const { models } = adapted([
      together({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'together/zai-org/GLM-5.2',
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
          provider: { together: { status: 403 } },
          upstream: true,
        },
      },
    ]);
  },
);
