import { afterAll, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { answer, model, motty, UnknownModel } from '@mottyjs/core';
import { type HostOptions, hosted, type Report } from '@mottyjs/core/host';
import { chatCompletions, messages, mount, responses } from '@mottyjs/serve';
import { memory } from '@mottyjs/test';
import { SignJWT } from 'jose';
import manifest from '../package.json';
import { anthropic } from '../src/anthropic.ts';
import { dashscope } from '../src/dashscope.ts';
import { deepseek } from '../src/deepseek.ts';
import { fireworks } from '../src/fireworks.ts';
import { groq } from '../src/groq.ts';
import { bearer, jwt } from '../src/jwt.ts';
import { local } from '../src/local.ts';
import { minimax } from '../src/minimax.ts';
import { mistral } from '../src/mistral.ts';
import { moonshot } from '../src/moonshot.ts';
import { ollama } from '../src/ollama.ts';
import { openai } from '../src/openai.ts';
import { openrouter } from '../src/openrouter.ts';
import { redis } from '../src/redis.ts';
import { together } from '../src/together.ts';
import { typesafe } from '../src/typesafe.ts';
import { zai } from '../src/zai.ts';

// Every secret planted below holds the word CANARY, and nothing a motty is
// handed, a caller is sent or another origin receives may hold that word.

// Left unguarded by decision, since no cut can know them: a key echoed encoded
// or in another case, or inside an answer that succeeded, a connection's body
// fields, a token in a header no API names a credential, the process itself.

// Named by its entry in the package, so an adapter added there and not here
// is a failure and not a row left out.
const adapters = {
  anthropic,
  dashscope,
  deepseek,
  fireworks,
  groq,
  local,
  minimax,
  mistral,
  moonshot,
  ollama,
  openai,
  openrouter,
  together,
  typesafe,
  zai,
};

// One upstream plays every provider, since a server made for each row costs
// more than all the rows do: the address says how it answers, and what it
// answers quotes the key and every header it was sent.
const elsewhere: string[] = [];
const other = Bun.serve({
  port: 0,
  fetch: (request) => {
    elsewhere.push(JSON.stringify([request.url, ...request.headers]));
    return new Response('moved', { status: 400 });
  },
});
const received: string[] = [];
const upstream = Bun.serve({
  port: 0,
  fetch: (request) => {
    const [, status, form] = new URL(request.url).pathname.split('/');
    const sent = JSON.stringify([...request.headers]);
    received.push(sent);
    const key = (
      request.headers.get('x-api-key') ??
      request.headers.get('authorization') ??
      ''
    ).replace('Bearer ', '');
    // One part of a header, as an upstream that reads it apart says it.
    const part = (request.headers.get('x-gateway-session') ?? '').replace(
      /^.*session=|;.*$/g,
      '',
    );
    const quoted =
      form === 'masked'
        ? `${key.slice(0, 12)}********${key.slice(-4)}`
        : form === 'part'
          ? part
          : `${key}. You sent ${sent}`;
    const said = `Incorrect API key provided: ${quoted}`;
    const body = JSON.stringify({
      type: 'error',
      message: said,
      error: {
        message: said,
        param: said,
        metadata: { raw: said, provider_name: quoted },
        ...(form === 'named'
          ? { [key]: 'is not valid', sent: { [`Bearer ${key}`]: 1, [part]: 1 } }
          : {}),
      },
      request_id: quoted,
    });
    return new Response(
      form === 'stream'
        ? `event: error\ndata: ${body}\n\n`
        : form === 'page'
          ? `<html>${said}</html>`
          : form === 'short'
            ? body.slice(0, -2)
            : body,
      {
        status: Number(status),
        headers: {
          'content-type':
            form === 'stream'
              ? 'text/event-stream'
              : form === 'page'
                ? 'text/html'
                : 'application/json',
          'x-request-id': quoted.slice(0, 80).replaceAll(/[^\w-]/g, ''),
          location: `${other.url}v1/moved`,
        },
      },
    );
  },
});
// Made after the two above and stopped, so its port is one nobody listens at.
const gone = Bun.serve({ port: 0, fetch: () => new Response('') });
await gone.stop(true);

afterAll(async () => {
  await upstream.stop(true);
  await other.stop(true);
});

// The runtime's own printer hides a nested error's fields and a cause that
// is text, so this one is told to leave nothing out. What is returned is each
// place a secret was seen, so a failure shows the leak and not the whole print.
function leaked(held: unknown): string[] {
  const printed = inspect(held, {
    depth: Infinity,
    showHidden: true,
    getters: true,
    maxStringLength: Infinity,
    maxArrayLength: Infinity,
  });
  return printed.includes('CANARY')
    ? (printed.match(/.{0,80}CANARY.{0,40}/g) ?? [])
    : [];
}

// No printer lists a request's headers or reads a signal's reason, which sits
// on the prototype, so both are kept by hand beside the context.
function seen(context: {
  readonly request: { readonly headers: Headers };
  readonly signal: AbortSignal;
}): unknown[] {
  return [context, [...context.request.headers], context.signal.reason];
}

// Keeps what every hook is handed, asks everything a host serves, and lets
// the last failure through so each boundary and the caller are told it too.
function hostile(kept: unknown[], after: unknown[], name: string) {
  const plugin = motty({ name: 'plugin' })
    .derive((context) => {
      kept.push(hosted(), ...seen(context));
      return {};
    })
    .beforeHandle((context) => {
      kept.push(...seen(context));
    })
    .onError((thrown, context) => {
      kept.push(thrown, ...seen(context));
    })
    .afterResponse((context) => {
      after.push(hosted(), ...seen(context));
    });
  const inner = motty({ name: 'inner' })
    .beforeHandle((context) => {
      kept.push(...seen(context));
    })
    .onError((thrown, context) => {
      kept.push(thrown, ...seen(context));
    })
    .handle(async (context) => {
      const { decisions, storage, signal } = hosted();
      const failures: unknown[] = [];
      for (const ask of [
        async () => {
          const reply = await model(name).complete({
            messages: [{ role: 'user', text: 'hi' }],
          });
          return [
            await Array.fromAsync(reply.chunks()),
            await reply.usage(),
            await reply.model(),
          ];
        },
        () => decisions?.(name, { state: 'hi', questions: {} }, signal),
        () => storage?.get('key'),
        () => storage?.set('key', 1, { ttlMs: 5000 }),
        () => storage?.delete('key'),
        () => storage?.increment?.('key', 1),
      ]) {
        try {
          kept.push(await ask());
        } catch (failure) {
          failures.push(failure);
        }
      }
      kept.push(failures, hosted(), ...seen(context));
      // A name only one kind of adapter serves fails the other kind's call,
      // which is no failure of the upstream and would hide the one that is.
      const failure = failures.findLast(
        (thrown) => !(thrown instanceof UnknownModel),
      );
      if (failure !== undefined) throw failure;
      return answer('done');
    })
    .afterHandle((context) => {
      kept.push(...seen(context));
    });
  return motty({ name: 'hostile' })
    .use(plugin)
    .beforeHandle((context) => {
      kept.push(...seen(context));
    })
    .onError((thrown, context) => {
      kept.push(thrown, ...seen(context));
    })
    .afterResponse((context) => {
      after.push(...seen(context));
    })
    .route(() => 'inner', {
      inner: inner.catch((thrown, context) => {
        kept.push(thrown, ...seen(context));
        throw thrown;
      }),
    })
    .afterHandle((context) => {
      kept.push(...seen(context));
    });
}

// Each wire API writes a failure its own way, whole and inside a stream, so
// a caller of each is asked both ways. One body is read by all three.
async function told(
  fetch: (request: Request) => Promise<Response>,
  headers: [string, string][],
): Promise<string[]> {
  return Promise.all(
    [chatCompletions, responses, messages].flatMap(({ paths }) =>
      paths.flatMap((path) =>
        [false, true].map(async (stream) => {
          const reply = await fetch(
            new Request(`http://host${path}`, {
              method: 'POST',
              headers: [['content-type', 'application/json'], ...headers],
              body: JSON.stringify({
                model: 'hostile',
                max_tokens: 16,
                input: 'hi',
                messages: [{ role: 'user', content: 'hi' }],
                stream,
              }),
            }),
          );
          return `${path} ${reply.status} ${JSON.stringify([...reply.headers])} ${await reply.text()}`;
        }),
      ),
    ),
  );
}

test('every adapter the package exports is under this guard', () => {
  expect(Object.keys(manifest.exports).sort()).toEqual(
    [
      ...Object.keys(adapters).map((name) => `./${name}`),
      // These reach no model: one signs a caller in, one stores, one is rules.
      './jwt',
      './redis',
      './takes',
    ].sort(),
  );
});

test.each(
  Object.entries(adapters).flatMap(([name, make]) =>
    (
      [
        ['refuses the key and says it back whole', '401/whole'],
        ['refuses the key and says it back masked', '401/masked'],
        ['refuses the request and says it back', '400/whole'],
        ['says the key and a header back as the names of fields', '400/named'],
        ['says one part of a header back alone', '400/part'],
        ['limits the rate and says the request back', '429/whole'],
        ['fails and says the request back', '500/whole'],
        ['fails inside a stream and says the request back', '200/stream'],
        ['answers with a page', '403/page'],
        ['sends the request on to another origin', '307/whole'],
        ['answers 200 with JSON cut short', '200/short'],
        ['is gone', 'gone'],
      ] as const
    ).map(([behaviour, path]) => [name, behaviour, make, path] as const),
  ),
)(
  '%s: no secret reaches the motty, its caller or another origin when the upstream %s',
  async (name, _, make, path) => {
    const kept: unknown[] = [];
    const after: unknown[] = [];
    const reports: Report[] = [];
    const { fetch, close } = mount(hostile(kept, after, `${name}/m`), () => ({
      models: [
        make({
          key: `sk-CANARY-${name}-key-4f8a1c2e9b7d6035`,
          address:
            path === 'gone'
              ? `http://localhost:${gone.port}/v1`
              : `http://localhost:${upstream.port}/${path}/v1`,
          headers: {
            'x-gateway-key': 'CANARY-gateway-header',
            'x-gateway-authorization': 'Bearer CANARY-gateway-token',
            'x-gateway-session':
              'tenant=acme; session=CANARY-gateway-session; v2',
          },
        }),
      ],
      storage: memory(),
      auth: bearer({ secret: 'CANARY-caller-token', id: 'ada' }),
      report: (report) => reports.push(report),
    }));

    const bytes = await told(fetch, [
      ['authorization', 'Bearer CANARY-caller-token'],
    ]);
    await close();

    // The alarm is worth nothing unless the secrets were really sent out and
    // the failure really came back.
    const sent = received.splice(0).join();
    const moved = elsewhere.splice(0);
    if (path !== 'gone') {
      expect(sent).toContain(`CANARY-${name}-key`);
      expect(sent).toContain('CANARY-gateway-header');
      expect(sent).toContain('CANARY-gateway-token');
      expect(sent).toContain('CANARY-gateway-session');
    }
    expect(bytes.filter((reply) => reply.includes(' 200 ['))).toEqual([]);
    expect(moved).toEqual([]);
    expect(leaked(bytes)).toEqual([]);
    expect(leaked(kept)).toEqual([]);
    expect(leaked(after)).toEqual([]);
    expect(leaked(reports)).toEqual([]);
  },
);

test.each(Object.entries(adapters))(
  '%s: an address that holds a password is refused when the adapter is made, in words that do not hold it',
  (name, make) => {
    let refused = '';
    try {
      make({
        key: `sk-CANARY-${name}-key-4f8a1c2e9b7d6035`,
        address: `http://gateway:CANARY-address-password@localhost:${upstream.port}/400/whole/v1`,
      });
    } catch (thrown) {
      refused = inspect(thrown, { showHidden: true });
    }

    expect(refused).toMatch(/an address that holds credentials/);
    expect(leaked(refused)).toEqual([]);
    expect(received.splice(0)).toEqual([]);
  },
);

test.each(
  Object.entries(adapters).flatMap(([name, make]) =>
    (
      [
        [
          'a key with whitespace around it',
          ' \tsk-CANARY-written-wrongly-4f8a1c2e\n ',
          'plain',
          /^$/,
        ],
        [
          'a key with a line break inside it',
          'sk-CANARY-written-\nwrongly-4f8a1c2e',
          'plain',
          /a key no header can carry/,
        ],
        [
          'a key with a character no header carries',
          'sk-CANARY-written-wrongly-4f8a1c2e☃',
          'plain',
          /a key no header can carry/,
        ],
        [
          'a connection header with whitespace around it',
          'sk-plain',
          ' \tCANARY-written-wrongly-4f8a1c2e\n ',
          /^$/,
        ],
        [
          'a connection header with a line break inside it',
          'sk-plain',
          'CANARY-written-\nwrongly-4f8a1c2e',
          /a header no request can carry/,
        ],
        [
          'a connection header with a character no header carries',
          'sk-plain',
          'CANARY-written-wrongly-4f8a1c2e☃',
          /a header no request can carry/,
        ],
      ] as const
    ).map(
      ([written, key, header, refusal]) =>
        [name, written, make, key, header, refusal] as const,
    ),
  ),
)(
  '%s: %s is still cut, or is refused when the adapter is made in words that do not hold it',
  async (name, _, make, key, header, refusal) => {
    const kept: unknown[] = [];
    const after: unknown[] = [];
    const reports: Report[] = [];
    const models: ReturnType<typeof make>[] = [];
    let refused = '';
    try {
      models.push(
        make({
          key,
          address: `http://localhost:${upstream.port}/400/whole/v1`,
          headers: { 'x-gateway-key': header },
        }),
      );
    } catch (thrown) {
      refused = inspect(thrown, { showHidden: true });
    }
    const { fetch, close } = mount(hostile(kept, after, `${name}/m`), () => ({
      models,
      report: (report) => reports.push(report),
    }));

    const bytes = await told(fetch, []);
    await close();

    expect(refused).toMatch(refusal);
    expect(received.splice(0).join().includes('CANARY-written-wrongly')).toBe(
      refused === '',
    );
    expect(leaked(refused)).toEqual([]);
    expect(leaked(bytes)).toEqual([]);
    expect(leaked(kept)).toEqual([]);
    expect(leaked(after)).toEqual([]);
    expect(leaked(reports)).toEqual([]);
  },
);

// Made from each wire API's own list, so a new API, or a new credential
// header on one, is new rows with no line written here.
test.each(
  [chatCompletions, responses, messages].flatMap(({ paths, credentials }) => {
    // A bearer token follows its scheme, and any other header is the key.
    const real = (header: string) =>
      header === 'authorization'
        ? 'Bearer CANARY-caller-token'
        : 'CANARY-caller-token';
    const others = [
      ...new Set(
        [chatCompletions, responses, messages].flatMap(
          (other) => other.credentials,
        ),
      ),
    ].filter((other) => !credentials.includes(other));
    return paths.flatMap((path) => [
      ...others.map((other): [string, string, [string, string][]] => [
        path,
        `${other}, another API's credential header`,
        [[other, real(other)]],
      ]),
      ...credentials.flatMap((name): [string, string, [string, string][]][] => [
        [path, `${name} alone`, [[name, real(name)]]],
        [
          path,
          `${name} written as another header is`,
          [[name, real(name === 'authorization' ? 'key' : 'authorization')]],
        ],
        [
          path,
          `${name} sent twice`,
          [
            [name, real(name)],
            [name, real(name)],
          ],
        ],
        [
          path,
          `${name.toUpperCase()} in another casing`,
          [[name.toUpperCase(), real(name)]],
        ],
        ...credentials
          .filter((other) => other !== name)
          .flatMap((other): [string, string, [string, string][]][] => [
            [
              path,
              `${name} beside a dummy in ${other}`,
              [
                [name, real(name)],
                [other, 'dummy'],
              ],
            ],
            [
              path,
              `${name} beside the same token in ${other}`,
              [
                [name, real(name)],
                [other, real(other)],
              ],
            ],
          ]),
      ]),
    ]);
  }),
)(
  '%s: the token that signs a caller in never reaches the motty in %s',
  async (path, _, headers) => {
    const kept: unknown[] = [];
    const after: unknown[] = [];
    const reports: Report[] = [];
    const { fetch, close } = mount(hostile(kept, after, 'nobody/m'), () => ({
      storage: memory(),
      auth: bearer({ secret: 'CANARY-caller-token', id: 'ada' }),
      report: (report) => reports.push(report),
    }));

    const reply = await fetch(
      new Request(`http://host${path}`, {
        method: 'POST',
        headers: [['content-type', 'application/json'], ...headers],
        body: JSON.stringify({
          model: 'hostile',
          max_tokens: 16,
          input: 'hi',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      }),
    );
    const bytes = `${JSON.stringify([...reply.headers])} ${await reply.text()}`;
    await close();

    expect(reply.status).toBe(200);
    expect(leaked(bytes)).toEqual([]);
    expect(leaked(kept)).toEqual([]);
    expect(leaked(after)).toEqual([]);
    expect(leaked(reports)).toEqual([]);
  },
);

test.each([
  [
    'the storage on a read',
    'storage',
    {
      storage: {
        ...memory(),
        get: () => {
          throw new Error('redis://default:CANARY-thrown@db:6379 refused');
        },
      },
    } satisfies HostOptions,
  ],
  [
    'the storage on a write',
    'storage',
    {
      storage: {
        ...memory(),
        set: async () => {
          throw new Error('redis://default:CANARY-thrown@db:6379 refused');
        },
      },
    } satisfies HostOptions,
  ],
  [
    'the storage on a delete',
    'storage',
    {
      storage: {
        ...memory(),
        delete: async () => {
          throw new Error('refused', { cause: 'CANARY-thrown' });
        },
      },
    } satisfies HostOptions,
  ],
  [
    'the storage on an addition',
    'storage',
    {
      storage: {
        ...memory(),
        increment: async () => {
          throw new Error('refused', { cause: new Error('CANARY-thrown') });
        },
      },
    } satisfies HostOptions,
  ],
  [
    'a decision adapter',
    'decisions',
    {
      models: [
        {
          serves: () => true,
          decide: async () => {
            throw new Error('Bearer CANARY-thrown was refused');
          },
        },
      ],
    } satisfies HostOptions,
  ],
  [
    'the price',
    'price',
    {
      price: () => {
        throw new Error('no rate for the account CANARY-thrown');
      },
    } satisfies HostOptions,
  ],
  [
    'the models of one request',
    'models',
    {
      models: () => {
        throw new Error('the vault refused CANARY-thrown');
      },
    } satisfies HostOptions,
  ],
  [
    'the sign-in',
    'auth',
    {
      auth: {
        verify: () => {
          throw new Error('the key set at https://id/?key=CANARY-thrown');
        },
      },
    } satisfies HostOptions,
  ],
  [
    'a model adapter when called',
    'models',
    {
      models: [
        {
          serves: () => true,
          call: () => {
            throw new Error('Bearer CANARY-thrown was refused');
          },
        },
      ],
    } satisfies HostOptions,
  ],
  [
    'a model adapter on the first read',
    'models',
    {
      models: [
        {
          serves: () => true,
          call: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () =>
                Promise.reject(new Error('Bearer CANARY-thrown was refused')),
            }),
          }),
        },
      ],
    } satisfies HostOptions,
  ],
  [
    'a model adapter in the middle of its stream',
    'models',
    {
      models: [
        {
          serves: () => true,
          call: async function* () {
            yield { type: 'text', text: 'so' } as const;
            throw new Error('Bearer CANARY-thrown was refused');
          },
        },
      ],
    } satisfies HostOptions,
  ],
] as const)(
  'what %s throws reaches the motty and its caller as a sentence of the SDK, and the host in its report',
  async (_, service, options) => {
    const kept: unknown[] = [];
    const after: unknown[] = [];
    const reports: Report[] = [];
    const { fetch, close } = mount(hostile(kept, after, 'fine/m'), () => ({
      models: [
        {
          serves: () => true,
          call: async function* () {
            yield { type: 'text', text: 'so' } as const;
            yield {
              type: 'finish',
              reason: 'stop',
              usage: { input: 1, output: 1 },
            } as const;
          },
          decide: async () => ({
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        },
      ],
      storage: memory(),
      ...options,
      report: (report) => reports.push(report),
    }));

    const bytes = await told(fetch, [
      ['authorization', 'Bearer CANARY-caller-token'],
    ]);
    await close();

    // The report is the host's own: the thrown value is there on purpose,
    // under the service that threw, and nowhere else in it.
    const failed = reports.flatMap((report) => report.failed ?? []);
    expect(failed.map((failure) => failure.service)).toContain(service);
    expect(leaked(failed)).not.toEqual([]);
    expect(leaked(reports.map(({ failed: _, ...rest }) => rest))).toEqual([]);
    expect(leaked(bytes)).toEqual([]);
    expect(leaked(kept)).toEqual([]);
    expect(leaked(after)).toEqual([]);
  },
);

test.each([
  ['is gone', false],
  ['refuses the password and says it back', true],
] as const)(
  'neither the password in a store address nor the secret tokens are signed with reaches the motty when the store %s',
  async (_, listening) => {
    const heard: string[] = [];
    using database = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data(socket, received) {
          heard.push(received.toString());
          socket.write(
            `-WRONGPASS ${received.toString().replaceAll(/\s+/g, ' ')}\r\n`,
          );
        },
      },
    });
    if (!listening) database.stop(true);
    const kept: unknown[] = [];
    const after: unknown[] = [];
    const reports: Report[] = [];
    const { fetch, close } = mount(hostile(kept, after, 'nobody/m'), () => ({
      storage: redis({
        address: `redis://default:CANARY-storage-password@127.0.0.1:${database.port}/0`,
      }),
      auth: jwt({ secret: 'CANARY-jwt-secret-of-thirty-two-bytes' }),
      report: (report) => reports.push(report),
    }));

    const bytes = await told(fetch, [
      [
        'authorization',
        `Bearer ${await new SignJWT({ sub: 'ada' })
          .setProtectedHeader({ alg: 'HS256' })
          .sign(
            new TextEncoder().encode('CANARY-jwt-secret-of-thirty-two-bytes'),
          )}`,
      ],
    ]);
    await close();

    expect(
      reports.flatMap(({ failed = [] }) =>
        failed.map(({ service }) => service),
      ),
    ).toContain('storage');
    expect(heard.join().includes('CANARY-storage-password')).toBe(listening);
    expect(inspect(kept, { depth: 3 })).toContain("caller: { id: 'ada' }");
    expect(leaked(bytes)).toEqual([]);
    expect(leaked(kept)).toEqual([]);
    expect(leaked(after)).toEqual([]);
    expect(leaked(reports.map(({ failed: _, ...rest }) => rest))).toEqual([]);
  },
);

