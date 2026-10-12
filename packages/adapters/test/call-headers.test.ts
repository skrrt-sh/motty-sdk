import { expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import {
  credentials,
  forwarded,
  type ModelAdapter,
  type ModelCall,
  type Report,
} from '@mottyjs/core/host';
import { chatCompletions, messages, mount, responses } from '@mottyjs/serve';
import { anthropic } from '../src/anthropic.ts';
import { chat } from '../src/chat.ts';
import { openai } from '../src/openai.ts';

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
      return new Response(
        'data: {"id":"c1","object":"chat.completion.chunk","model":"small","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
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
  [
    'is left out when the connection allows none',
    { 'x-session': 's-1' },
    undefined,
    {},
    { 'x-session': 'The connection does not forward this header' },
  ],
  [
    'is left out when the connection lists other names',
    { 'x-session': 's-1', 'x-title': 'Coder' },
    ['x-title'],
    { 'x-title': 'Coder' },
    { 'x-session': 'The connection does not forward this header' },
  ],
  [
    'is sent when the connection lists its name in another letter case',
    { 'X-Session': 's-1', 'x-title': 'Coder' },
    ['x-session', 'X-TITLE'],
    { 'X-Session': 's-1', 'x-title': 'Coder' },
    {},
  ],
  [
    'is not sent for a name that only begins as a listed one does',
    { 'x-session-id': 's-1' },
    ['x-session'],
    {},
    { 'x-session-id': 'The connection does not forward this header' },
  ],
  [
    'is sent when the connection forwards any',
    { 'x-session': 's-1', 'user-agent': 'coder/1.0' },
    true,
    { 'x-session': 's-1', 'user-agent': 'coder/1.0' },
    {},
  ],
  [
    'is left out when its Connection header names it',
    { Connection: 'close, X-Hop', 'x-hop': '1', 'x-kept': 'yes' },
    true,
    { 'x-kept': 'yes' },
    {
      connection: 'A call never sends this header',
      'x-hop': 'A call never sends this header',
    },
  ],
  [
    'is sent when it says where a request came from and the connection lists it',
    { 'X-Forwarded-For': '203.0.113.7', via: '1.1 edge', 'cf-ray': 'r-1' },
    ['x-forwarded-for', 'Via', 'cf-ray'],
    { 'X-Forwarded-For': '203.0.113.7', via: '1.1 edge', 'cf-ray': 'r-1' },
    {},
  ],
  [
    'is left out when it says where a request came from and the connection lists other names',
    { 'x-forwarded-for': '203.0.113.7', via: '1.1 edge' },
    ['x-session'],
    {},
    {
      'x-forwarded-for': 'The connection does not forward this header',
      via: 'The connection does not forward this header',
    },
  ],
  [
    'is left out when it says where a request came from and the connection forwards any',
    { 'x-forwarded-for': '203.0.113.7', via: '1.1 edge', 'x-kept': 'yes' },
    true,
    { 'x-kept': 'yes' },
    {
      'x-forwarded-for': 'A call never sends this header',
      via: 'A call never sends this header',
    },
  ],
  [
    'is left out when the connection lists it and it is the connection`s own, a credential, a cookie or said of a body',
    {
      Host: 'a.example',
      Authorization: 'Bearer t',
      cookie: 'a=b',
      'Content-Type': 'x/y',
    },
    ['host', 'authorization', 'cookie', 'content-type'],
    {},
    {
      host: 'A call never sends this header',
      authorization: 'A call never sends this header',
      cookie: 'A call never sends this header',
      'content-type': 'A call never sends this header',
    },
  ],
  [
    'is left out when its Connection header names it and the connection lists it',
    {
      Connection: 'x-forwarded-for, x-hop',
      'x-forwarded-for': '203.0.113.7',
      'x-hop': '1',
    },
    ['connection', 'x-forwarded-for', 'x-hop'],
    {},
    {
      connection: 'A call never sends this header',
      'x-forwarded-for': 'A call never sends this header',
      'x-hop': 'A call never sends this header',
    },
  ],
  [
    'is skipped unsaid when it has no value',
    { 'x-session': null, 'x-title': undefined, 'x-kept': 'yes' },
    true,
    { 'x-kept': 'yes' },
    {},
  ],
  [
    'is told of once when it is stated in two letter cases',
    { 'X-Session': 's-1', 'x-session': 's-2' },
    [],
    {},
    { 'x-session': 'The connection does not forward this header' },
  ],
] as const)(
  'a header stated on a call %s',
  (_, stated, allowed, headers, left) => {
    expect(forwarded(stated, allowed)).toEqual({
      headers,
      leftOut: Object.entries(left).map(([name, detail]) => ({
        setting: `headers.${name}`,
        detail,
      })),
    });
  },
);

