import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import * as entry from '../src/minimax.ts';
import { minimax } from '../src/minimax.ts';

test('built from MiniMax`s reference alone, with no key held: it serves the names under its prefix, and with no key it fails when made', () => {
  const adapter = minimax({ key: 'sk-host' });

  expect(adapter.serves('minimax/MiniMax-M2.7')).toBe(true);
  expect(adapter.serves('openrouter/minimax/minimax-m2.7')).toBe(false);
  expect(minimax({ key: 'k', prefix: 'own' }).serves('own/x')).toBe(true);
  expect(adapter.decide).toBeUndefined();
  expect(() => minimax({ key: undefined })).toThrow(
    'The minimax adapter was given no key',
  );
  expect(() => minimax({ key: '' })).toThrow();
  expect(() => minimax({ key: ' \t' })).toThrow(
    'The minimax adapter was given no key',
  );
});

test('a call goes to Chat Completions under the address with the key, and reasoning between think tags cut across chunks, a tool call and usage are read, by its reference', async () => {
  const seen: { path: string; key: string | null }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
      });
      return new Response(
        `data: {"id":"0629","object":"chat.completion.chunk","model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"role":"assistant","content":"<thi"},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"content":"nk>I need the weather tool.</th"},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"content":"ink>Let me check."},"finish_reason":null}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_function_7k2","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Hangzhou\\"}"}}]},"finish_reason":"tool_calls"}]}

data: {"id":"0629","object":"chat.completion.chunk","model":"MiniMax-M2.7","choices":[],"usage":{"prompt_tokens":58,"completion_tokens":40,"total_tokens":98}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    minimax({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M2.7',
      { messages: [{ role: 'user', text: 'Weather in Hangzhou?' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    { path: '/v1/chat/completions', key: 'Bearer sk-host' },
  ]);
  expect(events).toMatchObject([
    { type: 'reasoning', text: 'I need the weather tool.' },
    { type: 'text', text: 'Let me check.' },
    {
      type: 'tool_call',
      id: 'call_function_7k2',
      name: 'get_weather',
      arguments: '{"city": "Hangzhou"}',
    },
    { type: 'finish', reason: 'tool_calls', usage: { input: 58, output: 40 } },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test('an order not to reason has no word every model takes, so it is left out and reported', async () => {
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
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M2.7',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'none' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'MiniMax-M2.7',
      messages: [{ role: 'user', content: 'What is 17*23?' }],
      stream: true,
      stream_options: { include_usage: true },
    },
  ]);
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'reasoning.off',
        detail: 'Chat Completions has no field for an order not to reason',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 1);
});

test('an effort has no word every model takes, so it is left out and reported', async () => {
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
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M2.7',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { effort: 'high' } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'MiniMax-M2.7',
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

test('a budget has no field, and is left out and reported', async () => {
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
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M2.7',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { reasoning: { budgetTokens: 2000 } },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      model: 'MiniMax-M2.7',
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
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M2.7',
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
      model: 'MiniMax-M2.7',
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

test('a temperature above the range goes as the nearest inside, and a penalty has no field', async () => {
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
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M2.7',
      {
        messages: [{ role: 'user', text: 'What is 17*23?' }],
        options: { temperature: 2.5, topP: 0.9, frequencyPenalty: 1 },
      },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toEqual([
    {
      temperature: 2,
      top_p: 0.9,
      model: 'MiniMax-M2.7',
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
        setting: 'frequencyPenalty.model',
        detail:
          'Chat Completions has no field for a frequency penalty the model does not take',
      },
    ],
  });
  expect(events.at(-1)).toHaveProperty('warnings.length', 2);
});

test('reasoning goes back inside the assistant turn`s text, between the tags it came in', async () => {
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
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M2.7',
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
          content: [
            {
              type: 'text',
              text: '<think>Paris is at 48 degrees.</think>Paris',
            },
          ],
        },
        { role: 'user', content: 'And further south?' },
      ],
    },
  ]);
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  {
    base: { status_code: 1002, status_msg: 'rate limit' },
    kind: 'rate_limited',
  },
  {
    base: { status_code: 1008, status_msg: 'insufficient balance' },
    kind: 'quota_exceeded',
  },
  {
    base: { status_code: 1027, status_msg: 'output new_sensitive' },
    kind: 'blocked',
  },
  {
    base: { status_code: 1039, status_msg: 'token limit' },
    kind: 'context_too_long',
  },
  {
    base: { status_code: 1013, status_msg: 'internal service error' },
    kind: 'upstream_failed',
  },
  {
    base: { status_code: 1001, status_msg: 'request timeout' },
    kind: 'timed_out',
  },
  {
    base: { status_code: 2013, status_msg: 'invalid params' },
    kind: 'invalid_request',
  },
  {
    base: { status_code: '1008', status_msg: 'insufficient balance' },
    kind: 'quota_exceeded',
  },
  {
    base: { status_code: 1026, status_msg: 'input new_sensitive' },
    kind: 'blocked',
  },
  {
    base: { status_code: 1041, status_msg: 'conn limit' },
    kind: 'rate_limited',
  },
  {
    base: { status_code: 2045, status_msg: 'rate growth limit' },
    kind: 'rate_limited',
  },
  {
    base: { status_code: 2046, status_msg: 'token growth limit' },
    kind: 'rate_limited',
  },
  {
    base: { status_code: 2047, status_msg: 'conn growth limit' },
    kind: 'rate_limited',
  },
  {
    base: { status_code: 2053, status_msg: 'insufficient credit' },
    kind: 'quota_exceeded',
  },
  {
    base: { status_code: 2056, status_msg: 'usage limit exceeded' },
    kind: 'quota_exceeded',
  },
  {
    base: {
      status_code: 2067,
      status_msg: 'usage limit reached and credit auto consumption is off',
    },
    kind: 'quota_exceeded',
  },
  {
    base: { status_code: 2022, status_msg: 'model is not exist' },
    kind: 'unknown_model',
  },
  {
    base: { status_code: 2069, status_msg: 'model is no longer available' },
    kind: 'unknown_model',
  },
  {
    base: {
      status_code: 2064,
      status_msg: 'The server cluster is currently under high load',
    },
    kind: 'overloaded',
  },
  {
    base: {
      status_code: 2066,
      status_msg: 'The request timed out while processing',
    },
    kind: 'timed_out',
  },
])(
  'status $base.status_code inside a reply that began well is $kind, in the upstream`s words, by its reference',
  async ({ base, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `data: {"id":"0629","model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"role":"assistant","content":"39"}}]}

data: ${JSON.stringify({ id: '0629', choices: [], base_resp: base })}

`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const { models } = adapted([
      minimax({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'minimax/MiniMax-M2.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      { type: 'text', text: '39' },
      {
        type: 'error',
        error: {
          code: kind,
          message: base.status_msg,
          provider: { minimax: { status_code: base.status_code } },
          upstream: true,
        },
      },
    ]);
  },
);

test.each([
  {
    base: {
      status_code: 1004,
      status_msg:
        'login fail: Please carry the API secret key in the Authorization field of the request header',
    },
    kind: 'upstream_refused',
  },
  {
    base: { status_code: 2049, status_msg: 'invalid API Key' },
    kind: 'upstream_refused',
  },
])(
  'status $base.status_code inside a reply is the host`s to mend, and its words are kept for the host, by its reference',
  async ({ base, kind }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `data: {"id":"0629","model":"MiniMax-M2.7","choices":[{"index":0,"delta":{"role":"assistant","content":"39"}}]}

data: ${JSON.stringify({ id: '0629', choices: [], base_resp: base })}

`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    const { models } = adapted([
      minimax({ key: 'sk-6f1c', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'minimax/MiniMax-M2.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      { type: 'text', text: '39' },
      {
        type: 'error',
        error: {
          code: kind,
          message: "The upstream refused the host's credentials or account",
          provider: {
            minimax: {
              status_code: base.status_code,
              message: base.status_msg,
            },
          },
          upstream: true,
        },
      },
    ]);
  },
);

test('a status of zero in every chunk of a reply is no failure, and one MiniMax lists nowhere ends it as the upstream`s, with or without words', async () => {
  const replies = [
    'data: {"choices":[{"index":0,"delta":{"content":"39"},"finish_reason":"stop"}],"base_resp":{"status_code":0,"status_msg":""}}\n\ndata: [DONE]\n\n',
    'data: {"choices":[],"base_resp":{"status_code":1000,"status_msg":"unknown error"}}\n\n',
    'data: {"base_resp":{"status_code":"1000"}}\n\n',
  ];
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(replies.shift(), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  });
  const { models } = adapted([
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);
  const asked = () =>
    Array.fromAsync(
      models(
        'minimax/MiniMax-M2.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

  expect([await asked(), await asked(), await asked()]).toEqual([
    [
      { type: 'text', text: '39' },
      { type: 'finish', reason: 'stop', rawReason: 'stop' },
    ],
    [
      {
        type: 'error',
        error: {
          code: 'upstream_failed',
          message: 'unknown error',
          retryable: false,
          provider: {
            minimax: { status_code: 1000, status_msg: 'unknown error' },
          },
          upstream: true,
        },
      },
    ],
    [
      {
        type: 'error',
        error: {
          code: 'upstream_failed',
          message: 'The upstream answered with an error',
          retryable: false,
          provider: { minimax: { status_code: '1000' } },
          upstream: true,
        },
      },
    ],
  ]);
});

test('a response that failed is named by its status, in the words of its reference, and recorded under MiniMax`s name', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          error: {
            type: 'invalid_request_error',
            message:
              'model "MiniMax-M3.1-Flash-Preview" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)',
          },
        },
        { status: 400 },
      ),
  });
  const { models } = adapted([
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'minimax/MiniMax-M3.1-Flash-Preview',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'invalid_request',
        status: 400,
        message:
          'model "MiniMax-M3.1-Flash-Preview" requires adaptive thinking; thinking.type="disabled" (including reasoning.effort=none) is not allowed (2013)',
        provider: { minimax: { status: 400 } },
        upstream: true,
      },
    },
  ]);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/minimax.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['minimax']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});

