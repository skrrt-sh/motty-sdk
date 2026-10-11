import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
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

test('a reasoning budget Chat Completions has no field for reaches the report from an Anthropic Messages caller', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-5","choices":[{"index":0,"delta":{"content":"Hello there"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"gpt-5","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]

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
      models: [
        openai({
          key: 'sk-host',
          address: `${upstream.url}v1`,
          api: 'chat-completions',
        }),
      ],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        max_tokens: 4096,
        thinking: { type: 'enabled', budget_tokens: 2048 },
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );
  const answer = await reply.json();
  await served.close();

  expect(reply.status).toBe(200);
  expect(answer).toMatchObject({
    content: [{ type: 'text', text: 'Hello there' }],
    stop_reason: 'end_turn',
  });
  expect(seen).toMatchObject([{ model: 'gpt-5', stream: true }]);
  expect(JSON.stringify(seen[0])).not.toContain('2048');
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.calls[0]?.warnings).toEqual([
    {
      setting: 'reasoning.budgetTokens',
      detail: 'Chat Completions has no field for a reasoning budget in tokens',
    },
  ]);
  expect(reports[0]).not.toHaveProperty('warnings');
});

test('a seed Anthropic Messages has no field for reaches the report from a streaming Chat Completions caller', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('anthropic/claude-opus-4').complete(prompt),
    ),
    () => ({
      models: [anthropic({ key: 'sk-ant-host', address: upstream.url.origin })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        stream: true,
        seed: 7,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );
  const text = await reply.text();
  await served.close();

  expect(reply.status).toBe(200);
  expect(text).toContain('Hello there');
  expect(text).toEndWith('data: [DONE]\n\n');
  expect(seen).toMatchObject([{ model: 'claude-opus-4', stream: true }]);
  expect(seen[0]).not.toHaveProperty('seed');
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.calls[0]?.warnings).toEqual([
    { setting: 'seed', detail: 'Anthropic Messages has no field for a seed' },
  ]);
  expect(reports[0]).not.toHaveProperty('warnings');
});

test('redacted thinking from Anthropic is left out of a Chat Completions reply and is in the record', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"EmwKAhgB"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('anthropic/claude-opus-4').complete(prompt),
    ),
    () => ({
      models: [anthropic({ key: 'sk-ant-host', address: upstream.url.origin })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );
  const text = await reply.text();
  await served.close();

  expect(reply.status).toBe(200);
  expect(JSON.parse(text)).toMatchObject({
    choices: [{ message: { content: 'Hello there' }, finish_reason: 'stop' }],
  });
  expect(text).not.toContain('EmwKAhgB');
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.warnings).toEqual([
    {
      setting: 'reasoning',
      detail:
        'Chat Completions has no form for what a model goes on from its reasoning with',
    },
  ]);
});

test('a tool Anthropic ran itself fails a Chat Completions reply as unsupported, stops the upstream call and is in the record', async () => {
  const left = Promise.withResolvers<Event>();
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      request.signal.addEventListener('abort', left.resolve);
      return new Response(
        async function* () {
          yield `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_01","name":"web_search","input":{}}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

`;
          // Never ends by itself: only the stop can end this call.
          await new Promise(() => {});
        },
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('anthropic/claude-opus-4').complete(prompt),
    ),
    () => ({
      models: [anthropic({ key: 'sk-ant-host', address: upstream.url.origin })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );
  const answer = await reply.json();
  await served.close();

  expect(reply.status).toBe(400);
  expect(answer).toMatchObject({
    error: {
      code: 'unsupported',
      message:
        'Chat Completions has no form for a call to a tool the upstream ran',
    },
  });
  expect((await left.promise).type).toBe('abort');
  expect(reports).toMatchObject([
    {
      outcome: 'aborted',
      error: {
        code: 'unsupported',
        status: 400,
        message:
          'Chat Completions has no form for a call to a tool the upstream ran',
      },
      warnings: [
        {
          setting: 'tool_call',
          detail:
            'Chat Completions has no form for a call to a tool the upstream ran',
        },
      ],
      calls: [{ model: 'anthropic/claude-opus-4', code: 'unsupported' }],
    },
  ]);
});

test('an order not to reason from a Chat Completions caller goes to Anthropic as the lowest effort, and the record says so', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5-5","usage":{"input_tokens":9,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('anthropic/claude-sonnet-5-5').complete(prompt),
    ),
    () => ({
      models: [anthropic({ key: 'sk-ant-host', address: upstream.url.origin })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        reasoning_effort: 'none',
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
  expect(seen).toEqual([
    {
      max_tokens: 64000,
      output_config: { effort: 'low' },
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    },
  ]);
  expect(reports[0]?.calls[0]?.warnings).toEqual([
    {
      setting: 'reasoning.none',
      detail:
        'Anthropic Messages has no field for an order not to reason, sent as low effort',
    },
  ]);
});

test('an effort from a Chat Completions caller gives way to the one a motty states in the Responses API`s own words, and the record says so', async () => {
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
      model('openai/gpt-5').complete({
        ...prompt,
        options: {
          ...prompt.options,
          provider: { 'openai.responses': { reasoning: { effort: 'low' } } },
        },
      }),
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
        reasoning_effort: 'high',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );
  await reply.json();
  await served.close();

  expect(reply.status).toBe(200);
  expect(seen).toMatchObject([
    { reasoning: { effort: 'low', summary: 'auto' } },
  ]);
  expect(reports[0]?.calls[0]?.warnings).toEqual([
    {
      setting: 'reasoning.own',
      detail:
        "The Responses API has no field for a reasoning option the request also states in the API's own words",
    },
  ]);
});
