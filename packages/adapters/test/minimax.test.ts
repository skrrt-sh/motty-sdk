import { expect, test } from 'bun:test';
import { adapted } from '@mottyjs/core/host';
import { minimax } from '../src/minimax.ts';

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
    base: { status_code: 2022, status_msg: 'model is not exist' },
    kind: 'unknown_model',
  },
  {
    base: {
      status_code: 2064,
      status_msg: 'The server cluster is currently under high load',
    },
    kind: 'overloaded',
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
