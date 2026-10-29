import { expect, spyOn, test } from 'bun:test';
import type { ModelAdapter, ModelCall } from '@mottyjs/core/host';
import { anthropic } from '../src/anthropic.ts';
import { deepseek } from '../src/deepseek.ts';
import { openai } from '../src/openai.ts';
import { openrouter } from '../src/openrouter.ts';

// One call to an upstream that records what it was sent and answers with
// the given stream.
async function sent(
  made: (address: string) => ModelAdapter,
  model: string,
  prompt: Parameters<ModelCall>[1],
  reply = '',
) {
  const seen: { headers: Headers; body: unknown }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({ headers: request.headers, body: await request.json() });
      return new Response(reply, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const events = await Array.fromAsync(
    made(upstream.url.origin).call?.(
      model,
      prompt,
      AbortSignal.timeout(5000),
    ) ?? [],
  );
  const [{ headers, body } = { headers: new Headers(), body: undefined }] =
    seen;
  return { headers, body, events };
}

test.each([
  ['openai', openai, 'authorization', 'Bearer sk-host'],
  ['anthropic', anthropic, 'x-api-key', 'sk-host'],
])(
  '%s sends a connection header beside its own, and keeps its credential',
  async (name, adapter, credential, value) => {
    const { headers } = await sent(
      (address) =>
        adapter({
          key: 'sk-host',
          address,
          headers: {
            'X-Title': 'Coder',
            Authorization: 'Bearer sk-other',
            'X-Api-Key': 'sk-other',
            'Content-Type': 'text/plain',
            Accept: 'text/html',
          },
        }),
      `${name}/small`,
      { messages: [{ role: 'user', text: 'hi' }] },
    );

    expect(headers.get('x-title')).toBe('Coder');
    expect(headers.get(credential)).toBe(value);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('text/event-stream');
  },
);

test('a connection header under a name the adapter does not use is sent', async () => {
  const { headers } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        headers: { authorization: 'Bearer gateway' },
      }),
    'anthropic/claude-opus-5',
    { messages: [{ role: 'user', text: 'hi' }] },
  );

  expect(headers.get('authorization')).toBe('Bearer gateway');
  expect(headers.get('x-api-key')).toBe('sk-ant-host');
});

test('anthropic adds a beta header and keeps the version the codec speaks', async () => {
  const { headers } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        headers: {
          'anthropic-beta': 'context-1m-2025-08-07',
          'Anthropic-Version': '2099-01-01',
        },
      }),
    'anthropic/claude-opus-5',
    { messages: [{ role: 'user', text: 'hi' }] },
  );

  expect(headers.get('anthropic-beta')).toBe('context-1m-2025-08-07');
  expect(headers.get('anthropic-version')).toBe('2023-06-01');
});

test('a header no request can carry fails when the adapter is made', () => {
  expect(() =>
    openai({ key: 'sk-host', headers: { 'x title': 'Coder' } }),
  ).toThrow(
    'The openai adapter was given a header no request can carry: x title',
  );
});

