import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import type { ModelAdapter, ModelCall, Report } from '@mottyjs/core/host';
import { chatCompletions, messages, mount, responses } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { chat } from '../src/chat.ts';
import { openai } from '../src/openai.ts';
import { passed } from '../src/passed.ts';

// One call to an upstream that records the headers it was sent.
async function sent(
  made: (address: string) => ModelAdapter,
  model: string,
  prompt: Parameters<ModelCall>[1],
) {
  const seen: Headers[] = [];
  using upstream = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen.push(request.headers);
      return new Response('', {
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
  return { headers: seen[0] ?? new Headers(), asked: seen.length, events };
}

test.each([
  ['openai', openai],
  ['anthropic', anthropic],
])(
  'a header stated on a call reaches the %s upstream',
  async (name, adapter) => {
    const { headers } = await sent(
      (address) => adapter({ key: 'sk-host', address }),
      `${name}/small`,
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: { headers: { 'X-Session': 's-1', 'user-agent': 'coder/1.0' } },
      },
    );

    expect(headers.get('x-session')).toBe('s-1');
    expect(headers.get('user-agent')).toBe('coder/1.0');
  },
);

test('with no header stated on a call the request carries what it did before', async () => {
  const { headers } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        headers: { 'x-title': 'Coder' },
      }),
    'anthropic/small',
    { messages: [{ role: 'user', text: 'hi' }], options: { maxTokens: 16 } },
  );

  expect([...headers.keys()].sort()).toEqual([
    'accept',
    'accept-encoding',
    'anthropic-version',
    'connection',
    'content-length',
    'content-type',
    'host',
    'user-agent',
    'x-api-key',
    'x-title',
  ]);
});

test('a header stated on a call never replaces the connection`s of that name, in any letter case', async () => {
  const { headers } = await sent(
    (address) =>
      openai({ key: 'sk-host', address, headers: { 'X-Title': 'Coder' } }),
    'openai/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { 'x-title': 'Relay', 'X-TITLE': 'Other' } },
    },
  );

  expect(headers.get('x-title')).toBe('Coder');
});

test('a header stated on a call cannot send the host`s key where a gateway is told to by the connection', async () => {
  const { headers } = await sent(
    (address) =>
      openai({
        key: 'sk-host',
        address,
        headers: {
          'Helicone-Auth': 'Bearer host-gateway-key',
          'Helicone-Target-Url': 'https://api.openai.com',
          'OpenAI-Organization': 'org-host',
        },
      }),
    'openai/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: {
        headers: {
          'helicone-auth': 'Bearer other-gateway-key',
          'helicone-target-url': 'https://evil.example',
          'openai-organization': 'org-other',
        },
      },
    },
  );

  expect(headers.get('authorization')).toBe('Bearer sk-host');
  expect(headers.get('helicone-auth')).toBe('Bearer host-gateway-key');
  expect(headers.get('helicone-target-url')).toBe('https://api.openai.com');
  expect(headers.get('openai-organization')).toBe('org-host');
});

test('of two headers stated on a call under one name in two letter cases the later is sent', async () => {
  const { headers } = await sent(
    (address) => openai({ key: 'sk-host', address }),
    'openai/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { 'X-Title': 'a', 'x-title': 'b' } },
    },
  );

  expect(headers.get('x-title')).toBe('b');
});

test('a header stated on a call cannot replace a bearer credential', async () => {
  const { headers } = await sent(
    (address) => openai({ key: 'sk-host', address }),
    'openai/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { Authorization: 'Bearer sk-other' } },
    },
  );

  expect(headers.get('authorization')).toBe('Bearer sk-host');
});

test('a header stated on a call cannot replace a credential the API names a header for', async () => {
  const { headers } = await sent(
    (address) => anthropic({ key: 'sk-ant-host', address }),
    'anthropic/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { 'X-Api-Key': 'sk-other' } },
    },
  );

  expect(headers.get('x-api-key')).toBe('sk-ant-host');
});

test('a header stated on a call cannot replace a credential under a header only the adapter names', async () => {
  const { headers } = await sent(
    (address) =>
      chat({
        codec: chatCompletions,
        prefix: 'acme',
        address,
        key: 'sk-host',
        keyHeader: 'X-Acme-Key',
      }),
    'acme/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { 'x-acme-key': 'sk-other' } },
    },
  );

  expect(headers.get('x-acme-key')).toBe('sk-host');
});

