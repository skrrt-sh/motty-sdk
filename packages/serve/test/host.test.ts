import { expect, test } from 'bun:test';
import { auth } from '@mottyjs/auth';
import { answer, model, motty, Unauthenticated } from '@mottyjs/core';
import type {
  AuthAdapter,
  HostOptions,
  ModelAdapter,
  Overrides,
  Report,
} from '@mottyjs/core/host';
import { settings } from '@mottyjs/settings';
import { store } from '@mottyjs/store';
import { fake, memory, on } from '@mottyjs/test';
import { z } from 'zod';
import { mount, serve } from '../src/index.ts';

const gpt = model('openai/gpt');

function ask(headers: { [name: string]: string } = {}): Request {
  return new Request('http://motty.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      model: 'coder',
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    }),
  });
}

async function said(reply: Response): Promise<string> {
  const { choices } = z
    .object({
      choices: z.tuple([
        z.object({ message: z.object({ content: z.string() }) }),
      ]),
    })
    .parse(await reply.json());
  return choices[0].message.content;
}

const keys: AuthAdapter = {
  verify: (token) => {
    if (token === 'sk-forged') throw new Unauthenticated('Bad token');
    return token === 'sk-ada' ? { id: 'ada' } : undefined;
  },
};

const whoAsked = motty({ name: 'coder' })
  .use(auth())
  .handle(({ caller, request }) =>
    answer(
      JSON.stringify({
        caller: caller.id,
        headers: [...request.headers.keys()].sort(),
      }),
    ),
  );

test('the adapter proves the caller by the token, and the credential header of this API and of every other is gone before the motty reads the rest', async () => {
  const served = serve(whoAsked, () => ({ auth: keys }));

  const reply = await served.fetch(
    ask({
      authorization: 'Bearer sk-ada',
      'x-api-key': 'sk-not-of-this-api',
      'x-trace': 'trace-7',
    }),
  );

  expect(reply.status).toBe(200);
  expect(JSON.parse(await said(reply))).toEqual({
    caller: 'ada',
    headers: ['content-type', 'x-trace'],
  });
});

test.each([
  [
    { 'x-api-key': 'sk-ada', authorization: 'Bearer sk-eve' },
    ['content-type', 'x-trace'],
  ],
  [
    { 'x-api-key': 'dummy', authorization: 'Bearer sk-ada' },
    ['content-type', 'x-trace'],
  ],
])(
  'a caller of the Anthropic API is proven by the header its client sends, and every credential header is gone: %o',
  async (credential, headers) => {
    const served = serve(whoAsked, () => ({ auth: keys }));

    const reply = await served.fetch(
      new Request('http://motty.test/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-trace': 'trace-7',
          ...credential,
        },
        body: JSON.stringify({
          model: 'coder',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Why does this deadlock?' }],
        }),
      }),
    );

    expect(reply.status).toBe(200);
    expect(await reply.json()).toMatchObject({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ caller: 'ada', headers }),
        },
      ],
    });
  },
);

test('a caller the adapter does not know is refused by the motty that asks for one', async () => {
  const served = serve(whoAsked, () => ({ auth: keys }));

  const reply = await served.fetch(ask({ authorization: 'Bearer sk-eve' }));

  expect(reply.status).toBe(401);
  expect(await reply.json()).toMatchObject({
    error: {
      message: 'This motty needs a caller, and the host knows none',
      type: 'authentication_error',
    },
  });
});

test('a caller the adapter answers with an empty id is refused by the motty that asks for one, and by its model list', async () => {
  const served = serve(whoAsked, () => ({
    auth: { verify: () => ({ id: '' }) },
  }));

  const reply = await served.fetch(ask({ authorization: 'Bearer sk-ada' }));
  const list = await served.fetch(
    new Request('http://motty.test/v1/models', {
      headers: { authorization: 'Bearer sk-ada' },
    }),
  );

  expect(reply.status).toBe(401);
  expect(list.status).toBe(401);
});