test('a header the request already has is left out of what a call states, in any letter case', () => {
  expect(
    forwarded({ 'X-Title': 'Relay', 'x-kept': 'yes' }, true, ['x-title']),
  ).toEqual({
    headers: { 'x-kept': 'yes' },
    leftOut: [
      {
        setting: 'headers.x-title',
        detail: 'The connection or the API states this header itself',
      },
    ],
  });
});

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
  ...credentials,
])(
  '%s stated on a call is never sent, whether the connection lists it or forwards any',
  (name) => {
    for (const allowed of [true, [name, 'x-kept']] as const) {
      expect(
        forwarded({ [name]: 'stated-on-the-call', 'x-kept': 'yes' }, allowed),
      ).toEqual({
        headers: { 'x-kept': 'yes' },
        leftOut: [
          {
            setting: `headers.${name.toLowerCase()}`,
            detail: 'A call never sends this header',
          },
        ],
      });
    }
  },
);

test.each([
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
  'X-Forwarded-For',
  'CF-Connecting-IP',
  'VIA',
])(
  '%s stated on a call is sent when the connection lists it, and never when the connection forwards any',
  (name) => {
    expect(forwarded({ [name]: 'stated-on-the-call' }, [name])).toEqual({
      headers: { [name]: 'stated-on-the-call' },
      leftOut: [],
    });
    expect(forwarded({ [name]: 'stated-on-the-call' }, true)).toEqual({
      headers: {},
      leftOut: [
        {
          setting: `headers.${name.toLowerCase()}`,
          detail: 'A call never sends this header',
        },
      ],
    });
  },
);

test('every header a wire API takes a credential in is one never sent', () => {
  expect(
    [chatCompletions, responses, messages]
      .flatMap((codec) => codec.credentials)
      .filter((name) => !credentials.includes(name)),
  ).toEqual([]);
});

test.each([
  ['openai', openai],
  ['anthropic', anthropic],
])(
  'by default no header stated on a call reaches the %s upstream',
  async (name, adapter) => {
    const { headers } = await sent(
      (address) => adapter({ key: 'sk-host', address }),
      `${name}/small`,
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: {
          headers: {
            'x-session': 's-1',
            'helicone-target-url': 'https://evil.example',
            'openai-organization': 'org-other',
          },
        },
      },
    );

    expect(
      ['x-session', 'helicone-target-url', 'openai-organization'].map(
        (stated) => headers.get(stated),
      ),
    ).toEqual([null, null, null]);
  },
);

