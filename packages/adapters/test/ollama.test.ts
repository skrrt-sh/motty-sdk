import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/ollama.ts';
import { ollama } from '../src/ollama.ts';

test('built from Ollama`s reference alone, with no server run: it serves the names under its prefix, and is made with no key', () => {
  const adapter = ollama();

  expect(adapter.serves('ollama/qwen3')).toBe(true);
  expect(adapter.serves('local/qwen3')).toBe(false);
  expect(ollama({ prefix: 'own' }).serves('own/x')).toBe(true);
  expect(ollama({ key: '' }).serves('ollama/x')).toBe(true);
  expect(ollama({ key: ' ' }).serves('ollama/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
});

test('with no key a call carries no credential, and its reasoning, a tool call and usage are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"chatcmpl-411","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"I need the weather tool."},"finish_reason":null}]}

data: {"id":"chatcmpl-411","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"id":"call_k1vq","index":0,"type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\"Hangzhou\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"chatcmpl-411","object":"chat.completion.chunk","model":"qwen3","choices":[],"usage":{"prompt_tokens":150,"completion_tokens":61,"total_tokens":211}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([ollama({ address: `${upstream.url}v1` })]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([{ path: '/v1/chat/completions', key: null }]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'I need the weather tool.' },
    {
      type: 'tool_call',
      id: 'call_k1vq',
      name: 'get_weather',
      arguments: '{"city":"Hangzhou"}',
    },
    { type: 'finish', reason: 'tool_calls', usage: { input: 150, output: 61 } },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a key that was given goes as a bearer token', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    ollama({ key: 'sk-cloud', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([{ path: '/chat/completions', key: 'Bearer sk-cloud' }]);
  expect(events).toMatchObject([
    { type: 'text', text: '391' },
    { type: 'finish', reason: 'stop' },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an order not to reason is the effort itself', async () => {
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
  const { models } = adapted([ollama({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
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
      model: 'qwen3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an effort goes under OpenAI`s name at the level given, and the limit under the older name', async () => {
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
  const { models } = adapted([ollama({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { maxTokens: 300, reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'high',
      max_tokens: 300,
      model: 'qwen3',
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
  const { models } = adapted([ollama({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'qwen3',
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
  const { models } = adapted([ollama({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
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
      model: 'qwen3',
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
  const { models } = adapted([ollama({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
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
      model: 'qwen3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('reasoning goes back on the assistant turn as reasoning', async () => {
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
  const { models } = adapted([ollama({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'ollama/qwen3',
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
          reasoning: 'Paris is at 48 degrees.',
        },
        { role: 'user', content: 'And further south?' },
      ],
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 404,
    error: {
      message: 'model "qwen9" not found, try pulling it first',
      type: 'not_found_error',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    error: {
      message: 'invalid message content type: <nil>',
      type: 'invalid_request_error',
    },
    kind: 'invalid_request',
  },
])(
  'a failure told as $status is $kind by its status, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([ollama({ address: upstream.url.origin })]);

    const events = await Array.fromAsync(
      models(
        'ollama/qwen3',
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

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/ollama.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['ollama']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