test('an auth adapter that throws what is no SDK error fails the request before the motty runs: the caller is told nothing of it, and the report holds it', async () => {
  const reports: Report[] = [];
  let ran = false;
  const served = serve(
    motty({ name: 'coder' }).handle(() => {
      ran = true;
      return answer('Use a mutex.');
    }),
    () => ({
      auth: {
        verify: () => {
          throw new Error('https://issuer.test/keys?secret=hunter2 timed out');
        },
      },
      report: (report) => reports.push(report),
    }),
  );

  const reply = await served.fetch(ask({ authorization: 'Bearer sk-ada' }));

  expect(reply.status).toBe(500);
  expect(await reply.json()).toMatchObject({
    error: { message: 'Internal error' },
  });
  expect(ran).toBe(false);
  expect(reports).toMatchObject([
    {
      outcome: 'failed',
      error: { message: "The host's auth failed" },
      calls: [],
      failed: [
        {
          service: 'auth',
          error: {
            message: 'https://issuer.test/keys?secret=hunter2 timed out',
          },
        },
      ],
    },
  ]);
  await served.close();
});

test('with no auth adapter there is no caller, whatever the request carries', async () => {
  const served = serve(whoAsked, () => ({}));

  const reply = await served.fetch(ask({ authorization: 'Bearer sk-ada' }));

  expect(reply.status).toBe(401);
});

test('a credential a client sends does not override the caller the host gives: the adapter is not asked, and the header is gone before the motty reads the rest', async () => {
  let verified = 0;
  const served = mount(whoAsked, () => ({
    auth: {
      verify: () => {
        verified += 1;
        return { id: 'eve' };
      },
    },
  }));

  const reply = await served.fetch(
    ask({ authorization: 'Bearer sk-eve', 'x-api-key': 'sk-eve' }),
    undefined,
    { caller: { id: 'ada' } },
  );

  expect(JSON.parse(await said(reply))).toEqual({
    caller: 'ada',
    headers: ['content-type'],
  });
  expect(verified).toBe(0);
});