test.each([
  ['openai', openai, 'x-api-key'],
  ['openai', openai, 'api-key'],
  ['anthropic', anthropic, 'authorization'],
  ['anthropic', anthropic, 'api-key'],
])(
  'a header stated on a call to %s cannot add a second credential as %s',
  async (name, adapter, credential) => {
    const { headers } = await sent(
      (address) => adapter({ key: 'sk-host', address }),
      `${name}/small`,
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: { headers: { [credential]: 'sk-other' } },
      },
    );

    expect(headers.get(credential)).toBeNull();
  },
);

test('a header stated on a call cannot replace a credential the connection states for a gateway', async () => {
  const { headers } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        headers: { 'X-Gateway-Token': 'gateway' },
      }),
    'anthropic/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { 'x-gateway-token': 'sk-other' } },
    },
  );

  expect(headers.get('x-gateway-token')).toBe('gateway');
});

test('a header stated on a call cannot replace what the API needs', async () => {
  const { headers } = await sent(
    (address) => anthropic({ key: 'sk-ant-host', address }),
    'anthropic/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: {
        headers: {
          'Content-Type': 'text/plain',
          Accept: 'text/html',
          'Anthropic-Version': '2099-01-01',
        },
      },
    },
  );

  expect(headers.get('content-type')).toBe('application/json');
  expect(headers.get('accept')).toBe('text/event-stream');
  expect(headers.get('anthropic-version')).toBe('2023-06-01');
});

// A runtime writes some of these itself whatever it is given, so what is
// left of the call's is read before a request is made of it.
test.each([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'expect',
  'accept-encoding',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'forwarded',
  'via',
  'origin',
  'referer',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'fly-client-ip',
  'fastly-client-ip',
  'cdn-loop',
  'x-original-forwarded-for',
  'x-envoy-external-address',
  'x-forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-client-cert',
  'x-forwarded-',
  'x_forwarded_for',
  'cf-connecting-ip',
  'cf-ray',
  'cf-ipcountry',
  'cf-visitor',
  'cf-worker',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-ch-ua',
  'content-type',
  'content-length',
  'content-encoding',
  'content-md5',
  'content-digest',
  'content-language',
  'digest',
  'HOST',
  'Content-Length',
  'Authorization',
  'X-Forwarded-For',
  'CF-Connecting-IP',
  'VIA',
  // Read from each wire API's own list, so a credential header named on
  // one later is a row here with no line written.
  ...new Set(
    [chatCompletions, responses, messages].flatMap(
      ({ credentials }) => credentials,
    ),
  ),
])('%s stated on a call is left out of what is sent', (name) => {
  expect([
    ...passed('acme', new Headers(), undefined, {
      [name]: 'stated-on-the-call',
      'x-kept': 'yes',
    }),
  ]).toEqual([['x-kept', 'yes']]);
});

test.each([
  'cookie',
  'authorization',
  'x-forwarded-for',
  'cf-connecting-ip',
  'origin',
  'content-encoding',
])('%s stated on a call does not reach the upstream', async (name) => {
  const { headers, events } = await sent(
    (address) =>
      chat({ codec: chatCompletions, prefix: 'acme', address, key: undefined }),
    'acme/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { [name]: 'stated-on-the-call', 'x-kept': 'yes' } },
    },
  );

  expect(headers.get(name)).toBeNull();
  expect(headers.get('x-kept')).toBe('yes');
  expect(JSON.stringify(events)).not.toContain('no request can carry');
});

test.each([
  ['a name', { 'x note': 'Zq7Lm2Xv9Rt4Kp8Wd3Nh' }, 'x note'],
  ['a value', { 'x-note': 'Zq7Lm2Xv\n9Rt4Kp8Wd3Nh' }, 'x-note'],
])(
  'a header stated on a call with %s no request can carry fails the call before anything is sent, in words that hold no value',
  async (_, stated, name) => {
    const { asked, events } = await sent(
      (address) => openai({ key: 'sk-host', address }),
      'openai/small',
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: { headers: stated },
      },
    );

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'invalid_request',
          status: 400,
          message: `The openai adapter was given a header no request can carry: ${name}`,
          upstream: false,
        },
      },
    ]);
    expect(asked).toBe(0);
  },
);

test('a header no request can carry is dropped unread when it is one never sent', async () => {
  const { headers, events } = await sent(
    (address) => openai({ key: 'sk-host', address }),
    'openai/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { cookie: 'session=a\nb', 'x-kept': 'yes' } },
    },
  );

  expect(headers.get('x-kept')).toBe('yes');
  expect(JSON.stringify(events)).not.toContain('no request can carry');
});

