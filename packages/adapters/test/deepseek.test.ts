import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import { adapted, type Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import * as entry from '../src/deepseek.ts';
import { deepseek } from '../src/deepseek.ts';

test('it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = deepseek({ key: 'sk-host' });

  expect(adapter.serves('deepseek/deepseek-flash')).toBe(true);
  expect(adapter.serves('openrouter/deepseek/deepseek-chat')).toBe(false);
  expect(deepseek({ key: 'k', prefix: 'ds' }).serves('ds/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => deepseek({ key: undefined })).toThrow(
    'The deepseek adapter was given no key',
  );
  expect(() => deepseek({ key: '' })).toThrow();
  expect(() => deepseek({ key: ' \t' })).toThrow(
    'The deepseek adapter was given no key',
  );
});

test('a call goes to Chat Completions under the address, with the limit named as this API names it, and its reasoning is read', async () => {
  const seen: { path: string; key: string | null; body: unknown }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
        body: await request.json(),
      });
      return new Response(
        `data: {"id":"1f63","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"","reasoning_content":"9.8 is greater.","role":"assistant"},"finish_reason":null}]}

data: {"id":"1f63","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"9.8"},"finish_reason":null}]}

data: {"id":"1f63","model":"deepseek-flash","choices":[{"index":0,"delta":{"content":"","role":null},"finish_reason":"stop"}],"usage":{"completion_tokens":9,"prompt_tokens":17,"total_tokens":26,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":5}}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      {
        messages: [{ role: 'user', text: '9.11 or 9.8?' }],
        options: { maxTokens: 200, reasoning: { effort: 'max' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      path: '/chat/completions',
      key: 'Bearer sk-host',
      body: {
        reasoning_effort: 'max',
        max_tokens: 200,
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: '9.11 or 9.8?' }],
        stream: true,
        stream_options: { include_usage: true },
      },
    },
  ]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: '9.8 is greater.' },
    { type: 'text', text: '9.8' },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 17, output: 9, reasoning: 5 },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an order not to reason turns the thinking switch off', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"9.8"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      {
        messages: [{ role: 'user', text: '9.11 or 9.8?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      thinking: { type: 'disabled' },
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '9.11 or 9.8?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
});

test('a budget and a mute have no field: thinking is turned on and both are reported', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"9.8"},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      {
        messages: [{ role: 'user', text: '9.11 or 9.8?' }],
        options: { reasoning: { budgetTokens: 2000, exclude: true } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      thinking: { type: 'enabled' },
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '9.11 or 9.8?' }],
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
      {
        setting: 'reasoning.exclude',
        detail:
          'Chat Completions has no field for an order to keep reasoning out of the reply',
      },
    ],
  });
});

test('a Chat Completions caller in a tool loop has its reasoning sent back as reasoning_content', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"","reasoning_content":"The result is in.","role":"assistant"},"finish_reason":null}]}

data: {"choices":[{"index":0,"delta":{"content":"Cloudy."},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      model('deepseek/deepseek-flash').complete(prompt),
    ),
    () => ({
      models: [deepseek({ key: 'sk-host', address: upstream.url.origin })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        messages: [
          { role: 'user', content: 'Weather in Hangzhou?' },
          {
            role: 'assistant',
            content: '',
            reasoning_content: 'I need the weather tool.',
            tool_calls: [
              {
                id: 'call_00_kw66',
                type: 'function',
                function: { name: 'get_weather', arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_00_kw66', content: 'Cloudy' },
        ],
      }),
    }),
  );
  const answer = await reply.json();
  await served.close();

  expect(seen).toMatchObject([
    {
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: 'Weather in Hangzhou?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_00_kw66' }],
          reasoning_content: 'I need the weather tool.',
        },
        { role: 'tool', tool_call_id: 'call_00_kw66', content: 'Cloudy' },
      ],
    },
  ]);
  expect(answer).toMatchObject({
    choices: [
      {
        message: {
          content: 'Cloudy.',
          reasoning: 'The result is in.',
          reasoning_content: 'The result is in.',
        },
      },
    ],
  });
  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.calls[0]).not.toHaveProperty('warnings');
});

test('details another provider wrote have no field here: their text goes back and the rest is reported', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"content":"Cloudy."},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      {
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'reasoning',
                text: 'Paris is north.',
                provider: {
                  'openai.chat': {
                    reasoning_details: [
                      { type: 'reasoning.text', signature: 'EqQB', index: 0 },
                    ],
                  },
                },
              },
              { type: 'text', text: 'Paris' },
            ],
          },
          { role: 'user', text: 'And south?' },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      messages: [
        { role: 'assistant', reasoning_content: 'Paris is north.' },
        { role: 'user' },
      ],
    },
  ]);
  expect(JSON.stringify(seen)).not.toContain('EqQB');
  expect(events.at(-1)).toMatchObject({
    warnings: [
      {
        setting: 'reasoning',
        detail: 'Chat Completions has no field for reasoning it did not sign',
      },
    ],
  });
});

test('a failure is recorded under DeepSeek`s name', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message: 'Missing reasoning_content',
            type: 'invalid_request_error',
            code: 'invalid_request_error',
          },
        },
        { status: 400 },
      ),
  });
  const { models } = adapted([
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'invalid_request',
        message: 'Missing reasoning_content',
        provider: { deepseek: { status: 400 } },
        upstream: true,
      },
    },
  ]);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/deepseek.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['deepseek']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});