test("nothing of the caller's headers reaches a model adapter", async () => {
  const given: unknown[][] = [];
  const upstream: ModelAdapter = {
    serves: () => true,
    call: async function* (...all) {
      given.push(all);
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const served = serve(
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    () => ({ models: [upstream], auth: keys }),
  );

  await served.fetch(
    ask({ authorization: 'Bearer sk-ada', 'x-trace': 'trace-7' }),
  );

  expect(given).toHaveLength(1);
  expect(given[0]).toEqual([
    'openai/gpt',
    expect.objectContaining({
      messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    }),
    expect.any(AbortSignal),
  ]);
  expect(JSON.stringify(given[0]?.[1])).not.toMatch(/sk-ada|trace-7/);
});

const tuned = motty({ name: 'coder' })
  .use(
    settings({
      routing: z.object({
        threshold: z.number().max(1).default(0.5),
        tier: z.enum(['fast', 'deep']).default('fast'),
      }),
    }),
  )
  .handle(({ settings: { routing } }) =>
    answer(`${routing.tier} at ${routing.threshold}`),
  );

test("the host's setting overrides reach the motty, and the rest keep their defaults", async () => {
  const reports: Report[] = [];
  const served = serve(tuned, () => ({
    settings: { routing: { threshold: 0.9 } },
    report: (report) => reports.push(report),
  }));

  const reply = await served.fetch(ask());

  expect(await said(reply)).toBe('fast at 0.9');
  expect(reports).toMatchObject([
    { settings: { routing: { threshold: 0.9 } } },
  ]);
});

test("an override the motty's schema refuses fails the request, and only the report says why", async () => {
  const reported = Promise.withResolvers<Report>();
  const served = serve(tuned, () => ({
    settings: { routing: { threshold: 2 } },
    report: reported.resolve,
  }));

  const reply = await served.fetch(ask());

  expect(reply.status).toBe(500);
  expect(await reply.json()).toMatchObject({
    error: { message: 'Internal error' },
  });
  expect(await reported.promise).toMatchObject({
    outcome: 'failed',
    error: {
      message: expect.stringContaining(
        'The host\'s settings for the group "routing" are not valid',
      ),
    },
  });
});

test('the overrides are typed by the settings the motty declares, for a serve file and for a mounted motty', () => {
  const typed: HostOptions<Overrides<typeof tuned>> = {
    settings: { routing: { tier: 'deep' } },
  };
  const untyped: HostOptions = { settings: { anything: { goes: true } } };

  serve(tuned, () => ({ settings: { routing: { tier: 'deep' } } }));
  serve(tuned, ({ PORT }) => ({
    ...typed,
    limits: { calls: Number(PORT ?? 8) },
  }));
  mount(tuned, () => ({ settings: {} }));
  mount(tuned, () => untyped);
  mount(tuned, () => ({
    models: (request, caller) => [
      fake(on(gpt, `${request.id} for ${caller?.id}`)),
    ],
    settings: { routing: { tier: 'deep' } },
  }));
  mount(tuned, () => ({
    models: () => [],
    // @ts-expect-error the tier is one of the two, with models per request too
    settings: { routing: { tier: 'slow' } },
  }));
  // @ts-expect-error the models are a list, or a function that returns one
  mount(tuned, () => ({ models: () => fake() }));
  // @ts-expect-error the motty declares no group of that name
  serve(tuned, () => ({ settings: { routes: { tier: 'deep' } } }));
  // @ts-expect-error nor beside a group it does declare
  mount(tuned, () => ({ settings: { routing: {}, routes: {} } }));
  // @ts-expect-error the tier is one of the two the schema names
  serve(tuned, () => ({ settings: { routing: { tier: 'slow' } } }));
  // @ts-expect-error the threshold is a number
  mount(tuned, () => ({ settings: { routing: { threshold: 'high' } } }));
  // @ts-expect-error the group has no such value
  mount(tuned, () => ({ settings: { routing: { depth: 2 } } }));
});

const counting = (name: string) =>
  motty({ name }).handle(async () => {
    const seen = ((await store.get<number>('seen')) ?? 0) + 1;
    await store.set('seen', seen);
    return answer(String(seen));
  });

test("the storage is handed over with the served motty's name ahead of every key", async () => {
  const storage = memory();
  const served = serve(counting('coder'), () => ({ storage }));

  expect(await said(await served.fetch(ask()))).toBe('1');
  expect(await said(await served.fetch(ask()))).toBe('2');

  expect(await storage.get('coder:seen')).toBe(2);
  expect(await storage.get('seen')).toBeUndefined();
});

test('the report holds the whole error the caller was told only the code of', async () => {
  const reported = Promise.withResolvers<Report>();
  const served = serve(
    motty({ name: 'coder' }).handle(() => {
      throw new TypeError('db password hunter2 was rejected');
    }),
    () => ({ report: reported.resolve }),
  );

  const reply = await served.fetch(ask());

  expect(await reply.text()).not.toContain('hunter2');
  expect(await reported.promise).toMatchObject({
    outcome: 'failed',
    part: 'coder',
    error: {
      code: 'internal',
      message: 'db password hunter2 was rejected',
      stack: expect.stringContaining('TypeError'),
    },
  });
});

test('a request refused before the motty ran makes no report', async () => {
  const reports: Report[] = [];
  const served = serve(whoAsked, () => ({
    auth: keys,
    report: (report) => reports.push(report),
  }));

  await served.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      body: 'not json',
    }),
  );
  await served.fetch(ask({ authorization: 'Bearer sk-forged' }));
  await served.fetch(new Request('http://motty.test/v1/models'));
  await served.fetch(ask({ authorization: 'Bearer sk-ada' }));
  await served.close();

  expect(reports).toMatchObject([{ outcome: 'completed' }]);
});

