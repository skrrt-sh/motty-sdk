import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { groq } from '../src/groq.ts';

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

test.each([
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
    status: 429,
    said: 'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01m17c8ntqe9ba25dtdms847wq` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing',
    told: 'Rate limit reached for model `openai/gpt-oss-120b` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 5912, Requested 4676. Please try again in 19.41s.',
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