test.each([
  ['openai', openai, '/v1/chat/completions', 'authorization', 'Bearer sk-host'],
  ['anthropic', anthropic, '/v1/messages', 'x-api-key', 'sk-host'],
])(
  'every header of a caller forwarded by a motty reaches the %s upstream, but for the ones never sent',
  async (name, adapter, path, credential, key) => {
    const seen: Headers[] = [];
    using upstream = Bun.serve({
      port: 0,
      fetch: (request) => {
        seen.push(request.headers);
        return new Response('', {
          headers: { 'content-type': 'text/event-stream' },
        });
      },
    });
    const { fetch, close } = mount(
      motty({ name: 'relay' }).handle(({ request, prompt }) => {
        prompt.options = {
          ...prompt.options,
          headers: Object.fromEntries(request.headers),
        };
        return model(`${name}/small`).complete(prompt);
      }),
      () => ({
        models: [adapter({ key: 'sk-host', address: upstream.url.origin })],
      }),
    );

    const reply = await fetch(
      new Request(`http://host${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          host: 'relay.example',
          'content-length': '3',
          'accept-encoding': 'br',
          connection: 'close',
          cookie: 'session=caller',
          authorization: 'Bearer caller-token',
          'x-api-key': 'caller-key',
          'x-forwarded-for': '203.0.113.7',
          'x-real-ip': '203.0.113.7',
          forwarded: 'for=203.0.113.7',
          via: '1.1 edge',
          'user-agent': 'coder/1.0',
          'x-session': 's-1',
          'x-stainless-lang': 'js',
        },
        body: JSON.stringify({
          model: 'relay',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    await reply.text();
    await close();

    const [headers = new Headers()] = seen;
    expect(headers.get('user-agent')).toBe('coder/1.0');
    expect(headers.get('x-session')).toBe('s-1');
    expect(headers.get('x-stainless-lang')).toBe('js');
    expect(headers.get(credential)).toBe(key);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('host')).toBe(upstream.url.host);
    expect(headers.get('content-length')).not.toBe('3');
    expect(headers.get('accept-encoding')).not.toBe('br');
    expect(headers.get('connection')).not.toBe('close');
    expect(
      [
        'cookie',
        credential === 'authorization' ? 'x-api-key' : 'authorization',
        'x-forwarded-for',
        'x-real-ip',
        'forwarded',
        'via',
      ].map((dropped) => headers.get(dropped)),
    ).toEqual([null, null, null, null, null, null]);
  },
);

test.each([
  ['openai', openai, '/v1/chat/completions'],
  ['anthropic', anthropic, '/v1/messages'],
])(
  'what the %s upstream says of a header stated on a call is told whole, and a credential of the connection is still cut from it',
  async (name, adapter, path) => {
    using upstream = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message:
                'Unexpected value(s) `context-management-2025-06-27` for the `anthropic-beta` header. Content-Type must be application/json. Seen from claude-cli/2.1.0 (external, cli) with CANARY-gateway-token-9f2c',
            },
          },
          { status: 400 },
        ),
    });
    const reports: Report[] = [];
    const { fetch, close } = mount(
      motty({ name: 'relay' }).handle(({ prompt }) => {
        prompt.options = {
          ...prompt.options,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'anthropic-beta':
              'context-management-2025-06-27,interleaved-thinking-2025-05-14',
            'user-agent': 'claude-cli/2.1.0 (external, cli)',
          },
        };
        return model(`${name}/small`).complete(prompt);
      }),
      () => ({
        models: [
          adapter({
            key: 'sk-host',
            address: upstream.url.origin,
            headers: { 'x-gateway-token': 'Bearer CANARY-gateway-token-9f2c' },
          }),
        ],
        report: (report) => reports.push(report),
      }),
    );

    const told = await Promise.all(
      [false, true].map(async (stream) => {
        const reply = await fetch(
          new Request(`http://host${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'relay',
              max_tokens: 16,
              messages: [{ role: 'user', content: 'hi' }],
              stream,
            }),
          }),
        );
        return reply.text();
      }),
    );
    await close();

    for (const text of [...told, JSON.stringify(reports)]) {
      expect(text).toContain(
        'Unexpected value(s) `context-management-2025-06-27` for the `anthropic-beta` header. Content-Type must be application/json. Seen from claude-cli/2.1.0 (external, cli) with [key]',
      );
      expect(text).not.toContain('CANARY');
    }
  },
);