test('a body default is sent when the request is silent, and yields whole to the request', async () => {
  const made = (address: string) =>
    openrouter({
      key: 'sk-host',
      address,
      body: {
        provider: { sort: 'price' },
        reasoning: { effort: 'low', exclude: true },
        temperature: 0.2,
      },
    });

  const silent = await sent(made, 'openrouter/small', {
    messages: [{ role: 'user', text: 'hi' }],
  });
  const stated = await sent(made, 'openrouter/small', {
    messages: [{ role: 'user', text: 'hi' }],
    options: {
      temperature: 1,
      reasoning: { effort: 'high' },
      provider: { 'openai.chat': { provider: { order: ['acme'] } } },
    },
  });

  expect(silent.body).toEqual({
    provider: { sort: 'price' },
    reasoning: { effort: 'low', exclude: true },
    temperature: 0.2,
    model: 'small',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(stated.body).toEqual({
    provider: { order: ['acme'] },
    reasoning: { effort: 'high' },
    temperature: 1,
    model: 'small',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('a body default never replaces the model, the messages or the stream', async () => {
  const chat = await sent(
    (address) =>
      openai({
        key: 'sk-host',
        address,
        api: 'chat-completions',
        body: {
          model: 'other',
          messages: [],
          stream: false,
          stream_options: { include_usage: false },
          service_tier: 'flex',
          store: true,
        },
      }),
    'openai/small',
    { messages: [{ role: 'user', text: 'hi' }] },
  );
  const responses = await sent(
    (address) =>
      openai({
        key: 'sk-host',
        address,
        body: { model: 'other', input: [], stream: false, store: true },
      }),
    'openai/small',
    { messages: [{ role: 'user', text: 'hi' }] },
  );

  expect(chat.body).toEqual({
    service_tier: 'flex',
    store: true,
    model: 'small',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });
  // No response state is held for a caller, so none is kept upstream.
  expect(responses.body).toMatchObject({
    model: 'small',
    input: [{ role: 'user' }],
    stream: true,
    store: false,
  });
});

test('openai sends the connection reasoning to a silent request, and none of it to one that asks', async () => {
  const made = (address: string) =>
    openai({
      key: 'sk-host',
      address,
      body: {
        service_tier: 'flex',
        reasoning: { effort: 'low', summary: 'detailed' },
      },
    });

  const silent = await sent(made, 'openai/small', {
    messages: [{ role: 'user', text: 'hi' }],
  });
  const asked = await sent(made, 'openai/small', {
    messages: [{ role: 'user', text: 'hi' }],
    options: { reasoning: { effort: 'high' } },
  });
  const muted = await sent(made, 'openai/small', {
    messages: [{ role: 'user', text: 'hi' }],
    options: { reasoning: { effort: 'high', exclude: true } },
  });
  const own = await sent(made, 'openai/small', {
    messages: [{ role: 'user', text: 'hi' }],
    options: {
      reasoning: { effort: 'high' },
      provider: {
        'openai.responses': {
          service_tier: 'priority',
          reasoning: { summary: 'concise' },
        },
      },
    },
  });

  expect(silent.body).toMatchObject({
    service_tier: 'flex',
    reasoning: { effort: 'low', summary: 'detailed' },
  });
  expect(asked.body).toMatchObject({ service_tier: 'flex' });
  expect(asked.body).toHaveProperty('reasoning', {
    effort: 'high',
    summary: 'auto',
  });
  expect(muted.body).toHaveProperty('reasoning', { effort: 'high' });
  expect(own.body).toMatchObject({ service_tier: 'priority' });
  expect(own.body).toHaveProperty('reasoning', {
    effort: 'high',
    summary: 'concise',
  });
});

test('deepseek sends a request that asks none of the connection thinking, and a limit under one name', async () => {
  const made = (address: string) =>
    deepseek({
      key: 'sk-host',
      address,
      body: { thinking: { type: 'disabled' }, max_completion_tokens: 8192 },
    });

  const silent = await sent(made, 'deepseek/small', {
    messages: [{ role: 'user', text: 'hi' }],
  });
  const budget = await sent(made, 'deepseek/small', {
    messages: [{ role: 'user', text: 'hi' }],
    options: { reasoning: { budgetTokens: 2000 } },
  });
  const effort = await sent(made, 'deepseek/small', {
    messages: [{ role: 'user', text: 'hi' }],
    options: { maxTokens: 64, reasoning: { effort: 'high' } },
  });

  expect(silent.body).toMatchObject({
    thinking: { type: 'disabled' },
    max_completion_tokens: 8192,
  });
  expect(budget.body).toMatchObject({ thinking: { type: 'enabled' } });
  expect(effort.body).toEqual({
    reasoning_effort: 'high',
    max_tokens: 64,
    model: 'small',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });
});

test('openrouter sends a request that asks none of a connection effort under another name', async () => {
  const { body } = await sent(
    (address) =>
      openrouter({
        key: 'sk-host',
        address,
        body: { reasoning_effort: 'low', max_tokens: 8192 },
      }),
    'openrouter/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { maxTokens: 64, reasoning: { effort: 'high' } },
    },
  );

  expect(body).toEqual({
    reasoning: { effort: 'high' },
    max_completion_tokens: 64,
    model: 'small',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stream_options: { include_usage: true },
  });
});

test.each([
  [
    { budgetTokens: 2000 },
    {
      thinking: { type: 'enabled', budget_tokens: 2000, display: 'summarized' },
    },
  ],
  [{ effort: 'none' } as const, { output_config: { effort: 'low' } }],
])(
  'anthropic sends reasoning %j as translated, and none of the connection thinking',
  async (reasoning, translated) => {
    for (const thinking of [
      { type: 'enabled', budget_tokens: 4000 },
      { type: 'adaptive', display: 'omitted' },
      { type: 'adaptive', display: 'summarized' },
    ]) {
      const made = (address: string) =>
        anthropic({
          key: 'sk-ant-host',
          address,
          body: { thinking, output_config: { effort: 'low' } },
        });

      const silent = await sent(made, 'anthropic/claude-opus-5', {
        messages: [{ role: 'user', text: 'hi' }],
      });
      const asked = await sent(made, 'anthropic/claude-opus-5', {
        messages: [{ role: 'user', text: 'hi' }],
        options: { reasoning },
      });

      expect(silent.body).toEqual({
        thinking,
        output_config: { effort: 'low' },
        max_tokens: 64000,
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
      expect(asked.body).toEqual({
        ...translated,
        max_tokens: 64000,
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      });
    }
  },
);

test('anthropic sends no thinking for a mute alone, over a connection that shows it', async () => {
  const { body } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        body: { thinking: { type: 'adaptive', display: 'summarized' } },
      }),
    'anthropic/claude-opus-5',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { reasoning: { exclude: true } },
    },
  );

  expect(body).toEqual({
    max_tokens: 64000,
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });
});

test('anthropic sends the form a caller said in its own words over the connection thinking', async () => {
  const { body } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        body: {
          thinking: { type: 'enabled', budget_tokens: 4000 },
          output_config: { effort: 'low', task_budget: { total: 9000 } },
        },
      }),
    'anthropic/claude-opus-5',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: {
        reasoning: { effort: 'high' },
        hints: { anthropic: { thinking: { type: 'adaptive' } } },
      },
    },
  );

  expect(body).toMatchObject({ thinking: { type: 'adaptive' } });
  // Top-level only: the request's field replaces the connection's whole.
  expect(body).toHaveProperty('output_config', { effort: 'high' });
});

