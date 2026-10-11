import { expect, test } from 'bun:test';
import { fallback, model, motty } from '@mottyjs/core';
import { adapted, type Report } from '@mottyjs/core/host';
import { mount } from '@mottyjs/serve';
import { run } from '@mottyjs/test';
import * as entry from '../src/openai.ts';
import { openai } from '../src/openai.ts';

const answered = `event: response.created
data: {"type":"response.created","response":{"id":"resp_1","object":"response","status":"in_progress","model":"gpt-5","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","status":"in_progress","role":"assistant","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hello"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":" there"}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","object":"response","status":"completed","model":"gpt-5","output":[{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"Hello there","annotations":[]}]}],"usage":{"input_tokens":9,"output_tokens":2,"total_tokens":11}}}

`;

test('it serves the names under its prefix and no other', () => {
  const adapter = openai({ key: 'sk-host' });
  const groq = openai({ key: 'gsk-host', prefix: 'groq' });

  expect(adapter.serves('openai/gpt-5')).toBe(true);
  expect(adapter.serves('openai')).toBe(false);
  expect(adapter.serves('openaix/gpt-5')).toBe(false);
  expect(adapter.serves('anthropic/claude-opus')).toBe(false);
  expect(groq.serves('groq/llama-4')).toBe(true);
  expect(groq.serves('openai/gpt-5')).toBe(false);
  expect(adapter.decide).toBeUndefined();
});

test('with no key it fails when made', () => {
  expect(() => openai({ key: undefined })).toThrow(
    'The openai adapter was given no key',
  );
  expect(() => openai({ key: '' })).toThrow();
  expect(() => openai({ key: ' \t' })).toThrow(
    'The openai adapter was given no key',
  );
});

test('an api it does not speak fails when made, in words that name the option', () => {
  // @ts-expect-error the two it speaks are the type
  expect(() => openai({ key: 'sk-host', api: 'completions' })).toThrow(
    /^The openai adapter was given an api that is none: it takes 'responses' or 'chat-completions'$/,
  );
});

test('a call goes to the Responses API with the key and the provider name', async () => {
  const seen: { path: string; key: string | null; body: unknown }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('authorization'),
        body: await request.json(),
      });
      return new Response(answered, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const { models } = adapted([
    openai({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openai/gpt-5',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      path: '/v1/responses',
      key: 'Bearer sk-host',
      body: { model: 'gpt-5', stream: true },
    },
  ]);
  expect(events).toMatchObject([
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' there' },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 9, output: 2 },
      id: 'resp_1',
      model: 'gpt-5',
    },
  ]);
});

test('another provider is served by prefix, address and Chat Completions', async () => {
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
        `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"llama-4","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"llama-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"llama-4","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"llama-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: {"id":"chatcmpl-1","object":"chat.completion.chunk","model":"llama-4","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}

data: [DONE]

`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const { models } = adapted([
    openai({
      key: 'gsk-host',
      prefix: 'groq',
      address: `${upstream.url}openai/v1`,
      api: 'chat-completions',
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'groq/meta/llama-4',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      path: '/openai/v1/chat/completions',
      key: 'Bearer gsk-host',
      body: { model: 'meta/llama-4', stream: true },
    },
  ]);
  expect(events).toMatchObject([
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' there' },
    { type: 'finish', reason: 'stop', usage: { input: 9, output: 2 } },
  ]);
});

