import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { ollama } from '../src/ollama.ts';

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