test('a failure told as one JSON body under a status that tells none is read from MiniMax`s own status, not as a stream that closed', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        base_resp: { status_code: 1008, status_msg: 'insufficient balance' },
      }),
  });
  const { models } = adapted([
    minimax({ key: 'sk-host', address: upstream.url.origin }),
  ]);

  expect(
    await Array.fromAsync(
      models(
        'minimax/MiniMax-M2.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    ),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'quota_exceeded',
        message: 'insufficient balance',
        provider: {
          minimax: {
            status: 200,
            status_code: 1008,
            status_msg: 'insufficient balance',
          },
        },
        upstream: true,
      },
    },
  ]);
});

test('a failed response that holds MiniMax`s own status and no error is named by it', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { base_resp: { status_code: 1004, status_msg: 'login fail' } },
        { status: 401 },
      ),
  });
  const { models } = adapted([
    minimax({ key: 'sk-6f1c', address: upstream.url.origin }),
  ]);

  expect(
    await Array.fromAsync(
      models(
        'minimax/MiniMax-M2.7',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    ),
  ).toEqual([
    {
      type: 'error',
      error: {
        code: 'upstream_refused',
        message: "The upstream refused the host's credentials or account",
        provider: {
          minimax: {
            status: 401,
            status_code: 1004,
            status_msg: 'login fail',
            message: 'login fail',
          },
        },
        upstream: true,
      },
    },
  ]);
});