test.each([
  [
    'a router`s marker with its lifetime',
    { breakpoints: 'cache_control' },
    { cache_control: { type: 'ephemeral', ttl: '1h' } },
    [],
  ],
  [
    'OpenAI`s breakpoint, which has no lifetime',
    { breakpoints: true },
    { prompt_cache_breakpoint: { mode: 'explicit' } },
    ['cache.ttl'],
  ],
  ['nothing, as OpenAI`s own models take none', {}, {}, ['cache.ttl', 'cache']],
] as const)(
  'a cache marker is written as %s, where the host says so',
  async (_, marks, written, leftOut) => {
    for (const api of ['responses', 'chat-completions'] as const) {
      const sent: unknown[] = [];
      using upstream = Bun.serve({
        port: 0,
        fetch: async (request) => {
          sent.push(await request.json());
          return new Response(
            api === 'responses'
              ? answered
              : 'data: {"id":"chatcmpl-1","model":"gpt-5","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      });
      const { models } = adapted([
        openai({ key: 'sk-host', address: `${upstream.url}v1`, api, ...marks }),
      ]);

      const events = await Array.fromAsync(
        models(
          'openai/gpt-5',
          {
            messages: [
              {
                role: 'user',
                parts: [
                  { type: 'text', text: 'Stable', cache: { ttl: '1h' } },
                  { type: 'text', text: 'hi' },
                ],
              },
            ],
          },
          AbortSignal.timeout(5000),
        ),
      );

      const text = api === 'responses' ? 'input_text' : 'text';
      const said = [
        {
          role: 'user',
          content: [
            { type: text, text: 'Stable', ...written },
            { type: text, text: 'hi' },
          ],
        },
      ];
      expect(sent).toEqual([
        expect.objectContaining(
          api === 'responses'
            ? { input: [{ type: 'message', ...said[0] }] }
            : { messages: said },
        ),
      ]);
      const finish = events.at(-1);
      if (finish?.type !== 'finish') throw new Error('The call did not finish');
      expect((finish.warnings ?? []).map(({ setting }) => setting)).toEqual([
        ...leftOut,
      ]);
    }
  },
);

test.each([
  [400, 'invalid_request_error', null, 'invalid_request'],
  [400, 'invalid_request_error', 'context_length_exceeded', 'context_too_long'],
  [401, 'invalid_request_error', 'invalid_api_key', 'upstream_refused'],
  [404, 'invalid_request_error', 'model_not_found', 'unknown_model'],
  [429, 'rate_limit_error', 'rate_limit_exceeded', 'rate_limited'],
  [429, 'insufficient_quota', 'insufficient_quota', 'quota_exceeded'],
  [500, 'server_error', null, 'upstream_failed'],
  [503, null, null, 'overloaded'],
])(
  'an upstream %i %s %s is one %s error',
  async (status, type, code, expected) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { error: { message: 'The upstream said why', type, code } },
          { status, headers: { 'retry-after': '3' } },
        ),
    });
    const { models } = adapted([
      openai({ key: 'sk-host', address: `${upstream.url}v1` }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openai/gpt-5',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: expected,
          message:
            expected === 'upstream_refused'
              ? "The upstream refused the host's credentials or account"
              : 'The upstream said why',
          retryAfter: 3000,
          upstream: true,
        },
      },
    ]);
  },
);

test('a connection cut mid-stream ends in one retryable error', async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        async function* () {
          yield answered.slice(
            0,
            answered.indexOf('event: response.output_item.done'),
          );
          await Bun.sleep(20);
          await upstream.stop(true);
        },
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    openai({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openai/gpt-5',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' there' },
    {
      type: 'error',
      error: { code: 'upstream_failed', retryable: true, upstream: true },
    },
  ]);
});

test('a stop ends a call the upstream never answers, and the upstream sees it', async () => {
  const stop = new AbortController();
  const left = Promise.withResolvers<Event>();
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      request.signal.addEventListener('abort', left.resolve);
      stop.abort();
      return new Promise<Response>(() => {});
    },
  });
  const { models } = adapted([
    openai({ key: 'sk-host', address: `${upstream.url}v1` }),
  ]);

  const events = await Array.fromAsync(
    models(
      'openai/gpt-5',
      { messages: [{ role: 'user', text: 'hi' }] },
      stop.signal,
    ),
  );

  expect(events).toEqual([
    {
      type: 'error',
      error: { code: 'aborted', status: 499, message: 'The call was stopped' },
    },
  ]);
  expect((await left.promise).type).toBe('abort');
});

