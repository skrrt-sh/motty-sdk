import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/zai.ts';
import { zai } from '../src/zai.ts';

test('built from GLM`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = zai({ key: 'sk-host' });

  expect(adapter.serves('zai/glm-5.3')).toBe(true);
  expect(adapter.serves('openrouter/z-ai/glm-5.3')).toBe(false);
  expect(zai({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => zai({ key: undefined })).toThrow(
    'The zai adapter was given no key',
  );
  expect(() => zai({ key: '' })).toThrow();
  expect(() => zai({ key: ' \t' })).toThrow('The zai adapter was given no key');
});

test('a call goes to Chat Completions under the address with the key, and its reasoning, a streamed tool call and usage are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"20261010","created":1791633316,"model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"I need the weather tool."}}]}

data: {"id":"20261010","created":1791633316,"model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"call_8f1","index":0,"type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}

data: {"id":"20261010","created":1791633316,"model":"glm-5.3","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"function":{"arguments":"\\"Hangzhou\\"}"}}]}}]}

data: {"id":"20261010","created":1791633316,"model":"glm-5.3","choices":[{"index":0,"finish_reason":"tool_calls","delta":{"role":"assistant","content":""}}],"usage":{"prompt_tokens":172,"completion_tokens":31,"total_tokens":203,"prompt_tokens_details":{"cached_tokens":159}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    zai({ key: 'sk-host', address: `${upstream.url}api/paas/v4` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    { path: '/api/paas/v4/chat/completions', key: 'Bearer sk-host' },
  ]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'I need the weather tool.' },
    {
      type: 'tool_call',
      id: 'call_8f1',
      name: 'get_weather',
      arguments: '{"city":',
    },
    { type: 'tool_call', id: 'call_8f1', arguments: '"Hangzhou"}' },
    { type: 'finish', reason: 'tool_calls', usage: { input: 172, output: 31 } },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an order not to reason turns the thinking switch off, and tool arguments are asked to stream', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: true,
      thinking: { type: 'disabled' },
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an effort goes at one of the three levels, the nearest for one it has not', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'medium' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: true,
      reasoning_effort: 'high',
      model: 'glm-5.3',
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

test('a budget has no field: thinking is turned on and the amount is reported', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: true,
      thinking: { type: 'enabled' },
      model: 'glm-5.3',
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

test('a schema is asked for as any JSON object, and reported', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
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
      tool_stream: true,
      response_format: { type: 'json_object' },
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'output.schema',
        detail:
          'Chat Completions has no field for the schema of a JSON output, to an upstream that takes any JSON object',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('a temperature and a top-p outside the range go as the nearest inside, a penalty has no field, and the limit is named as this API names it', async () => {
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: {
          temperature: 1.5,
          topP: 0,
          presencePenalty: 1,
          maxTokens: 50,
        },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: true,
      max_tokens: 50,
      temperature: 1,
      top_p: 0.01,
      model: 'glm-5.3',
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
      {
        setting: 'presencePenalty.model',
        detail:
          'Chat Completions has no field for a presence penalty the model does not take',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 3);
});

test('the host`s own body field replaces the one the adapter sets', async () => {
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
    zai({
      key: 'sk-host',
      address: upstream.url.origin,
      body: { tool_stream: false, do_sample: false },
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-4.5',
      { messages: [{ role: 'user', text: 'What is 17*23?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      tool_stream: false,
      do_sample: false,
      model: 'glm-4.5',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
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
    zai({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
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
    status: 429,
    error: {
      code: '1113',
      message: 'Insufficient balance or no resource package. Please recharge.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1308',
      message:
        'Usage limit reached for 5 hour. Your limit will reset at 2026-10-10 18:00:00',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1309',
      message:
        'Your GLM Coding Plan package has expired and is temporarily unavailable.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1310',
      message:
        'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-12 00:00:00',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1314',
      message:
        'Your enterprise package has expired. Please contact your enterprise administrator.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1316',
      message:
        'Usage limit reached for the past 5 hours. Insufficient balance for extra usage. Resets at 2026-10-10 18:00:00.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1317',
      message:
        'Usage limit reached for the past 7 days. Insufficient balance for extra usage. Resets at 2026-10-12 00:00:00.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1318',
      message:
        'Usage limit reached for the past 5 hours. Extra usage is not available due to monthly spend limit. Resets at 2026-10-10 18:00:00.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1319',
      message:
        'Usage limit reached for the past 7 days. Extra usage is not available due to monthly spend limit. Resets at 2026-10-12 00:00:00.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1320',
      message:
        'Usage limit reached for the past 5 hours. Extra usage is not available due to monthly spend limit. Resets at 2026-10-10 18:00:00.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: {
      code: '1321',
      message:
        'Usage limit reached for the past 7 days. Extra usage is not available due to monthly spend limit. Resets at 2026-10-12 00:00:00.',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 429,
    error: { code: '1302', message: 'Rate limit reached for requests' },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: '1313',
      message:
        'Your account`s current usage pattern does not comply with the Fair Usage Policy, and your request frequency has been limited.',
    },
    kind: 'rate_limited',
  },
  {
    status: 429,
    error: {
      code: '1305',
      message:
        'The service may be temporarily overloaded, please try again later',
    },
    kind: 'overloaded',
  },
  {
    status: 400,
    error: {
      code: '1211',
      message: 'Unknown Model, please check the model code.',
    },
    kind: 'unknown_model',
  },
  {
    status: 429,
    error: {
      code: '1311',
      message:
        'Your current subscription plan does not yet include access to glm-5.3',
    },
    kind: 'unknown_model',
  },
  {
    status: 400,
    error: { code: '1261', message: 'Prompt too long' },
    kind: 'context_too_long',
  },
  {
    status: 400,
    error: {
      code: '1301',
      message:
        'System detected potentially unsafe or sensitive content in input or generation.',
    },
    kind: 'blocked',
  },
  {
    status: 400,
    error: {
      code: '1212',
      message: 'Current model does not support stream call method',
    },
    kind: 'unsupported',
  },
  {
    status: 400,
    error: {
      code: '1214',
      message: 'Parameter top_p is invalid. Please check the documentation.',
    },
    kind: 'invalid_request',
  },
  {
    status: 500,
    error: {
      code: '1234',
      message: 'Network error, error id: 7f3, please try again later',
    },
    kind: 'upstream_failed',
  },
])(
  'code $error.code told as $status is $kind, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      zai({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'zai/glm-5.3',
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

test('a parameter out of range is the caller`s request to mend, in the words seen live', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            code: '1210',
            message: 'The temperature parameter is illegal',
          },
        },
        { status: 400 },
      ),
  });
  const { models } = adapted([
    zai({
      key: 'sk-host',
      address: upstream.url.origin,
      takes: () => undefined,
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'zai/glm-5.3',
      { messages: [{ role: 'user', text: 'hi' }], options: { temperature: 2 } },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'invalid_request',
        status: 400,
        message: 'The temperature parameter is illegal',
        provider: { zai: { status: 400, code: '1210' } },
      },
    },
  ]);
});

test.each([
  {
    status: 401,
    error: { code: '1000', message: 'Authentication Failed' },
    kind: 'upstream_refused',
  },
  {
    status: 401,
    error: {
      code: '1001',
      message:
        'Authentication parameter not received in Header, unable to authenticate',
    },
    kind: 'upstream_refused',
  },
  {
    status: 401,
    error: { code: '1002', message: 'Authentication Token is invalid' },
    kind: 'upstream_refused',
  },
  {
    status: 401,
    error: {
      code: '1003',
      message: 'Authentication Token expired, please regenerate/obtain',
    },
    kind: 'upstream_refused',
  },
  {
    status: 401,
    error: {
      code: '1004',
      message: 'Authentication failed with the provided token',
    },
    kind: 'upstream_refused',
  },
  {
    status: 401,
    error: { code: '1005', message: 'Need Two-Factor Authentication' },
    kind: 'upstream_refused',
  },
  {
    status: 403,
    error: {
      code: '1220',
      message: 'You do not have permission to access chat',
    },
    kind: 'upstream_refused',
  },
  {
    status: 429,
    error: {
      code: '1315',
      message:
        'This API Key is limited to enterprise coding package scenarios.',
    },
    kind: 'upstream_refused',
  },
])(
  'code $error.code told as $status is the host`s to mend, and its words are kept for the host, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      zai({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'zai/glm-5.3',
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
          provider: { zai: { message: error.message } },
        },
      },
    ]);
  },
);

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(new URL('../src/zai.ts', import.meta.url)).text();

  expect(Object.keys(entry).sort()).toEqual(['zai']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
