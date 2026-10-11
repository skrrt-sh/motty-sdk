import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/fireworks.ts';
import { fireworks } from '../src/fireworks.ts';

test('built from Fireworks`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = fireworks({ key: 'sk-host' });

  expect(adapter.serves('fireworks/accounts/fireworks/models/kimi-k2p5')).toBe(
    true,
  );
  expect(adapter.serves('openrouter/accounts/fireworks/models/kimi-k2p5')).toBe(
    false,
  );
  expect(fireworks({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => fireworks({ key: undefined })).toThrow(
    'The fireworks adapter was given no key',
  );
  expect(() => fireworks({ key: '' })).toThrow();
  expect(() => fireworks({ key: ' \t' })).toThrow(
    'The fireworks adapter was given no key',
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
        `data: {"id":"chatcmpl-0220","object":"chat.completion.chunk","created":1773842038,"model":"accounts/fireworks/models/kimi-k2p5","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"I need the weather tool."},"finish_reason":null}]}

data: {"id":"chatcmpl-0220","object":"chat.completion.chunk","created":1773842038,"model":"accounts/fireworks/models/kimi-k2p5","choices":[{"index":0,"delta":{"content":"Let me check."},"finish_reason":null}]}

data: {"id":"chatcmpl-0220","object":"chat.completion.chunk","created":1773842038,"model":"accounts/fireworks/models/kimi-k2p5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_7k2","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":\\"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"chatcmpl-0220","object":"chat.completion.chunk","created":1773842038,"model":"accounts/fireworks/models/kimi-k2p5","choices":[],"usage":{"prompt_tokens":58,"total_tokens":98,"completion_tokens":40,"prompt_tokens_details":{"cached_tokens":32},"completion_tokens_details":{"reasoning_tokens":12}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    fireworks({ key: 'sk-host', address: `${upstream.url}inference/v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      { messages: [{ role: 'user', text: 'Weather in Paris?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    { path: '/inference/v1/chat/completions', key: 'Bearer sk-host' },
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
      usage: { input: 58, output: 40, cached: 32, reasoning: 12 },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a model that sends its reasoning inside the text, between think tags cut across chunks, is read the same, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"<thi"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"nk>17*23 is 391.</th"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"ink>391"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      { messages: [{ role: 'user', text: 'Weather in Paris?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([{ path: '/chat/completions', key: 'Bearer sk-host' }]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: '17*23 is 391.' },
    { type: 'text', text: '391' },
    { type: 'finish', reason: 'stop' },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an order not to reason is the effort itself, and the output limit and top-k have fields', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: {
          reasoning: { effort: 'none' },
          maxTokens: 64,
          topK: 40,
          user: 'user-1',
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'none',
      max_completion_tokens: 64,
      user: 'user-1',
      top_k: 40,
      model: 'accounts/fireworks/models/kimi-k2p5',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an effort goes under OpenAI`s name at the level given, the highest included, and the lowest as the nearest it has', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'minimal' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'low',
      model: 'accounts/fireworks/models/kimi-k2p5',
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

test('the highest effort is a level of its own', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/glm-5p2',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'max' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'max',
      model: 'accounts/fireworks/models/glm-5p2',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a model that always reasons at three levels is not told to stop, which is reported', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/minimax-m2',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'accounts/fireworks/models/minimax-m2',
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

test('a model that always reasons at three levels is sent the nearest of them', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/gpt-oss-120b',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'xhigh' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'high',
      model: 'accounts/fireworks/models/gpt-oss-120b',
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

test('a budget means another thing to each model, so it is left out and reported', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'accounts/fireworks/models/kimi-k2p5',
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        output: {
          name: 'Result',
          schema: {
            type: 'object',
            properties: { winner: { type: 'string' } },
            required: ['winner'],
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
          name: 'Result',
          schema: {
            type: 'object',
            properties: { winner: { type: 'string' } },
            required: ['winner'],
          },
          strict: false,
        },
      },
      model: 'accounts/fireworks/models/kimi-k2p5',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a grammar is asked for in Fireworks` own words, as the author wrote it', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: {
          provider: {
            'openai.chat': {
              response_format: {
                type: 'grammar',
                grammar: 'root ::= [0-9]+',
              },
            },
          },
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      response_format: { type: 'grammar', grammar: 'root ::= [0-9]+' },
      model: 'accounts/fireworks/models/kimi-k2p5',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('reasoning goes back in the field it came in, also from a model that sent it inside the text', async () => {
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
    fireworks({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
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
      model: 'accounts/fireworks/models/kimi-k2p5',
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
    status: 404,
    error: {
      message: 'Model not found, inaccessible, and/or not deployed',
      param: 'model',
      code: 'NOT_FOUND',
      type: 'error',
    },
    kind: 'unknown_model',
  },
  {
    status: 402,
    error: {
      message: 'Account is not on a paid plan or has exceeded usage limits.',
      type: 'error',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 408,
    error: { message: 'The request took too long to complete.', type: 'error' },
    kind: 'timed_out',
  },
  {
    status: 413,
    error: {
      message: 'Input data exceeds the allowed size limit.',
      type: 'error',
    },
    kind: 'invalid_request',
  },
  {
    status: 429,
    error: { message: 'Rate limited.', type: 'error' },
    kind: 'rate_limited',
  },
  {
    status: 520,
    error: { message: 'An unexpected error occurred.', type: 'error' },
    kind: 'upstream_failed',
  },
])(
  'a failure told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      fireworks({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'fireworks/kimi-k2p5',
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
    status: 412,
    error: { message: 'Account is suspended.', type: 'error' },
  },
  {
    status: 401,
    error: { message: 'Invalid API key.', type: 'error' },
  },
])(
  'a refusal of the host`s key or account told as $status is the host`s to mend, and its words are kept for the host',
  async ({ status, error }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      fireworks({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'fireworks/kimi-k2p5',
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
          provider: { fireworks: { message: error.message } },
        },
      },
    ]);
  },
);

test('a key Fireworks does not know is answered as a model it does not know, and is told as one', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        '{"error":{"message":"Model not found, inaccessible, and/or not deployed","param":"model","code":"NOT_FOUND","type":"error"},"request_id":"chatcmpl-02206b3dd7ae4e51920981ed5544996b"}',
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
  });
  const { models } = adapted([
    fireworks({ key: 'fw-wrong', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'fireworks/accounts/fireworks/models/kimi-k2p5',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  // Live, a wrong key got this body: nothing in it tells a key from a model.
  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'unknown_model',
        message: 'Model not found, inaccessible, and/or not deployed',
        provider: {
          fireworks: { status: 404, code: 'NOT_FOUND', param: 'model' },
        },
        upstream: true,
      },
    },
  ]);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/fireworks.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['fireworks']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