test('a request refused before it was let in hands the host no work to wait for', async () => {
  const works: Promise<unknown>[] = [];
  const served = mount(whoAsked, () => ({ auth: keys }));
  const host = { waitUntil: (work: Promise<unknown>) => works.push(work) };

  const replies = [
    await served.fetch(
      new Request('http://motty.test/v1/chat/completions', {
        method: 'POST',
        body: 'not json',
      }),
      undefined,
      host,
    ),
    await served.fetch(
      new Request('http://motty.test/v2/chat', { method: 'POST' }),
      undefined,
      host,
    ),
    await served.fetch(
      ask({ authorization: 'Bearer sk-forged' }),
      undefined,
      host,
    ),
    await served.fetch(
      new Request('http://motty.test/v1/models'),
      undefined,
      host,
    ),
  ];
  await served.close();
  replies.push(
    await served.fetch(
      ask({ authorization: 'Bearer sk-ada' }),
      undefined,
      host,
    ),
  );

  expect(replies.map(({ status }) => status)).toEqual([
    400, 404, 401, 401, 503,
  ]);
  expect(works).toEqual([]);
});

test.each([
  ['/v1/models', {}, 401],
  ['/v1/models', { 'x-api-key': 'sk-ada' }, 401],
  ['/v1/models', { authorization: 'Bearer sk-ada' }, 200],
  ['/v1/models/coder', { 'api-key': 'sk-ada' }, 200],
  [
    '/v1/models',
    { 'x-api-key': 'sk-ada', 'anthropic-version': '2023-06-01' },
    200,
  ],
])(
  'the model list of a motty that asks for a caller is shown only to one the adapter knows by the headers of the API: %s %o',
  async (path, headers, status) => {
    const served = serve(whoAsked, () => ({ auth: keys }));

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, { headers }),
    );

    expect(reply.status).toBe(status);
    if (status === 401) {
      expect(await reply.json()).toEqual({
        error: {
          message: 'This motty needs a caller, and the host knows none',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key',
        },
      });
    }
  },
);

test('a caller the host gives opens the model list of a motty that asks for one', async () => {
  const served = mount(whoAsked, () => ({}));

  const reply = await served.fetch(
    new Request('http://motty.test/v1/models'),
    undefined,
    { caller: { id: 'ada' } },
  );

  expect(reply.status).toBe(200);
  expect(await reply.json()).toMatchObject({ data: [{ id: 'coder' }] });
});

test('the model list of a motty that asks for no caller is shown to anyone, and no caller is looked up', async () => {
  let verified = 0;
  const served = serve(
    motty({ name: 'coder' }).handle(() => answer('Use a mutex.')),
    () => ({
      auth: {
        verify: () => {
          verified += 1;
          return undefined;
        },
      },
    }),
  );

  const reply = await served.fetch(
    new Request('http://motty.test/v1/models', {
      headers: { authorization: 'Bearer sk-eve' },
    }),
  );

  expect(reply.status).toBe(200);
  expect(verified).toBe(0);
});