test('a motty answers through the adapter, and no caller header goes upstream', async () => {
  const seen: Headers[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(request.headers);
      return new Response(answered, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const relay = motty({ name: 'relay' }).handle(({ request }) =>
    model('openai/gpt-5').complete({ messages: request.messages }),
  );

  const { answer, calls } = await run(
    relay,
    {
      text: 'hi',
      headers: { authorization: 'Bearer caller', 'x-caller': 'secret' },
    },
    { models: [openai({ key: 'sk-host', address: `${upstream.url}v1` })] },
  );

  expect(await answer.text()).toBe('Hello there');
  expect(calls).toMatchObject([{ model: 'openai/gpt-5', input: 9, output: 2 }]);
  expect(seen.map((headers) => headers.get('authorization'))).toEqual([
    'Bearer sk-host',
  ]);
  expect(seen.map((headers) => headers.has('x-caller'))).toEqual([false]);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/openai.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['openai']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});

test.each([
  {
    status: 429,
    code: 'rate_limit_exceeded',
    said: 'Rate limit reached for gpt-4o in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on tokens per min (TPM): Limit 2000000, Used 1992777, Requested 92449. Please try again in 2.556s. Visit https://platform.openai.com/account/rate-limits to learn more.',
    told: 'Rate limit reached for gpt-4o on tokens per min (TPM): Limit 2000000, Used 1992777, Requested 92449. Please try again in 2.556s.',
  },
  {
    status: 429,
    code: 'rate_limit_exceeded',
    said: 'Request too large for gpt-4o in organization org-Kp8Rt4Xv9Lm2Zq7Bc1Nh6Wd3 on tokens per min (TPM): Limit 30000, Requested 30872. The input or output tokens must be reduced in order to run successfully. Visit https://platform.openai.com/account/rate-limits to learn more.',
    told: 'Request too large for gpt-4o on tokens per min (TPM): Limit 30000, Requested 30872. The input or output tokens must be reduced in order to run successfully.',
  },
  {
    status: 403,
    code: 'model_not_found',
    said: 'Project `proj_Kp8Rt4Xv9Lm2Zq7Bc1Nh6Wd3` does not have access to model `gpt-5.5-pro`',
    told: 'The project does not have access to model `gpt-5.5-pro`',
  },
  {
    status: 500,
    code: 'server_error',
    said: 'The server had an error processing your request. Sorry about that! You can retry your request, or contact us through our help center at help.openai.com if the error persists. (Please include the request ID req_2505f3b6fde24820ab1489f511ecea38 in your message.)',
    told: 'The server had an error processing your request. Sorry about that! You can retry your request, or contact us through our help center at help.openai.com if the error persists.',
  },
  {
    status: 429,
    code: 'rate_limit_exceeded',
    said: 'Limit of org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 reached, in words not seen before',
    told: 'Limit of reached, in words not seen before',
  },
])(
  'what names the host`s account is cut from a $status the caller is told, and kept for the host: $told',
  async ({ status, code, said, told }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ error: { message: said, code } }, { status }),
    });
    const { models } = adapted([
      openai({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openai/gpt-4o',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          message: told,
          provider: { 'openai.responses': { message: said } },
        },
      },
    ]);
  },
);