// A decision server tells a failure in a shape of its own, which the upstream
// above does not write, and its sentence is the message a caller is sent.
test.each([
  [
    'an object',
    (quoted: string) => ({
      detail: { error_type: quoted, message: `Unknown key: ${quoted}` },
    }),
  ],
  ['a sentence', (quoted: string) => ({ detail: `Unknown key: ${quoted}` })],
  [
    'a list of what a validator refused',
    (quoted: string) => ({
      detail: [
        {
          type: 'missing',
          loc: ['header', quoted],
          msg: `No field for ${quoted}`,
          input: { [quoted]: quoted },
        },
      ],
    }),
  ],
] as const)(
  'typesafe: no secret reaches the motty or its caller when the upstream says the request back in a detail that is %s',
  async (_, detailed) => {
    const sent: string[] = [];
    using server = Bun.serve({
      port: 0,
      fetch: (request) => {
        const key = request.headers.get('authorization') ?? '';
        sent.push(JSON.stringify([...request.headers]));
        return Response.json(
          detailed(
            `${key}, or ${key.slice(7, 19)}********${key.slice(-4)}. You sent ${sent.at(-1)}`,
          ),
          {
            status: 400,
            headers: { 'x-typesafe-request-id': key.slice(7) },
          },
        );
      },
    });
    const kept: unknown[] = [];
    const after: unknown[] = [];
    const reports: Report[] = [];
    const { fetch, close } = mount(hostile(kept, after, 'typesafe/m'), () => ({
      models: [
        typesafe({
          key: 'sk-CANARY-typesafe-key-4f8a1c2e9b7d6035',
          address: `${server.url}v1`,
          headers: {
            'x-gateway-authorization': 'Bearer CANARY-gateway-token',
          },
        }),
      ],
      report: (report) => reports.push(report),
    }));

    const bytes = await told(fetch, []);
    await close();

    expect(sent.join()).toContain('CANARY-typesafe-key');
    expect(sent.join()).toContain('CANARY-gateway-token');
    // The sentence did reach the caller, so the cut is what kept it clean.
    expect(bytes.join()).toMatch(/Unknown key: |No field for /);
    expect(leaked(bytes)).toEqual([]);
    expect(leaked(kept)).toEqual([]);
    expect(leaked(after)).toEqual([]);
    expect(leaked(reports)).toEqual([]);
  },
);