test('anthropic sends thinking in the author`s own words over the connection`s and beside an effort', async () => {
  const { body, events } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        body: { thinking: { type: 'adaptive', display: 'summarized' } },
      }),
    'anthropic/claude-sonnet-5-5',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: {
        reasoning: { effort: 'high' },
        provider: { anthropic: { thinking: { type: 'between_tools' } } },
      },
    },
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5-5","usage":{"input_tokens":9,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  );

  expect(body).toEqual({
    thinking: { type: 'between_tools' },
    output_config: { effort: 'high' },
    max_tokens: 64000,
    model: 'claude-sonnet-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });
  expect(events.map(({ type }) => type)).toEqual(['finish']);
  expect(events[0]).not.toHaveProperty('warnings');
});

test('anthropic sends a connection limit where the request states none', async () => {
  const made = (address: string) =>
    anthropic({ key: 'sk-ant-host', address, body: { max_tokens: 8192 } });

  const silent = await sent(made, 'anthropic/claude-opus-5', {
    messages: [{ role: 'user', text: 'hi' }],
  });
  const stated = await sent(made, 'anthropic/claude-opus-5', {
    messages: [{ role: 'user', text: 'hi' }],
    options: { maxTokens: 64 },
  });

  expect(silent.body).toMatchObject({ max_tokens: 8192 });
  expect(stated.body).toMatchObject({ max_tokens: 64 });
});

