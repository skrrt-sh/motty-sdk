import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import { adapted } from '@mottyjs/core/host';
import { run } from '@mottyjs/test';
import * as entry from '../src/anthropic.ts';
import { anthropic } from '../src/anthropic.ts';

const answered = `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}

event: message_stop
data: {"type":"message_stop"}

`;

test('it serves the names under its prefix and no other', () => {
  const adapter = anthropic({ key: 'sk-ant-host' });
  const proxied = anthropic({ key: 'sk-ant-host', prefix: 'bedrock' });

  expect(adapter.serves('anthropic/claude-opus')).toBe(true);
  expect(adapter.serves('anthropic')).toBe(false);
  expect(adapter.serves('anthropics/claude-opus')).toBe(false);
  expect(adapter.serves('openai/gpt-5')).toBe(false);
  expect(proxied.serves('bedrock/claude-opus')).toBe(true);
  expect(proxied.serves('anthropic/claude-opus')).toBe(false);
  expect(adapter.decide).toBeUndefined();
});

test('with no key it fails when made', () => {
  expect(() => anthropic({ key: undefined })).toThrow(
    'The anthropic adapter was given no key',
  );
  expect(() => anthropic({ key: '' })).toThrow();
  expect(() => anthropic({ key: ' \t' })).toThrow(
    'The anthropic adapter was given no key',
  );
});

test('a call goes to the Messages API with the key and the provider name', async () => {
  const seen: {
    path: string;
    key: string | null;
    bearer: string | null;
    version: string | null;
    body: unknown;
  }[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push({
        path: new URL(request.url).pathname,
        key: request.headers.get('x-api-key'),
        bearer: request.headers.get('authorization'),
        version: request.headers.get('anthropic-version'),
        body: await request.json(),
      });
      return new Response(answered, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const { models } = adapted([
    anthropic({ key: 'sk-ant-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
      { messages: [{ role: 'user', text: 'hi' }], options: { maxTokens: 64 } },
      AbortSignal.timeout(5000),
    ),
  );

  expect(seen).toMatchObject([
    {
      path: '/messages',
      key: 'sk-ant-host',
      bearer: null,
      version: '2023-06-01',
      body: { model: 'claude-opus-4', stream: true },
    },
  ]);
  expect(events).toMatchObject([
    { type: 'text', text: 'Hello' },
    { type: 'text', text: ' there' },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 9, output: 2 },
      id: 'msg_1',
      model: 'claude-opus-4',
    },
  ]);
});

test.each([
  [400, 'invalid_request_error', 'invalid_request'],
  [401, 'authentication_error', 'upstream_refused'],
  [402, 'billing_error', 'quota_exceeded'],
  [403, 'permission_error', 'upstream_refused'],
  [404, 'not_found_error', 'upstream_failed'],
  [413, 'request_too_large', 'invalid_request'],
  [429, 'rate_limit_error', 'rate_limited'],
  [500, 'api_error', 'upstream_failed'],
  [529, 'overloaded_error', 'overloaded'],
])('an upstream %i %s is one %s error', async (status, type, expected) => {
  using upstream = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { type: 'error', error: { type, message: 'The upstream said why' } },
        { status, headers: { 'retry-after': '3' } },
      ),
  });
  const { models } = adapted([
    anthropic({ key: 'sk-ant-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
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
        retryAfterMs: 3000,
        upstream: true,
      },
    },
  ]);
});

test('a connection cut mid-stream ends in one retryable error', async () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        async function* () {
          yield answered.slice(
            0,
            answered.indexOf('event: content_block_stop'),
          );
          await Bun.sleep(20);
          await upstream.stop(true);
        },
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    anthropic({ key: 'sk-ant-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
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
    anthropic({ key: 'sk-ant-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
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
    model('anthropic/claude-opus-4').complete({ messages: request.messages }),
  );

  const { answer, calls } = await run(
    relay,
    {
      text: 'hi',
      headers: { 'x-api-key': 'sk-ant-caller', 'x-caller': 'secret' },
    },
    {
      models: [anthropic({ key: 'sk-ant-host', address: upstream.url.origin })],
    },
  );

  expect(await answer.text()).toBe('Hello there');
  expect(calls).toMatchObject([
    { model: 'anthropic/claude-opus-4', input: 9, output: 2 },
  ]);
  expect(seen.map((headers) => headers.get('x-api-key'))).toEqual([
    'sk-ant-host',
  ]);
  expect(seen.map((headers) => headers.has('x-caller'))).toEqual([false]);
});

test('what an upstream echoes of the key it refused, whole or masked, is cut from the record', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) =>
      Response.json(
        {
          type: 'error',
          error: {
            type: 'authentication_error',
            message: 'invalid x-api-key: sk-ant-***...***6Bc1',
            sent: request.headers.get('x-api-key'),
          },
        },
        { status: 401 },
      ),
  });
  const { models } = adapted([
    anthropic({
      key: 'sk-ant-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1',
      address: upstream.url.origin,
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
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
          anthropic: {
            message: 'invalid x-api-key: [key]***...***[key]',
            sent: '[key]',
          },
        },
      },
    },
  ]);
});

test('a key or a connection header echoed by a failure inside a stream is cut', async () => {
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) =>
      new Response(
        `event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: `Overloaded for ${request.headers.get('x-api-key')} behind ${request.headers.get('cf-aig-authorization')}`,
          },
        })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  const { models } = adapted([
    anthropic({
      key: ' sk-ant-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1\n',
      address: upstream.url.origin,
      headers: { 'cf-aig-authorization': 'Bearer Xv9Rt4Kp8Wd3Nh6Bc1Zq7' },
    }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'overloaded',
        message: 'Overloaded for [key] behind [key]',
      },
    },
  ]);
});

test.each([
  ['a line break', 'sk-ant-Zq7Lm2Xv\n9Rt4Kp8Wd3Nh6Bc1'],
  ['a character no header holds', 'sk-ant-Zq7Lm2Xv9Rt4Kp8Wd3Nh6Bc1☃'],
])(
  'a key with %s fails when the adapter is made, in words that hold none of it',
  (_, key) => {
    expect(() => anthropic({ key })).toThrow(
      'The anthropic adapter was given a key no header can carry',
    );
    expect(() => anthropic({ key })).not.toThrow(/Zq7L|6Bc1/);
  },
);

test('a redirect to another origin is not followed, and the other address is asked nothing', async () => {
  let asked = 0;
  using other = Bun.serve({
    port: 0,
    fetch: () => {
      asked += 1;
      return new Response('');
    },
  });
  using upstream = Bun.serve({
    port: 0,
    fetch: () => Response.redirect(`${other.url}v1/messages`, 307),
  });
  const { models } = adapted([
    anthropic({ key: 'sk-ant-host', address: upstream.url.origin }),
  ]);

  const events = await Array.fromAsync(
    models(
      'anthropic/claude-opus-4',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.timeout(5000),
    ),
  );

  expect(events).toMatchObject([
    {
      type: 'error',
      error: {
        code: 'upstream_failed',
        message: 'The upstream answered 307, a redirect, which is not followed',
        retryable: false,
      },
    },
  ]);
  expect(asked).toBe(0);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/anthropic.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['anthropic']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