test.each([
  {
    status: 404,
    code: 'model_not_found',
    said: 'The model `ft:gpt-4o-mini-2024-07-18:my-org-team:custom:AbCd1234` does not exist',
  },
  {
    status: 400,
    code: 'invalid_value',
    said: "Invalid value: 'org-chart-generator-tool-v2'. Supported values are: 'function'.",
  },
  {
    status: 400,
    code: 'invalid_value',
    said: 'max_tokens is too large: 99999. This model supports at most 16384 completion tokens, whereas you provided 99999.',
  },
  {
    status: 400,
    code: 'invalid_value',
    said: "Invalid 'tools[0].function.name': string 'org-abcdefghijklmnopqrstuvwx' is bad",
  },
  {
    status: 400,
    code: 'invalid_value',
    said: 'Limit of org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 reached, in words not seen before',
  },
])(
  'a request told back to the caller keeps a name of the caller`s own, whatever its shape: $said',
  async ({ status, code, said }) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json({ error: { message: said, code } }, { status }),
    });
    const { models } = adapted([
      openai({ key: 'sk-host', address: upstream.url.origin }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openai/gpt-4o',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([{ type: 'error', error: { message: said } }]);
    expect(events).not.toMatchObject([
      { error: { provider: { 'openai.responses': { message: said } } } },
    ]);
  },
);

test('a Chat Completions upstream`s failure is cut the same, in a body and inside a stream', async () => {
  const error = {
    message:
      'Rate limit reached for gpt-4o in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on requests per min (RPM): Limit 500, Used 500, Requested 1.',
    code: 'rate_limit_exceeded',
  };
  let asked = 0;
  using upstream = Bun.serve({
    port: 0,
    fetch: () => {
      asked += 1;
      return asked === 1
        ? Response.json({ error }, { status: 429 })
        : new Response(`data: ${JSON.stringify({ error })}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          });
    },
  });
  const { models } = adapted([
    openai({
      key: 'sk-host',
      address: upstream.url.origin,
      api: 'chat-completions',
    }),
  ]);

  for (const _ of ['a body', 'a stream']) {
    const events = await Array.fromAsync(
      models(
        'openai/gpt-4o',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: {
        code: 'rate_limited',
        message:
          'Rate limit reached for gpt-4o on requests per min (RPM): Limit 500, Used 500, Requested 1.',
        provider: { 'openai.chat': { message: error.message } },
      },
    });
  }
});

test('the caller and the motty are told the failure without the account`s name, and the host`s record holds what the upstream said', async () => {
  const said =
    'Rate limit reached for gpt-4o in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 on requests per min (RPM): Limit 500, Used 500, Requested 1.';
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { error: { message: said, code: 'rate_limit_exceeded' } },
        { status: 429 },
      ),
  });
  const caught: string[] = [];
  const reports: Report[] = [];
  const served = mount(
    motty({ name: 'relay' })
      .onError((thrown) => {
        if (thrown instanceof Error) caught.push(thrown.message);
      })
      .handle(({ prompt }) => model('openai/gpt-4o').complete(prompt)),
    () => ({
      models: [openai({ key: 'sk-host', address: upstream.url.origin })],
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(
    new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'relay',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
  );

  const told =
    'Rate limit reached for gpt-4o on requests per min (RPM): Limit 500, Used 500, Requested 1.';
  expect(await reply.json()).toMatchObject({ error: { message: told } });
  expect(caught).toEqual([told]);
  expect(JSON.stringify(reports)).toContain(said);
});

test.each(['responses', 'chat-completions'] as const)(
  'a list of what an upstream`s validator refused is told over %s as where and what, with the account and the key cut from it',
  async (api) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            detail: [
              {
                type: 'value_error',
                loc: ['body', 'model'],
                msg: 'Not served in organization org-Bc1Nh6Wd3Kp8Rt4Xv9Lm2Zq7 under sk-host-Zq7Lm2Xv9Rt4Kp8',
              },
              {
                type: 'extra_forbidden',
                loc: ['body', 'top_k'],
                msg: 'Extra inputs are not permitted',
              },
            ],
          },
          { status: 422 },
        ),
    });
    const { models } = adapted([
      openai({
        key: 'sk-host-Zq7Lm2Xv9Rt4Kp8',
        address: upstream.url.origin,
        api,
      }),
    ]);

    const events = await Array.fromAsync(
      models(
        'openai/gpt-4o',
        { messages: [{ role: 'user', text: 'hi' }] },
        AbortSignal.timeout(5000),
      ),
    );

    expect(events).toMatchObject([
      {
        type: 'error',
        error: {
          code: 'invalid_request',
          status: 422,
          message:
            'body.model: Not served under [key]; body.top_k: Extra inputs are not permitted',
        },
      },
    ]);
  },
);

test('a fallback that moved on from an API with no field for an option keeps the refused call, by its code, beside the one that answered', async () => {
  const paths: string[] = [];
  const reports: Report[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      paths.push(new URL(request.url).pathname);
      return new Response(answered, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  const { answer, calls } = await run(
    motty({ name: 'relay' }).handle(({ prompt }) =>
      fallback(model('openai-chat/gpt-5'), model('openai/gpt-5')).complete(
        prompt,
      ),
    ),
    {
      text: 'hi',
      options: { provider: { openai: { previous_response_id: 'resp_0' } } },
    },
    {
      models: [
        openai({ key: 'sk-host', address: `${upstream.url}v1` }),
        openai({
          key: 'sk-host',
          address: `${upstream.url}v1`,
          api: 'chat-completions',
          prefix: 'openai-chat',
        }),
      ],
      report: (report) => reports.push(report),
    },
  );

  expect(await answer.text()).toBe('Hello there');
  expect(paths).toEqual(['/v1/responses']);
  expect(calls).toMatchObject([
    {
      model: 'openai-chat/gpt-5',
      code: 'unsupported',
      message: expect.stringContaining('previous_response_id'),
    },
    { model: 'openai/gpt-5', input: 9, output: 2 },
  ]);
  expect(calls[1]).not.toHaveProperty('code');
  expect(calls[1]).not.toHaveProperty('message');
  expect(reports.map(({ outcome }) => outcome)).toEqual(['completed']);
  expect(reports[0]?.calls).toEqual(calls);
});