test('a connection default is no warning', async () => {
  const messages = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        headers: { 'anthropic-beta': 'context-1m-2025-08-07' },
        body: { thinking: { type: 'adaptive' }, top_k: 40, acme: true },
      }),
    'anthropic/claude-opus-5',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { reasoning: { effort: 'high' } },
    },
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":9,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
  const responses = await sent(
    (address) =>
      openai({ key: 'sk-host', address, body: { top_k: 40, seed: 7 } }),
    'openai/small',
    { messages: [{ role: 'user', text: 'hi' }] },
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
  );

  expect(messages.body).toMatchObject({ top_k: 40, acme: true });
  expect(messages.events.map(({ type }) => type)).toEqual(['finish']);
  expect(messages.events[0]).not.toHaveProperty('warnings');
  expect(responses.body).toMatchObject({ top_k: 40, seed: 7 });
  expect(responses.events.map(({ type }) => type)).toEqual(['finish']);
  expect(responses.events[0]).not.toHaveProperty('warnings');
});

test('openai at its own address leaves out what the model does not take, and reports it', async () => {
  const fetched = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );

  const events = await Array.fromAsync(
    openai({ key: 'sk-host' }).call?.(
      'openai/gpt-5',
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: { temperature: 0.2 },
      },
      AbortSignal.timeout(5000),
    ) ?? [],
  );
  const [[address, request] = []] = fetched.mock.calls;
  fetched.mockRestore();
  const body: unknown = JSON.parse(String(request?.body));

  expect(address).toBe('https://api.openai.com/v1/responses');
  expect(body).not.toHaveProperty('temperature');
  expect(events).toMatchObject([
    {
      type: 'finish',
      warnings: [
        {
          setting: 'temperature.model',
          detail:
            'The Responses API has no field for a temperature the model does not take',
        },
      ],
    },
  ]);
});

test('openai at another address has no rule, and sends everything', async () => {
  const { body, events } = await sent(
    (address) => openai({ key: 'sk-host', address }),
    'openai/gpt-5',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 0.2, reasoning: { effort: 'high' } },
    },
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
  );

  expect(body).toMatchObject({
    temperature: 0.2,
    reasoning: { effort: 'high' },
  });
  expect(events[0]).not.toHaveProperty('warnings');
});

test('openai at another address is held to the rule its connection states', async () => {
  const { body, events } = await sent(
    (address) =>
      openai({
        key: 'sk-host',
        address,
        api: 'chat-completions',
        takes: (model) =>
          model === 'kimi-k2'
            ? {
                temperature: [0, 1],
                topP: [0, 1],
                topK: false,
                presencePenalty: true,
                frequencyPenalty: true,
                together: true,
                effort: false,
              }
            : undefined,
      }),
    'openai/kimi-k2',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 1.5, reasoning: { effort: 'high' } },
    },
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

  expect(body).toMatchObject({ temperature: 1 });
  expect(body).not.toHaveProperty('reasoning_effort');
  expect(events).toMatchObject([
    {
      type: 'finish',
      warnings: [
        { setting: 'reasoning.model' },
        { setting: 'temperature.range' },
      ],
    },
  ]);
});

test('anthropic leaves out the sampling a current model refuses, and reports it', async () => {
  const { body, events } = await sent(
    (address) => anthropic({ key: 'sk-ant-host', address }),
    'anthropic/claude-opus-4-7',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 0.2, topP: 0.99, topK: 40 },
    },
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-7","usage":{"input_tokens":9,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  );

  expect(body).toEqual({
    max_tokens: 64000,
    model: 'claude-opus-4-7',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
  });
  expect(events).toMatchObject([
    {
      type: 'finish',
      warnings: [{ setting: 'temperature.model' }, { setting: 'topK.model' }],
    },
  ]);
});

test('a rule the connection states stands in place of the adapter`s own', async () => {
  const { body, events } = await sent(
    (address) =>
      anthropic({ key: 'sk-ant-host', address, takes: () => undefined }),
    'anthropic/claude-opus-4-7',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 0.2, topK: 40 },
    },
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-7","usage":{"input_tokens":9,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  );

  expect(body).toMatchObject({ temperature: 0.2, top_k: 40 });
  expect(events[0]).not.toHaveProperty('warnings');
});

