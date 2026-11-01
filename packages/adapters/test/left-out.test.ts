import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { dashscope } from '../src/dashscope.ts';
import { deepseek } from '../src/deepseek.ts';
import { fireworks } from '../src/fireworks.ts';
import { groq } from '../src/groq.ts';
import { local } from '../src/local.ts';
import { minimax } from '../src/minimax.ts';
import { mistral } from '../src/mistral.ts';
import { moonshot } from '../src/moonshot.ts';
import { ollama } from '../src/ollama.ts';
import { openai } from '../src/openai.ts';
import { openrouter } from '../src/openrouter.ts';
import { together } from '../src/together.ts';
import { zai } from '../src/zai.ts';

test('a seed and a reasoning budget the Responses API has no field for reach the report from a Chat Completions caller', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `event: response.created
data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-5","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello there"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('openai/gpt-5').complete(prompt),
    ),
    () => ({
      models: [openai({ key: 'sk-host', address: `${upstream.url}v1` })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        seed: 7,
        reasoning: { max_tokens: 2048 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );
  const answer = await reply.json();
  await served.close();

  expect(reply.status).toBe(200);
  expect(answer).toMatchObject({
    choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }],
  });
  expect(seen).toMatchObject([{ model: 'gpt-5', stream: true }]);
  expect(seen[0]).not.toHaveProperty('seed');
  expect(JSON.stringify(seen[0])).not.toContain('2048');
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.calls[0]?.warnings).toEqual([
    { setting: 'seed', detail: 'The Responses API has no field for a seed' },
    {
      setting: 'reasoning.budgetTokens',
      detail: 'The Responses API has no field for a reasoning budget in tokens',
    },
  ]);
  expect(reports[0]).not.toHaveProperty('warnings');
});

const key = 'sk-host';

test.each([
  [
    'openai',
    (address: string) => openai({ key, address }),
    'openai/gpt-5',
    true,
    false,
  ],
  [
    'openai chat',
    (address: string) => openai({ key, address, api: 'chat-completions' }),
    'openai/gpt-5',
    true,
    false,
  ],
  [
    'openrouter',
    (address: string) => openrouter({ key, address }),
    'openrouter/anthropic/claude-x',
    true,
    true,
  ],
  [
    'fireworks',
    (address: string) => fireworks({ key, address }),
    'fireworks/accounts/fireworks/models/glm-5',
    true,
    false,
  ],
  [
    'fireworks bound',
    (address: string) => fireworks({ key, address }),
    'fireworks/accounts/fireworks/models/gpt-oss-120b',
    true,
    false,
  ],
  [
    'mistral',
    (address: string) => mistral({ key, address }),
    'mistral/mistral-large-latest',
    true,
    false,
  ],
  [
    'moonshot newest',
    (address: string) => moonshot({ key, address }),
    'moonshot/kimi-k3',
    true,
    false,
  ],
  [
    'moonshot K2',
    (address: string) => moonshot({ key, address }),
    'moonshot/kimi-k2-thinking',
    true,
    false,
  ],
  [
    'moonshot v1',
    (address: string) => moonshot({ key, address }),
    'moonshot/moonshot-v1-8k',
    true,
    false,
  ],
  [
    'local said to',
    (address: string) => local({ address, cacheKey: true }),
    'local/qwen3',
    true,
    false,
  ],
  [
    'groq',
    (address: string) => groq({ key, address }),
    'groq/qwen/qwen3-32b',
    false,
    false,
  ],
  [
    'deepseek',
    (address: string) => deepseek({ key, address }),
    'deepseek/deepseek-v4',
    false,
    false,
  ],
  [
    'minimax',
    (address: string) => minimax({ key, address }),
    'minimax/MiniMax-M3',
    false,
    false,
  ],
  [
    'dashscope',
    (address: string) => dashscope({ key, address }),
    'dashscope/qwen3.6-plus',
    false,
    true,
  ],
  [
    'zai',
    (address: string) => zai({ key, address }),
    'zai/glm-5',
    false,
    false,
  ],
  [
    'ollama',
    (address: string) => ollama({ address }),
    'ollama/qwen3',
    false,
    false,
  ],
  [
    'local',
    (address: string) => local({ address }),
    'local/qwen3',
    false,
    false,
  ],
  [
    'together',
    (address: string) => together({ key, address }),
    'together/meta-llama/llama-5',
    false,
    false,
  ],
  [
    'together contented',
    (address: string) => together({ key, address }),
    'together/zai-org/GLM-5',
    false,
    false,
  ],
  [
    'together leveled',
    (address: string) => together({ key, address }),
    'together/openai/gpt-oss-120b',
    false,
    false,
  ],
  [
    'together tagged',
    (address: string) => together({ key, address }),
    'together/deepseek-ai/DeepSeek-R1',
    false,
    false,
  ],
] as const)(
  'a caller`s cache key to %s goes where its reference names the field, and is told left out elsewhere, with the marker it implied kept',
  async (name, connected, wanted, sends, marks) => {
    const seen: unknown[] = [];
    using upstream = Bun.serve({
      port: 0,
      fetch: async (request) => {
        seen.push(await request.json());
        return new Response(
          new URL(request.url).pathname.endsWith('/responses')
            ? `event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}

`
            : `data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}

data: {"id":"1","object":"chat.completion.chunk","model":"m","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]

`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model(wanted).complete(prompt),
      ),
      () => ({
        models: [connected(`${upstream.url}v1`)],
        report: (report) => reports.push(report),
      }),
    );

    for (const [path, said] of [
      ['chat/completions', { messages: [{ role: 'user', content: 'ping' }] }],
      ['responses', { input: 'ping' }],
    ] as const) {
      const reply = await served.fetch(
        new Request(`http://localhost/v1/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'relay',
            prompt_cache_key: 'session-1',
            ...said,
          }),
        }),
      );
      await reply.text();
      expect(reply.status).toBe(200);
    }
    await served.close();

    expect(seen).toHaveLength(2);
    for (const body of seen) {
      expect(JSON.stringify(body).includes('session-1')).toBe(sends);
      expect(JSON.stringify(body).includes('cache_control')).toBe(marks);
    }
    for (const report of reports) {
      if (sends) expect(report.calls[0]).not.toHaveProperty('warnings');
      else {
        expect(report.calls[0]?.warnings).toEqual([
          {
            setting: 'openai.prompt_cache_key',
            detail: `${name.split(' ')[0]} has no field for prompt_cache_key`,
          },
        ]);
      }
    }
    expect(reports).toHaveLength(2);
  },
);