test.each([
  ['/v1/chat/completions', 'x-request-id', { messages: [] }],
  [
    '/v1/messages',
    'request-id',
    {
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    },
  ],
])(
  'a reply that failed, one that succeeded and a stream all carry the id of their report in the header the API reads: %s',
  async (path, header, body) => {
    const reports: Report[] = [];
    const served = serve(
      motty({ name: 'coder' }).handle(({ request }) => {
        if (request.headers.has('x-fail')) throw new Error('The index is gone');
        return answer('Use a mutex.');
      }),
      () => ({ report: (report) => reports.push(report) }),
    );

    const replies = await Promise.all(
      [
        { headers: { 'x-fail': 'yes' }, stream: false },
        { headers: {}, stream: false },
        { headers: {}, stream: true },
      ].map(async ({ headers, stream }) => {
        const reply = await served.fetch(
          new Request(`http://motty.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ model: 'coder', stream, ...body }),
          }),
        );
        return { reply, text: await reply.text() };
      }),
    );
    await served.close();

    expect(replies.map(({ reply }) => reply.status)).toEqual([500, 200, 200]);
    expect(reports).toHaveLength(3);
    expect(
      replies.map(({ reply }) => reply.headers.get(header)).sort(),
    ).toEqual(reports.map(({ id }) => id).sort());
    const failure = reports.find(({ outcome }) => outcome === 'failed');
    expect(replies[0]?.reply.headers.get(header)).toBe(failure?.id ?? '');
    if (header === 'request-id') {
      expect(JSON.parse(replies[0]?.text ?? '')).toEqual({
        type: 'error',
        error: { type: 'api_error', message: 'Internal error' },
        request_id: failure?.id,
      });
    }
  },
);

test.each([
  ['/v1/chat/completions', 'x-request-id', 'chatcmpl-', { messages: [] }],
  [
    '/v1/messages',
    'request-id',
    'msg_',
    {
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    },
  ],
])(
  'an id the host gives is the one in the header the API reads, in the ids of the body, whole and streamed, and on the report: %s',
  async (path, header, prefix, body) => {
    const reports: Report[] = [];
    const served = mount(
      motty({ name: 'coder' }).handle(() => answer('Use a mutex.')),
      () => ({ report: (report) => reports.push(report) }),
    );

    const replies = await Promise.all(
      [
        { id: 'host.whole~7', stream: false },
        { id: 'host_streamed-8', stream: true },
      ].map(async ({ id, stream }) => {
        const reply = await served.fetch(
          new Request(`http://motty.test${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'coder', stream, ...body }),
          }),
          undefined,
          { id },
        );
        return { reply, text: await reply.text() };
      }),
    );
    await served.close();

    expect(replies.map(({ reply }) => reply.headers.get(header))).toEqual([
      'host.whole~7',
      'host_streamed-8',
    ]);
    expect(replies[0]?.text).toContain(`"id":"${prefix}host.whole~7"`);
    expect(replies[1]?.text).toContain(`"id":"${prefix}host_streamed-8"`);
    expect(reports.map(({ id }) => id).sort()).toEqual([
      'host.whole~7',
      'host_streamed-8',
    ]);
  },
);

test('an id that could not go into a header is thrown to the host, on a chat path, on a guarded model list and on an unguarded one, and nothing runs or is reported', async () => {
  const reports: Report[] = [];
  const works: Promise<unknown>[] = [];
  let ran = false;
  const handled = () => {
    ran = true;
    return answer('Use a mutex.');
  };
  const guarded = mount(
    motty({ name: 'coder' }).use(auth()).handle(handled),
    () => ({ report: (report) => reports.push(report) }),
  );
  const open = mount(motty({ name: 'coder' }).handle(handled), () => ({
    report: (report) => reports.push(report),
  }));
  const host = {
    id: 'two words',
    caller: { id: 'ada' },
    waitUntil: (work: Promise<unknown>) => works.push(work),
  };

  const thrown = await Promise.all(
    [
      guarded.fetch(ask(), undefined, host),
      guarded.fetch(
        new Request('http://motty.test/v1/models'),
        undefined,
        host,
      ),
      open.fetch(new Request('http://motty.test/v1/models'), undefined, host),
    ].map((replying) => replying.catch((error: unknown) => error)),
  );
  await guarded.close();
  await open.close();

  expect(thrown).toEqual([
    new Error('The request id is not one the host may give'),
    new Error('The request id is not one the host may give'),
    new Error('The request id is not one the host may give'),
  ]);
  expect(ran).toBe(false);
  expect(reports).toEqual([]);
  expect(works).toEqual([]);
});

test("serve hands what the host says of a request on to the edge: the id, the caller and where the record's delivery goes", async () => {
  const works: Promise<unknown>[] = [];
  const reports: Report[] = [];
  const served = serve(whoAsked, () => ({
    report: (report) => reports.push(report),
  }));

  const reply = await served.fetch(ask(), undefined, {
    id: 'host-7',
    caller: { id: 'ada' },
    waitUntil: (work) => works.push(work),
  });

  expect(reply.headers.get('x-request-id')).toBe('host-7');
  expect(JSON.parse(await said(reply))).toMatchObject({ caller: 'ada' });
  expect(works).toHaveLength(1);
  await works[0];
  expect(reports).toMatchObject([{ id: 'host-7', outcome: 'completed' }]);
});

