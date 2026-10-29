import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { local } from '../src/local.ts';

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

test('a header a call states goes to the server where the host names it among those the connection forwards', async () => {
  const seen: (string | null)[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(request.headers.get('x-session'));
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    local({ address: upstream.url.origin, forwardHeaders: ['x-session'] }),
  ]);

  const events = await Array.fromAsync(
    models(
      'local/qwen3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { headers: { 'x-session': 's-1' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual(['s-1']);
  expect(events.at(-1)).not.toHaveProperty('warnings');
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
