import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { fireworks } from '../src/fireworks.ts';

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
    status: 412,
    error: { message: 'Account is suspended.', type: 'error' },
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
