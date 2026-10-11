import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/together.ts';
import { together } from '../src/together.ts';

test('built from Together`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = together({ key: 'sk-host' });

  expect(adapter.serves('together/deepseek-ai/DeepSeek-V4-Pro-0813')).toBe(
    true,
  );
  expect(adapter.serves('openrouter/deepseek-ai/DeepSeek-V4-Pro-0813')).toBe(
    false,
  );
  expect(together({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => together({ key: undefined })).toThrow(
    'The together adapter was given no key',
  );
  expect(() => together({ key: '' })).toThrow();
  expect(() => together({ key: ' \t' })).toThrow(
    'The together adapter was given no key',
  );
});

test('a call goes to Chat Completions under the address with the key, and reasoning in a field of its own, a tool call and usage with what was cached and reasoned are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"p4hH3vo-2kFHot","object":"chat.completion.chunk","created":1773842038,"model":"deepseek-ai/DeepSeek-V4-Pro-0813","choices":[{"index":0,"delta":{"role":"assistant","reasoning":"I need the weather tool."},"finish_reason":null}]}

data: {"id":"p4hH3vo-2kFHot","object":"chat.completion.chunk","created":1773842038,"model":"deepseek-ai/DeepSeek-V4-Pro-0813","choices":[{"index":0,"delta":{"role":"assistant","content":"Let me check."},"finish_reason":null}]}

data: {"id":"p4hH3vo-2kFHot","object":"chat.completion.chunk","created":1773842038,"model":"deepseek-ai/DeepSeek-V4-Pro-0813","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_7k2","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3417,"completion_tokens":40,"total_tokens":3457,"prompt_tokens_details":{"cached_tokens":3327},"completion_tokens_details":{"reasoning_tokens":12}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    together({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/deepseek-ai/DeepSeek-V4-Pro-0813',
      { messages: [{ role: 'user', text: 'Weather in Paris?' }] },
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
      id: 'call_7k2',
      name: 'get_weather',
      arguments: '{"location":"Paris"}',
    },
    {
      type: 'finish',
      reason: 'tool_calls',
      usage: { input: 3417, output: 40, cached: 3327, reasoning: 12 },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

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

test('a budget turns the flag on, and its amount is left out and reported', async () => {
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
      'together/Qwen/Qwen3.6-Plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning: { enabled: true },
      model: 'Qwen/Qwen3.6-Plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [{ setting: 'reasoning.budgetTokens' }],
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
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/deepseek-ai/DeepSeek-V4-Pro-0813',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        output: {
          name: 'math_reasoning',
          schema: {
            type: 'object',
            properties: { final_answer: { type: 'string' } },
            required: ['final_answer'],
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
          name: 'math_reasoning',
          schema: {
            type: 'object',
            properties: { final_answer: { type: 'string' } },
            required: ['final_answer'],
          },
          strict: false,
        },
      },
      model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
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
    together({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'together/meta-llama/Llama-3.3-70B-Instruct-Turbo',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 1.2, topP: 0.9, seed: 42 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      seed: 42,
      temperature: 1.2,
      top_p: 0.9,
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('reasoning goes back under the name `reasoning` to a model that sent it so', async () => {
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
      model: 'deepseek-ai/DeepSeek-V4-Pro-0813',
      messages: [
        { role: 'user', content: 'Which is further north, Paris or Rome?' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Paris' }],
          reasoning: 'Paris is at 48 degrees.',
        },
        { role: 'user', content: 'And further south?' },
      ],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
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

test('reasoning goes back between the tags to the model that sent it so', async () => {
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
      model: 'deepseek-ai/DeepSeek-R1',
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
  {
    status: 429,
    error: {
      message: 'Serverless requests are being limited during high demand.',
      type: 'rate_limit',
      param: null,
      code: null,
    },
    kind: 'rate_limited',
  },
  {
    status: 503,
    error: {
      message: 'The service is temporarily unavailable.',
      type: 'service_unavailable',
      param: null,
      code: null,
    },
    kind: 'overloaded',
  },
  {
    status: 524,
    error: {
      message: 'The connection timed out at the network edge.',
      type: 'timeout',
      param: null,
      code: null,
    },
    kind: 'timed_out',
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
  ['an empty body', () => new Response('', { status: 403 })],
  [
    'JSON that is no error of its own',
    () => Response.json({ blocked: true }, { status: 403 }),
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

test('a spent limit told as 402 is a quota, and the sentence that links into the host`s account is kept from the caller', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message:
              'The account has reached its maximum allowed monthly spending limit. Adjust your billing settings at https://api.together.ai/settings/billing.',
            type: 'credit_limit',
            param: null,
            code: null,
          },
        },
        { status: 402 },
      ),
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
      error: {
        code: 'quota_exceeded',
        message:
          'The account has reached its maximum allowed monthly spending limit.',
        upstream: true,
      },
    },
  ]);
});

test.each([
  {
    status: 401,
    error: {
      message:
        'Invalid API key provided. You can find your API key at https://api.together.ai/settings/api-keys.',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_api_key',
    },
  },
])(
  'a refusal of the host`s key or account told as $status is the host`s to mend, and its words are kept for the host',
  async ({ status, error }) => {
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
        error: {
          code: 'upstream_refused',
          message: "The upstream refused the host's credentials or account",
          upstream: true,
          provider: { together: { message: error.message } },
        },
      },
    ]);
  },
);

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/together.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['together']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
