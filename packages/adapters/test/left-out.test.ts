import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { openai } from '../src/openai.ts';

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
