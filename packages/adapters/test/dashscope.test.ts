import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/dashscope.ts';
import { dashscope } from '../src/dashscope.ts';

test('built from Qwen`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = dashscope({ key: 'sk-host' });

  expect(adapter.serves('dashscope/qwen3.7-plus')).toBe(true);
  expect(adapter.serves('openrouter/qwen/qwen3.7-plus')).toBe(false);
  expect(dashscope({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => dashscope({ key: undefined })).toThrow(
    'The dashscope adapter was given no key',
  );
  expect(() => dashscope({ key: '' })).toThrow();
  expect(() => dashscope({ key: ' \t' })).toThrow(
    'The dashscope adapter was given no key',
  );
});

test('a call goes to Chat Completions under the address with the key, and its reasoning, a tool call and usage are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"chatcmpl-3f2","object":"chat.completion.chunk","model":"qwen3.7-plus","choices":[{"index":0,"delta":{"role":"assistant","content":null,"reasoning_content":"I need the weather tool."},"finish_reason":null}],"usage":null}

data: {"id":"chatcmpl-3f2","object":"chat.completion.chunk","model":"qwen3.7-plus","choices":[{"index":0,"delta":{"content":null,"reasoning_content":null,"tool_calls":[{"index":0,"id":"call_3b9","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Hangzhou\\"}"}}]},"finish_reason":null}],"usage":null}

data: {"id":"chatcmpl-3f2","object":"chat.completion.chunk","model":"qwen3.7-plus","choices":[{"index":0,"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":null}

data: {"id":"chatcmpl-3f2","object":"chat.completion.chunk","model":"qwen3.7-plus","choices":[],"usage":{"prompt_tokens":22,"completion_tokens":40,"total_tokens":62,"completion_tokens_details":{"reasoning_tokens":18}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    dashscope({ key: 'sk-host', address: `${upstream.url}compatible-mode/v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    { path: '/compatible-mode/v1/chat/completions', key: 'Bearer sk-host' },
  ]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'I need the weather tool.' },
    {
      type: 'tool_call',
      id: 'call_3b9',
      name: 'get_weather',
      arguments: '{"city": "Hangzhou"}',
    },
    {
      type: 'finish',
      reason: 'tool_calls',
      usage: { input: 22, output: 40, reasoning: 18 },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an order not to reason sets the thinking flag to false', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      enable_thinking: false,
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('top-k sampling is sent to a Qwen model, and nothing is reported', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
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
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('top-k sampling is left out for a model of another maker served here, and reported', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/kimi-k3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { topK: 40 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [{ setting: 'topK.model' }],
  });
});

test('an effort is not sent: it sets the thinking flag, and its level is reported', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      enable_thinking: true,
      model: 'qwen3.7-plus',
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

test('a budget sets the thinking flag and goes beside it', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      enable_thinking: true,
      thinking_budget: 2000,
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an effort said in this API`s own words is sent as said', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.8-max',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { provider: { 'openai.chat': { reasoning_effort: 'xhigh' } } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'xhigh',
      model: 'qwen3.8-max',
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
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
      model: 'qwen3.7-plus',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('a temperature of two and a top-p of zero go as the nearest this API takes, and a penalty as it is', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 2, topP: 0, presencePenalty: 1 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      temperature: 1.99,
      top_p: 0.01,
      presence_penalty: 1,
      model: 'qwen3.7-plus',
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
      {
        setting: 'topP.range',
        detail:
          "Chat Completions has no field for top-p sampling outside the model's range, sent as the nearest inside",
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 2);
});

test('reasoning goes back on the assistant turn as reasoning_content', async () => {
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
    dashscope({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'dashscope/qwen3.7-plus',
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

test.each([
  {
    status: 400,
    error: {
      code: 'Arrearage',
      message:
        'Access denied, please make sure your account is in good standing.',
      type: 'Arrearage',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: 'BudgetLimitExceeded',
      message:
        'The budget configured in Budget Management has been exhausted. You will be unable to make further API calls until the budget limit is increased or reset.',
      type: 'BudgetLimitExceeded',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: 'PrepaidBillOverdue',
      message: 'The prepaid bill is overdue.',
      type: 'PrepaidBillOverdue',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: 'PostpaidBillOverdue',
      message: 'The postpaid bill is overdue.',
      type: 'PostpaidBillOverdue',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 403,
    error: {
      code: 'AllocationQuota.FreeTierOnly',
      message:
        'The free tier of the model has been exhausted. If you want to continue access the model on a paid basis, please disable the "use free tier only" mode in the management console.',
      type: 'AllocationQuota.FreeTierOnly',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: 'insufficient_quota',
      message:
        'You exceeded your current quota, please check your plan and billing details.',
      type: 'insufficient_quota',
    },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: 'limit_requests',
      message: 'You exceeded your current requests list.',
      type: 'limit_requests',
    },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: 'limit_burst_rate',
      message:
        'Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time.',
      type: 'limit_burst_rate',
    },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: 'Throttling.RateQuota',
      message: 'Requests rate limit exceeded, please try again later.',
      type: 'Throttling.RateQuota',
    },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: 'Throttling',
      message: 'Requests throttling triggered.',
      type: 'Throttling',
    },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: 'Throttling.ServiceOverloaded',
      message:
        'InternalError.Algo: An error occurred in model serving, error message is: [Too many requests.]',
      type: 'Throttling.ServiceOverloaded',
    },
    kind: 'overloaded',
  },
  {
    status: 429,
    error: {
      code: 'Throttling.ResourceExhausted',
      message:
        'InternalError.Algo: An error occurred in model serving, error message is: [Too many requests.]',
      type: 'Throttling.ResourceExhausted',
    },
    kind: 'overloaded',
  },
  {
    status: 400,
    error: {
      code: 'data_inspection_failed',
      message: 'Input data may contain inappropriate content.',
      type: 'data_inspection_failed',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    error: {
      code: 'FaqRuleBlocked',
      message: 'Input or output data is blocked by faq rule.',
      type: 'FaqRuleBlocked',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    error: {
      code: 'CustomRoleBlocked',
      message:
        'Input or output data may contain inappropriate content with custom rule.',
      type: 'CustomRoleBlocked',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    error: {
      code: 'IPInfringementSuspect',
      message: 'Input data is suspected of being involved in IP infringement.',
      type: 'IPInfringementSuspect',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    error: {
      code: 'invalid_parameter_error',
      message: 'Range of input length should be [1, 129024]',
      type: 'invalid_request_error',
    },
    kind: 'context_too_long',
  },
  {
    status: 404,
    error: {
      code: 'model_not_found',
      message:
        'The model `qwen-none` does not exist or you do not have access to it.',
      type: 'invalid_request_error',
    },
    kind: 'unknown_model',
  },
  {
    status: 404,
    error: {
      code: 'model_not_supported',
      message: 'Unsupported model qwen-tts for OpenAI compatibility mode.',
      type: 'invalid_request_error',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    error: {
      code: 'InvalidParameter',
      message: 'Model not exist.',
      type: 'InvalidParameter',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    error: {
      code: 'invalid_parameter_error',
      message: 'The tool_choice parameter must be "auto" or "none".',
      type: 'invalid_request_error',
    },
    kind: 'invalid_request',
  },
])(
  '$error.code told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      dashscope({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'dashscope/qwen3.7-plus',
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
    status: 401,
    error: {
      code: 'invalid_api_key',
      message: 'Incorrect API key provided.',
      type: 'invalid_request_error',
    },
    kind: 'upstream_refused',
  },
])(
  '$error.code told as $status is the host`s to mend, and its words are kept for the host, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      dashscope({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'dashscope/qwen3.7-plus',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: kind,
          message: "The upstream refused the host's credentials or account",
          upstream: true,
          provider: { dashscope: { message: error.message } },
        },
      },
    ]);
  },
);

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/dashscope.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['dashscope']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