test('a request refused before it was let in has no record and carries no id', async () => {
  const served = serve(whoAsked, () => ({ auth: keys }));

  const reply = await served.fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      body: 'not json',
    }),
  );

  expect(reply.status).toBe(400);
  expect(reply.headers.has('x-request-id')).toBe(false);
});

test.each([
  ['/v1/chat/completions', 'x-request-id', { messages: [] }],
  [
    '/v1/messages',
    'request-id',
    {
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    },
  ],
  ['/v1/models', 'x-request-id', undefined],
])(
  'a reply to a request the auth adapter threw on carries the id of the report that holds what was thrown: %s',
  async (path, header, body) => {
    const reports: Report[] = [];
    const served = serve(whoAsked, () => ({
      auth: {
        verify: () => {
          throw new Error('The key set is gone');
        },
      },
      report: (report) => reports.push(report),
    }));

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-ada',
        },
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              body: JSON.stringify({ model: 'coder', ...body }),
            }),
      }),
    );
    await served.close();

    expect(reply.status).toBe(500);
    expect(reports).toHaveLength(1);
    expect(reply.headers.get(header)).toBe(reports[0]?.id ?? '');
  },
);

test.each([
  ['/v1/chat/completions', { messages: [] }],
  ['/v1/models', undefined],
])(
  'the report made when the auth adapter throws is handed to the host to wait for, and its work settles once the report has: %s',
  async (path, body) => {
    const sent = Promise.withResolvers<void>();
    const order: string[] = [];
    const works: Promise<unknown>[] = [];
    const served = mount(whoAsked, () => ({
      auth: {
        verify: () => {
          throw new Error('The key set is gone');
        },
      },
      report: async () => {
        await sent.promise;
        order.push('report');
      },
    }));

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-ada',
        },
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              body: JSON.stringify({ model: 'coder', ...body }),
            }),
      }),
      undefined,
      { waitUntil: (work) => works.push(work) },
    );

    expect(reply.status).toBe(500);
    expect(works).toHaveLength(1);
    const settled = works[0]?.then(() => order.push('work'));
    await Bun.sleep(10);
    expect(order).toEqual([]);
    sent.resolve();
    await settled;
    expect(order).toEqual(['report', 'work']);
  },
);

test.each([
  ['/v1/chat/completions', { messages: [] }],
  ['/v1/models', undefined],
])(
  'a close waits for the report made when the auth adapter throws: %s',
  async (path, body) => {
    const sent = Promise.withResolvers<void>();
    const order: string[] = [];
    const served = mount(whoAsked, () => ({
      auth: {
        verify: () => {
          throw new Error('The key set is gone');
        },
      },
      report: async () => {
        await sent.promise;
        order.push('report');
      },
    }));

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-ada',
        },
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              body: JSON.stringify({ model: 'coder', ...body }),
            }),
      }),
    );
    const closed = served.close().then(() => order.push('closed'));
    await Bun.sleep(10);
    expect(order).toEqual([]);
    sent.resolve();
    await closed;

    expect(reply.status).toBe(500);
    expect(order).toEqual(['report', 'closed']);
  },
);

test.each([
  ['/v1/chat/completions', { messages: [] }],
  ['/v1/models', undefined],
])(
  'a waitUntil that throws as the auth adapter throws changes nothing: the reply carries the id of the one report made: %s',
  async (path, body) => {
    const reports: Report[] = [];
    const served = mount(whoAsked, () => ({
      auth: {
        verify: () => {
          throw new Error('The key set is gone');
        },
      },
      report: (report) => reports.push(report),
    }));

    const reply = await served.fetch(
      new Request(`http://motty.test${path}`, {
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer sk-ada',
        },
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              body: JSON.stringify({ model: 'coder', ...body }),
            }),
      }),
      undefined,
      {
        waitUntil: () => {
          throw new Error('The context is gone');
        },
      },
    );
    await served.close();

    expect(reply.status).toBe(500);
    expect(await reply.json()).toMatchObject({
      error: { message: 'Internal error' },
    });
    expect(reports).toHaveLength(1);
    expect(reply.headers.get('x-request-id')).toBe(reports[0]?.id ?? '');
  },
);