test.each([
  ['openai', openai, ['X-Session', 'user-agent']],
  ['anthropic', anthropic, ['X-Session', 'user-agent']],
  ['openai', openai, true],
  ['anthropic', anthropic, true],
] as const)(
  'a header stated on a call reaches the %s upstream when the connection forwards %p',
  async (name, adapter, forwardHeaders) => {
    const { headers } = await sent(
      (address) => adapter({ key: 'sk-host', address, forwardHeaders }),
      `${name}/small`,
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: {
          headers: { 'x-session': 's-1', 'User-Agent': 'coder/1.0' },
        },
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
        forwardHeaders: true,
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

test('a header the connection states wins over a call`s of that name, a gateway`s target and account among them', async () => {
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
        forwardHeaders: true,
      }),
    'openai/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: {
        headers: {
          'helicone-auth': 'Bearer other-gateway-key',
          'HELICONE-TARGET-URL': 'https://evil.example',
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

test('a header the API writes wins over a call`s of that name, even when the connection lists it', async () => {
  const { headers } = await sent(
    (address) =>
      anthropic({
        key: 'sk-ant-host',
        address,
        forwardHeaders: ['accept', 'anthropic-version', 'content-type'],
      }),
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

test.each([
  ['openai', openai, 'authorization', 'Bearer sk-host'],
  ['openai', openai, 'x-api-key', null],
  ['openai', openai, 'api-key', null],
  ['anthropic', anthropic, 'x-api-key', 'sk-host'],
  ['anthropic', anthropic, 'authorization', null],
  ['anthropic', anthropic, 'api-key', null],
] as const)(
  'a call to %s that states %s neither replaces the credential nor adds a second',
  async (name, adapter, credential, kept) => {
    const { headers } = await sent(
      (address) =>
        adapter({ key: 'sk-host', address, forwardHeaders: [credential] }),
      `${name}/small`,
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: { headers: { [credential]: 'sk-other' } },
      },
    );

    expect(headers.get(credential)).toBe(kept);
  },
);

test.each([
  ['sk-host', 'sk-host'],
  [undefined, null],
])(
  'a call cannot state the header a connection with the key %p names for its key',
  async (key, kept) => {
    const { headers } = await sent(
      (address) =>
        chat({
          codec: chatCompletions,
          prefix: 'acme',
          address,
          key,
          keyHeader: 'X-Acme-Key',
          forwardHeaders: ['x-acme-key'],
        }),
      'acme/small',
      {
        messages: [{ role: 'user', text: 'hi' }],
        options: { headers: { 'x-acme-key': 'sk-other' } },
      },
    );

    expect(headers.get('x-acme-key')).toBe(kept);
  },
);

test('the headers of a call that were not sent are named in a warning each, with no value', async () => {
  const { headers, events } = await sent(
    (address) =>
      chat({
        codec: chatCompletions,
        prefix: 'acme',
        address,
        key: 'sk-host',
        headers: { 'x-title': 'Coder' },
        forwardHeaders: ['x-session', 'x-title', 'cookie', 'accept'],
      }),
    'acme/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: {
        headers: {
          'x-session': 's-1',
          'X-Trace': 'Zq7Lm2Xv9Rt4Kp8Wd3Nh',
          'x-title': 'Zq7Lm2Xv9Rt4Kp8Wd3Nh',
          Cookie: 'session=Zq7Lm2Xv9Rt4Kp8Wd3Nh',
          accept: 'Zq7Lm2Xv9Rt4Kp8Wd3Nh',
        },
      },
    },
  );

  expect(headers.get('x-session')).toBe('s-1');
  expect(events.at(-1)).toMatchObject({
    type: 'finish',
    warnings: [
      {
        setting: 'headers.x-trace',
        detail: 'The connection does not forward this header',
      },
      {
        setting: 'headers.x-title',
        detail: 'The connection or the API states this header itself',
      },
      {
        setting: 'headers.cookie',
        detail: 'A call never sends this header',
      },
      {
        setting: 'headers.accept',
        detail: 'The connection or the API states this header itself',
      },
    ],
  });
  expect(JSON.stringify(events)).not.toContain('Zq7Lm2Xv9Rt4Kp8Wd3Nh');
});

test('a call whose headers were all sent ends with no warning', async () => {
  const { events } = await sent(
    (address) =>
      chat({
        codec: chatCompletions,
        prefix: 'acme',
        address,
        key: 'sk-host',
        forwardHeaders: ['x-session'],
      }),
    'acme/small',
    {
      messages: [{ role: 'user', text: 'hi' }],
      options: { headers: { 'x-session': 's-1' } },
    },
  );

  expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'stop' });
  expect(events.at(-1)).not.toHaveProperty('warnings');
});

test.each([
  ['a name', { 'x note': 'Zq7Lm2Xv9Rt4Kp8Wd3Nh' }, '"x note" with a name'],
  ['an empty name', { '': 'Zq7Lm2Xv9Rt4Kp8Wd3Nh' }, '"" with a name'],
  [
    'a line break in its value',
    { 'x-note': 'Zq7Lm2Xv\n9Rt4Kp8Wd3Nh' },
    '"x-note" with a value',
  ],
  [
    'a value outside Latin-1',
    { 'x-note': 'Zq7Lm2Xv9Rt4Kp8Wd3Nh世' },
    '"x-note" with a value',
  ],
  [
    'a value no request can carry under a name never sent',
    { cookie: 'Zq7Lm2Xv\n9Rt4Kp8Wd3Nh' },
    '"cookie" with a value',
  ],
])(
  'a header stated on a call with %s fails the call as a mistake of the motty`s, before anything is sent and in words that hold no value',
  async (_, stated, said) => {
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
          code: 'internal',
          status: 500,
          message: `A call stated the header ${said} no request can carry`,
          retryable: false,
          unexpected: true,
          stack: expect.any(String),
          upstream: false,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('9Rt4Kp8Wd3Nh');
    expect(asked).toBe(0);
  },
);

test.each([
  ['openai', openai, '/v1/chat/completions', 'authorization', 'Bearer sk-host'],
  ['anthropic', anthropic, '/v1/messages', 'x-api-key', 'sk-host'],
])(
  'the headers of a caller a motty names reach the %s upstream where the connection lists them, and no other',
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
          headers: {
            'user-agent': request.headers.get('user-agent'),
            'x-session': request.headers.get('x-session'),
            'x-absent': request.headers.get('x-absent'),
            'x-trace': request.headers.get('x-trace'),
            cookie: request.headers.get('cookie'),
          },
        };
        return model(`${name}/small`).complete(prompt);
      }),
      () => ({
        models: [
          adapter({
            key: 'sk-host',
            address: upstream.url.origin,
            forwardHeaders: ['user-agent', 'x-session', 'x-absent', 'cookie'],
          }),
        ],
      }),
    );

    const reply = await fetch(
      new Request(`http://host${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          cookie: 'session=caller',
          authorization: 'Bearer caller-token',
          'x-api-key': 'caller-key',
          'user-agent': 'coder/1.0',
          'x-session': 's-1',
          'x-trace': 't-1',
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
    expect(headers.get(credential)).toBe(key);
    expect(headers.get('content-type')).toBe('application/json');
    expect(
      [
        'x-absent',
        'x-trace',
        'cookie',
        credential === 'authorization' ? 'x-api-key' : 'authorization',
      ].map((dropped) => headers.get(dropped)),
    ).toEqual([null, null, null, null]);
  },
);

test('a header of the Anthropic API`s own that a caller sent travels with no connection listing it, and wins over a call`s', async () => {
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
    motty({ name: 'relay' }).handle(({ prompt }) => {
      prompt.options = {
        ...prompt.options,
        headers: { 'anthropic-beta': 'stated-on-the-call' },
      };
      return model('anthropic/small').complete(prompt);
    }),
    () => ({
      models: [
        anthropic({
          key: 'sk-host',
          address: upstream.url.origin,
          forwardHeaders: true,
        }),
      ],
    }),
  );

  const reply = await fetch(
    new Request('http://host/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14',
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

  expect(seen[0]?.get('anthropic-beta')).toBe(
    'interleaved-thinking-2025-05-14',
  );
});

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
            forwardHeaders: ['anthropic-beta', 'user-agent'],
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