test('a picture goes upstream by address, by bytes or as an uploaded file, also from a tool; sound and a PDF have no form', async () => {
  const seen: unknown[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push(await request.json());
      return new Response(
        `data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"A cat."},"finish_reason":"stop"}]}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    deepseek({ key: 'sk-host', address: upstream.url.href }),
  ]);

  await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      {
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'image', url: 'https://x.test/cat.png' },
              { type: 'image', data: '/9j/4AAQ', mediaType: 'image/jpeg' },
              { type: 'image', id: 'file-api-1' },
            ],
          },
          {
            role: 'tool',
            parts: [
              {
                type: 'tool_result',
                id: 'call_1',
                parts: [{ type: 'image', id: 'file-api-2' }],
              },
            ],
          },
        ],
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://x.test/cat.png' } },
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' },
            },
            { type: 'file', file_id: 'file-api-1' },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [{ type: 'file', file_id: 'file-api-2' }],
        },
      ],
    },
  ]);
  for (const part of [
    { type: 'audio', data: 'UklGRg==', mediaType: 'audio/wav' },
    { type: 'file', data: 'JVBERi0=', mediaType: 'application/pdf' },
  ] as const) {
    const events = await Array.fromAsync(
      models(
        'deepseek/deepseek-flash',
        { messages: [{ role: 'user', parts: [part] }] },
        AbortSignal.timeout(5000),
      ),
    );
    expect(events).toMatchObject([
      { type: 'error', error: { code: 'unsupported' } },
    ]);
  }
  expect(seen).toHaveLength(1);
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
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'medium' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      reasoning_effort: 'high',
      model: 'deepseek-flash',
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
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
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
      response_format: { type: 'json_object' },
      model: 'deepseek-flash',
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

test('no rule is known for what a model samples with, so a setting is sent as given', async () => {
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
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 2.5, topP: 0.9 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      temperature: 2.5,
      top_p: 0.9,
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    status: 402,
    error: {
      message: 'Insufficient Balance',
      type: 'unknown_error',
      code: 'invalid_request_error',
    },
    kind: 'quota_exceeded',
  },
  {
    status: 422,
    error: {
      message:
        'Failed to deserialize the JSON body into the target type: temperature: invalid value',
      type: 'invalid_request_error',
      code: 'invalid_request_error',
    },
    kind: 'invalid_request',
  },
  {
    status: 429,
    error: {
      message: 'Rate Limit Reached',
      type: 'rate_limit_error',
      code: 'rate_limit_error',
    },
    kind: 'rate_limited',
  },
  {
    status: 503,
    error: {
      message: 'Server Overloaded',
      type: 'service_unavailable_error',
      code: 'service_unavailable_error',
    },
    kind: 'overloaded',
  },
])(
  'a failure told as $status is $kind whatever the error calls itself, in the upstream`s words, by its reference',
  async ({ status, error, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error }, { status }),
    });
    const { models } = adapted([
      deepseek({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'deepseek/deepseek-flash',
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

test('a refused key is told in the SDK`s words, and the record holds what was said with the key cut from it', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            message:
              'Authentication Fails, Your api key: ****abcd is invalid (request_id: fb642953-7c1e-4b0a-9d55-0e2f6a1b3c4d)',
            type: 'authentication_error',
            code: 'invalid_request_error',
          },
        },
        { status: 401 },
      ),
  });
  const { models } = adapted([
    deepseek({
      key: 'sk-0123456789abcdef0123456789abcd',
      address: upstream.url.origin,
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
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
        provider: {
          deepseek: {
            message:
              'Authentication Fails, Your api key: ****[key] is invalid (request_id: fb642953-7c1e-4b0a-9d55-0e2f6a1b3c4d)',
          },
        },
      },
    },
  ]);
});

test('the id of a failed request is cut from what the caller is told, and kept for the host', async () => {
  const said =
    'Rate Limit Reached (request_id: fb642953-7c1e-4b0a-9d55-0e2f6a1b3c4d)';
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: { message: said, type: 'rate_limit_error' } },
        { status: 429 },
      ),
  });
  const { models } = adapted([
    deepseek({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'deepseek/deepseek-flash',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'rate_limited',
        message: 'Rate Limit Reached',
        provider: { deepseek: { message: said } },
      },
    },
  ]);
});