test('openrouter holds a Claude model to Anthropic`s rule, by a name written with a dot', async () => {
  const { body, events } = await sent(
    (address) => openrouter({ key: 'sk-or-host', address }),
    'openrouter/anthropic/claude-opus-4.7',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 0.2, presencePenalty: 0.5 },
    },
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

  expect(body).not.toHaveProperty('temperature');
  expect(body).not.toHaveProperty('presence_penalty');
  expect(events).toMatchObject([
    {
      type: 'finish',
      warnings: [
        { setting: 'temperature.model' },
        { setting: 'presencePenalty.model' },
      ],
    },
  ]);
});

test('openrouter sends an older Claude model a temperature up to its own limit of two, and an effort', async () => {
  const { body, events } = await sent(
    (address) => openrouter({ key: 'sk-or-host', address }),
    'openrouter/anthropic/claude-haiku-4.5',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 2.5, reasoning: { effort: 'none' } },
    },
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

  expect(body).toMatchObject({ temperature: 2, reasoning: { effort: 'none' } });
  expect(events).toMatchObject([
    { type: 'finish', warnings: [{ setting: 'temperature.range' }] },
  ]);
});

test('openrouter holds an older Claude model that reasons to what it takes while thinking', async () => {
  const { body, events } = await sent(
    (address) => openrouter({ key: 'sk-or-host', address }),
    'openrouter/anthropic/claude-haiku-4.5',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 0.5, reasoning: { budgetTokens: 2000 } },
    },
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

  expect(body).toMatchObject({ reasoning: { max_tokens: 2000 } });
  expect(body).not.toHaveProperty('temperature');
  expect(events).toMatchObject([
    { type: 'finish', warnings: [{ setting: 'temperature.model' }] },
  ]);
});

test('openrouter holds an OpenAI model to OpenAI`s rule', async () => {
  const { body, events } = await sent(
    (address) => openrouter({ key: 'sk-or-host', address }),
    'openrouter/openai/gpt-4.1-mini',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { temperature: 0.2, reasoning: { effort: 'high' } },
    },
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

  expect(body).toMatchObject({ temperature: 0.2 });
  expect(body).not.toHaveProperty('reasoning');
  expect(events).toMatchObject([
    { type: 'finish', warnings: [{ setting: 'reasoning.model' }] },
  ]);
});

test.each([
  'openai/gpt-oss-120b',
  'openai/gpt-audio-mini',
  'openai/gpt-5-image',
])(
  'openrouter sends %s, which is no model of OpenAI`s API, everything',
  async (model) => {
    const { body, events } = await sent(
      (address) => openrouter({ key: 'sk-or-host', address }),
      `openrouter/${model}`,
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: { temperature: 0.2, topP: 0.4, topK: 40 },
      },
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );

    expect(body).toEqual({
      temperature: 0.2,
      top_p: 0.4,
      top_k: 40,
      model,
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(events[0]).not.toHaveProperty('warnings');
  },
);

test('openrouter sends a model of any other provider everything', async () => {
  const { body, events } = await sent(
    (address) => openrouter({ key: 'sk-or-host', address }),
    'openrouter/moonshotai/kimi-k2',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: {
        temperature: 1.7,
        topP: 0.4,
        presencePenalty: 0.5,
        reasoning: { effort: 'high' },
      },
    },
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

  expect(body).toMatchObject({
    temperature: 1.7,
    top_p: 0.4,
    presence_penalty: 0.5,
    reasoning: { effort: 'high' },
  });
  expect(events[0]).not.toHaveProperty('warnings');
});

test('openrouter writes a cache marker as cache_control, with its lifetime, and reports nothing', async () => {
  const { body, events } = await sent(
    (address) => openrouter({ key: 'sk-or-host', address }),
    'openrouter/moonshotai/kimi-k2',
    {
      messages: [
        { role: 'system', text: 'A long manual', cache: { ttl: '1h' } },
        { role: 'user', text: 'hi' },
      ],
    },
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

  expect(body).toMatchObject({
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'A long manual',
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
        ],
      },
      { role: 'user', content: 'hi' },
    ],
  });
  expect(events[0]).not.toHaveProperty('warnings');
});
