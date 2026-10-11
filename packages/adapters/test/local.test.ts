import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/local.ts';
import { local } from '../src/local.ts';

test('built from the references of LM Studio, vLLM and llama.cpp alone, with no server run: it serves the names under its prefix, and is made with no key', () => {
  const adapter = local({ address: 'http://localhost:1234/v1' });

  expect(adapter.serves('local/qwen3')).toBe(true);
  expect(adapter.serves('ollama/qwen3')).toBe(false);
  expect(
    local({ address: 'http://localhost:8000/v1', prefix: 'vllm' }).serves(
      'vllm/x',
    ),
  ).toBe(true);
  expect(adapter.decide).toBeUndefined();
});

test('with no key a call carries no credential, and a server said to tag its reasoning has it read from between think tags cut across chunks, with a tool call and usage, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"0629","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"role":"assistant","content":"<thi"},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"content":"nk>I need the weather tool.</th"},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"content":"ink>Let me check."},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_function_7k2","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Hangzhou\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"qwen3","choices":[],"usage":{"prompt_tokens":58,"completion_tokens":40,"total_tokens":98}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    local({ address: `${upstream.url}v1`, tagged: true }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([{ path: '/v1/chat/completions', key: null }]);
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
    local({ key: 'sk-own', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([{ path: '/chat/completions', key: 'Bearer sk-own' }]);
  expect(events).toMatchObject([
    { type: 'text', text: '391' },
    { type: 'finish', reason: 'stop' },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a server said to have the template`s switch is told not to reason by it', async () => {
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
    local({
      address: upstream.url.origin,
      tagged: true,
      asks: 'chat_template_kwargs',
      efforts: [],
      limit: 'max_tokens',
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      chat_template_kwargs: { enable_thinking: false },
      model: 'qwen3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a server said to have no effort has its switch turned on by one, and the level is reported', async () => {
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
    local({
      address: upstream.url.origin,
      tagged: true,
      asks: 'chat_template_kwargs',
      efforts: [],
      limit: 'max_tokens',
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      chat_template_kwargs: { enable_thinking: true },
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
        setting: 'reasoning.effort',
        detail: 'Chat Completions has no field for a level of reasoning effort',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('a budget turns the switch on, and its amount is reported', async () => {
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
    local({
      address: upstream.url.origin,
      tagged: true,
      asks: 'chat_template_kwargs',
      efforts: [],
      limit: 'max_tokens',
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      chat_template_kwargs: { enable_thinking: true },
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

test('a server said to take three efforts is sent the nearest, and one with no switch is not told not to reason', async () => {
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
    local({
      address: upstream.url.origin,
      thought: 'reasoning_content',
      efforts: ['low', 'medium', 'high'],
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
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
        setting: 'reasoning.level',
        detail:
          'Chat Completions has no field for a reasoning effort the upstream has no level for, sent as the nearest it has',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('an order not to reason is left out and reported where the server was said to have neither a switch nor that level', async () => {
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
    local({
      address: upstream.url.origin,
      thought: 'reasoning_content',
      efforts: ['low', 'medium', 'high'],
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
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
        setting: 'reasoning.off',
        detail: 'Chat Completions has no field for an order not to reason',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('the limit goes under the name the server was said to take', async () => {
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
    local({
      address: upstream.url.origin,
      tagged: true,
      asks: 'chat_template_kwargs',
      efforts: [],
      limit: 'max_tokens',
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { maxTokens: 300 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      max_tokens: 300,
      model: 'qwen3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a server nothing was said of is spoken to as OpenAI is', async () => {
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
  const { models } = adapted([local({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { maxTokens: 300, reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'none',
      max_completion_tokens: 300,
      model: 'qwen3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
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
    local({
      address: upstream.url.origin,
      tagged: true,
      asks: 'chat_template_kwargs',
      efforts: [],
      limit: 'max_tokens',
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
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

test('top-k sampling is sent to a server the host says takes it, and nothing is reported', async () => {
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
    local({ address: upstream.url.origin, topK: true }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
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
      model: 'qwen3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('top-k sampling is left out and reported for a server not said to take it', async () => {
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
  const { models } = adapted([local({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { topK: 40 },
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
    warnings: [{ setting: 'topK' }],
  });
});

test('no rule is known for what a model samples with unless the host states one', async () => {
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
    local({
      address: upstream.url.origin,
      takes: () => ({
        temperature: [0, 1],
        topP: [0, 1],
        topK: true,
        presencePenalty: true,
        frequencyPenalty: true,
        together: true,
        effort: true,
      }),
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 2.5, topP: 0.9 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      temperature: 1,
      top_p: 0.9,
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
        setting: 'temperature.range',
        detail:
          "Chat Completions has no field for a temperature outside the model's range, sent as the nearest inside",
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('the host`s body fields go with every call', async () => {
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
    local({
      address: upstream.url.origin,
      body: { cache_prompt: true },
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      { messages: [{ role: 'user', text: 'What is 17*23?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      cache_prompt: true,
      model: 'qwen3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('reasoning goes back inside the assistant turn`s text where the server was said to tag it', async () => {
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
    local({
      address: upstream.url.origin,
      tagged: true,
      asks: 'chat_template_kwargs',
      efforts: [],
      limit: 'max_tokens',
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
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

test('reasoning goes back in the field the server was said to take it in', async () => {
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
    local({
      address: upstream.url.origin,
      thought: 'reasoning_content',
      efforts: ['low', 'medium', 'high'],
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
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

test('a failure is named by its status and recorded under the name local', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message: 'The model `qwen9` does not exist.',
            type: 'NotFoundError',
            code: 404,
          },
        },
        { status: 404 },
      ),
  });
  const { models } = adapted([local({ address: upstream.url.origin })]);

  const events = await Array.fromAsync(
    models(
      'local/qwen9',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'unknown_model',
        message: 'The model `qwen9` does not exist.',
        provider: { local: { status: 404 } },
        upstream: true,
      },
    },
  ]);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/local.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['local']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});

test('the host`s headers go with every call', async () => {
  const seen: (string | null)[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(request.headers.get('x-team'));
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    local({ address: upstream.url.origin, headers: { 'x-team': 'core' } }),
  ]);

  await Array.fromAsync(
    models(
      'local/qwen3',
      { messages: [{ role: 'user', text: 'What is 17*23?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual(['core']);
});

test('a server said to open the thinking in its template has a reply that only closes it read as reasoning and then text', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"The user asks 17*23.</th"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"ink>391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    local({ address: `${upstream.url}v1`, tagged: 'open' }),
  ]);

  expect(
    await Array.fromAsync(
      models(
        'local/qwen3',
        { messages: [{ role: 'user', text: '17*23?' }] },
        AbortSignal.timeout(5000),
      ),
    ),
  ).toEqual([
    { type: 'reasoning', text: 'The user asks 17*23.' },
    { type: 'text', text: '391' },
    { type: 'finish', reason: 'stop', rawReason: 'stop' },
  ]);
});

test('reasoning comes back in a field or between tags, and the types take no server said to do both', () => {
  const both: { address: string; thought: 'reasoning_content'; tagged: true } =
    {
      address: 'http://localhost:1234/v1',
      thought: 'reasoning_content',
      tagged: true,
    };

  // @ts-expect-error a field and tags together are not an option
  expect(local(both).serves('local/qwen3')).toBe(true);
});
