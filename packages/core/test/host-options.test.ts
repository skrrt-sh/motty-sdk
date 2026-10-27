import { expect, test } from 'bun:test';
import { motty } from '../src/chain/motty.ts';
import { contractOf } from '../src/chain/run.ts';
import { type EventStream, mark } from '../src/contract.ts';
import {
  Aborted,
  MottyError,
  Overloaded,
  UnknownModel,
} from '../src/data/errors.ts';
import type { ChatRequest, Json } from '../src/data/message.ts';
import { adapted, hosting, type Report } from '../src/host-options.ts';
import { answer } from '../src/request/answer.ts';
import { counted, hosted } from '../src/request/context.ts';
import { model } from '../src/request/model.ts';
import { retry } from '../src/request/retry.ts';
import { fallback, race } from '../src/request/switching.ts';
import { stubHost } from './stub-host.ts';

function ask(): ChatRequest {
  return {
    id: 'req_1',
    model: 'motty/coder',
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [],
    options: {},
    headers: new Headers(),
  };
}

test('a chat call goes to the first adapter that serves the name, with the prompt', async () => {
  const first = stubHost({
    'acme/small': [
      { type: 'text', text: 'first' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const second = stubHost({
    'acme/small': [
      { type: 'text', text: 'second' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const host = {
    ...stubHost(),
    ...adapted([
      { serves: (name) => name.startsWith('other/'), call: second.models },
      { serves: (name) => name.startsWith('acme/'), call: first.models },
      { serves: () => true, call: second.models },
    ]),
  };
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    model('acme/small').complete(prompt),
  );

  const events = await Array.fromAsync(contractOf(served).run(ask(), host));

  expect(events).toEqual([
    { type: 'text', text: 'first' },
    { type: 'finish', reason: 'stop', usage: {} },
  ]);
  expect(first.sent('acme/small')).toEqual([
    {
      messages: [{ role: 'user', text: 'Why does this deadlock?' }],
      tools: [],
      options: {},
    },
  ]);
  expect(second.sent('acme/small')).toEqual([]);
});

test('a chat call for a name no adapter serves ends as one unknown-model error event', async () => {
  const other = stubHost({
    'acme/missing': [
      { type: 'text', text: 'from an adapter that does not serve the name' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const { models } = adapted([{ serves: () => false, call: other.models }]);

  const events = await Array.fromAsync(
    models('acme/missing', { messages: [] }, new AbortController().signal),
  );

  expect(events).toEqual([
    {
      type: 'error',
      error: {
        code: 'unknown_model',
        status: 404,
        message: 'No model named acme/missing',
      },
    },
  ]);
});

test('a chat call passes over an adapter that serves the name with a decision call only', async () => {
  const chat = stubHost({
    'typesafe/jev': [
      { type: 'text', text: 'from the chat adapter' },
      { type: 'finish', reason: 'stop' },
    ],
  });
  const { models } = adapted([
    { serves: () => true, decide: async () => ({}) },
    { serves: () => true, call: chat.models },
  ]);
  const { signal } = new AbortController();

  expect(
    await Array.fromAsync(models('typesafe/jev', { messages: [] }, signal)),
  ).toMatchObject([{ type: 'text', text: 'from the chat adapter' }, {}]);
  expect(
    await Array.fromAsync(
      adapted([{ serves: () => true, decide: async () => ({}) }]).models(
        'typesafe/jev',
        { messages: [] },
        signal,
      ),
    ),
  ).toMatchObject([{ type: 'error', error: { code: 'unknown_model' } }]);
});

test('a decision call goes to the first adapter that serves the name with a decision call, input and result unchanged', async () => {
  const asked: unknown[] = [];
  const chat = stubHost();
  const host = {
    ...stubHost(),
    ...adapted([
      { serves: () => true, call: chat.models },
      {
        serves: (name) => name === 'typesafe/laya',
        decide: async () => ({ answers: 'from the wrong adapter' }),
      },
      {
        serves: (name) => name === 'typesafe/jev',
        decide: async (name, input, signal) => {
          asked.push(name, input, signal.aborted);
          return { answers: { software: { type: 'noul', noul: 0.02 } } };
        },
      },
    ]),
  };
  const input = { state: 'What should I cook tonight?', questions: {} };
  const seen: unknown[] = [];
  const served = motty({ name: 'coder' })
    .derive(async () => ({
      decided: await counted('typesafe/jev', async (signal) =>
        hosted().decisions?.('typesafe/jev', input, signal),
      ),
    }))
    .handle(({ decided, calls }) => {
      seen.push(decided, calls.made.length);
      return model('acme/missing').complete({ messages: [] });
    });

  await Array.fromAsync(contractOf(served).run(ask(), host));

  expect(seen).toEqual([
    { answers: { software: { type: 'noul', noul: 0.02 } } },
    1,
  ]);
  expect(asked).toEqual(['typesafe/jev', input, false]);
  expect(asked[1]).toBe(input);
});

test('a decision call for a name no adapter serves rejects with UnknownModel', async () => {
  const { decisions } = adapted([
    { serves: () => true, call: stubHost().models },
    { serves: () => false, decide: async () => ({}) },
  ]);

  const call = decisions('typesafe/missing', {}, new AbortController().signal);

  await expect(call).rejects.toBeInstanceOf(UnknownModel);
  await expect(call).rejects.toMatchObject({
    status: 404,
    message: 'No model named typesafe/missing',
  });
});

test('with no adapters every name is unknown', async () => {
  const { models, decisions } = adapted([]);
  const { signal } = new AbortController();

  expect(
    await Array.fromAsync(models('acme/small', { messages: [] }, signal)),
  ).toMatchObject([{ type: 'error', error: { code: 'unknown_model' } }]);
  await expect(decisions('typesafe/jev', {}, signal)).rejects.toBeInstanceOf(
    UnknownModel,
  );
});

function echo() {
  return motty({ name: 'coder' }).handle(({ request }) =>
    answer(JSON.stringify([...request.headers])),
  );
}

function asked(headers: { [name: string]: string } = {}) {
  const { id: _id, headers: _headers, ...request } = ask();
  return {
    request,
    headers: new Headers(headers),
    credentials: ['x-api-key', 'authorization'],
  };
}

test('a motty that speaks another contract version is refused when the host is made', () => {
  const contract = { ...contractOf(echo()), version: 2 };

  expect(() => hosting({ [mark]: contract }, {})).toThrow(
    'The motty speaks contract version 2, this host 1',
  );
});

test('every credential header is removed, with an auth adapter and without one', async () => {
  const sent = {
    authorization: 'Bearer sk-ada',
    'x-api-key': 'sk-ada',
    'x-trace': 'trace-7',
  };
  const given = new Headers(sent);

  const open = await hosting(echo(), {})({ ...asked(), headers: given });
  const guarded = await hosting(echo(), {
    auth: { verify: () => ({ id: 'ada' }) },
  })(asked(sent));

  expect([...open.request.headers]).toEqual([['x-trace', 'trace-7']]);
  expect(open.host.caller).toBeUndefined();
  expect([...guarded.request.headers]).toEqual([['x-trace', 'trace-7']]);
  expect(guarded.host.caller).toEqual({ id: 'ada' });
  expect(given.get('authorization')).toBe('Bearer sk-ada');
});

test('the credential headers of the other APIs the host serves are removed too, and a token in one signs nobody in', async () => {
  const tried: string[] = [];
  const { request, host } = await hosting(echo(), {
    auth: {
      verify: (token) => {
        tried.push(token);
        return undefined;
      },
    },
  })({
    ...asked({
      'Api-Key': 'sk-azure',
      'x-api-key': 'sk-ada',
      cookie: 'session=1',
      'proxy-authorization': 'Bearer sk-proxy',
    }),
    removed: ['authorization', 'api-key', 'x-api-key'],
  });

  expect([...request.headers]).toEqual([
    ['cookie', 'session=1'],
    ['proxy-authorization', 'Bearer sk-proxy'],
  ]);
  expect(tried).toEqual(['sk-ada']);
  expect(host).not.toHaveProperty('caller');
});

test('a credential header that holds another token is removed too', async () => {
  const { request } = await hosting(echo(), {
    auth: { verify: () => ({ id: 'ada' }) },
  })(asked({ 'x-api-key': 'sk-ada', authorization: 'Bearer sk-upstream' }));

  expect([...request.headers]).toEqual([]);
});

test('a credential header tried first and found empty is removed too', async () => {
  const { request } = await hosting(
    echo(),
    {},
  )(asked({ 'x-api-key': '', authorization: 'Bearer sk-ada' }));

  expect([...request.headers]).toEqual([]);
});

test('a credential header sent twice and in another case is removed whole', async () => {
  const sent = new Headers({ Authorization: 'Bearer sk-ada' });
  sent.append('X-Api-Key', 'sk-ada');
  sent.append('x-api-key', 'sk-ada');

  const { request } = await hosting(echo(), {
    auth: { verify: () => ({ id: 'ada' }) },
  })({ ...asked(), headers: sent });

  expect([...request.headers]).toEqual([]);
});

test('a caller whose first credential header holds a token the adapter does not know is signed in by the next', async () => {
  const { request, host } = await hosting(echo(), {
    auth: {
      verify: (token) => (token === 'sk-ada' ? { id: 'ada' } : undefined),
    },
  })(asked({ 'x-api-key': 'dummy', authorization: 'Bearer sk-ada' }));

  expect(host.caller).toEqual({ id: 'ada' });
  expect([...request.headers]).toEqual([]);
});

test('once the adapter knows the caller it is not asked about the next credential header', async () => {
  const tokens: string[] = [];
  const { host } = await hosting(echo(), {
    auth: {
      verify: (token) => {
        tokens.push(token);
        return { id: token };
      },
    },
  })(asked({ 'x-api-key': 'sk-ada', authorization: 'Bearer sk-eve' }));

  expect(host.caller).toEqual({ id: 'sk-ada' });
  expect(tokens).toEqual(['sk-ada']);
});

test('a caller the host gives is the caller, and the adapter is not asked', async () => {
  const tokens: string[] = [];
  const { host } = await hosting(echo(), {
    auth: {
      verify: (token) => {
        tokens.push(token);
        return { id: 'eve' };
      },
    },
  })({
    ...asked({ 'x-api-key': 'sk-eve', authorization: 'Bearer sk-eve' }),
    caller: { id: 'ada' },
  });

  expect(host.caller).toEqual({ id: 'ada' });
  expect(tokens).toEqual([]);
});

test('a caller the adapter answers with an empty id is no caller, and the next credential header is tried', async () => {
  const tokens: string[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: (token) => {
        tokens.push(token);
        return { id: token === 'sk-ada' ? 'ada' : '' };
      },
    },
  });

  const signed = await admit(
    asked({ 'x-api-key': 'sk-blank', authorization: 'Bearer sk-ada' }),
  );
  const blank = await admit(asked({ 'x-api-key': 'sk-blank' }));
  const unasked = await admit({
    headers: new Headers({ 'x-api-key': 'sk-blank' }),
    credentials: ['x-api-key'],
  });

  expect(signed.host.caller).toEqual({ id: 'ada' });
  expect(blank.host).not.toHaveProperty('caller');
  expect(unasked).toBeUndefined();
  expect(tokens).toEqual(['sk-blank', 'sk-ada', 'sk-blank', 'sk-blank']);
});

test('a caller the host gives with an empty id is refused before the adapter is asked or anything reported', async () => {
  const tokens: string[] = [];
  const reports: Report[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: (token) => {
        tokens.push(token);
        return { id: 'ada' };
      },
    },
    report: (report) => reports.push(report),
  });

  const refused = await admit({
    ...asked({ 'x-api-key': 'sk-ada' }),
    caller: { id: '' },
  }).catch((thrown: unknown) => thrown);
  const unasked = await admit({
    headers: new Headers({ 'x-api-key': 'sk-ada' }),
    credentials: ['x-api-key'],
    caller: { id: '' },
  }).catch((thrown: unknown) => thrown);

  expect(refused).toEqual(new Error('The caller the host gave has no id'));
  expect(unasked).toEqual(new Error('The caller the host gave has no id'));
  expect(tokens).toEqual([]);
  expect(reports).toEqual([]);
});

test('every credential header is removed when the host gives the caller, those of the other APIs too', async () => {
  const { request } = await hosting(echo(), {
    auth: { verify: () => ({ id: 'eve' }) },
  })({
    ...asked({
      'x-api-key': 'sk-ada',
      authorization: 'Bearer sk-ada',
      'api-key': 'sk-azure',
      'x-trace': 'trace-7',
    }),
    removed: ['api-key'],
    caller: { id: 'ada' },
  });

  expect([...request.headers]).toEqual([['x-trace', 'trace-7']]);
});

test.each([
  'sk-ada',
  'Basic sk-ada',
  'Token sk-ada',
  'Bearer sk-ada, Bearer sk-ada',
])(
  'a credential header that holds %p, which no token is read from, is removed when another header signed the caller in',
  async (written) => {
    const { request } = await hosting(echo(), {
      auth: { verify: () => ({ id: 'ada' }) },
    })(asked({ 'x-api-key': 'sk-ada', authorization: written }));

    expect([...request.headers]).toEqual([]);
  },
);

test('with no token read every credential header is removed, since one may hold a token written wrongly', async () => {
  const { request } = await hosting(echo(), {
    auth: { verify: () => ({ id: 'ada' }) },
  })(asked({ authorization: 'Basic sk-ada', 'x-trace': 'trace-7' }));

  expect([...request.headers]).toEqual([['x-trace', 'trace-7']]);
});

test('the adapter is given the token: a key header as it is, a bearer token without its scheme', async () => {
  const tokens: string[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: async (token) => {
        tokens.push(token);
        return undefined;
      },
    },
  });

  await admit(asked({ 'x-api-key': 'sk-key', authorization: 'Bearer sk-b' }));
  await admit(asked({ authorization: 'Bearer sk-bearer' }));
  await admit(asked({ authorization: 'bearer sk-lower' }));
  await admit(asked({ authorization: 'BEARER   sk-spaced==' }));
  await admit(asked({ 'x-api-key': '', authorization: 'Bearer sk-second' }));
  await admit({
    ...asked({ 'x-api-key': 'sk-not-read' }),
    credentials: ['authorization'],
  });

  expect(tokens).toEqual([
    'sk-key',
    'sk-b',
    'sk-bearer',
    'sk-lower',
    'sk-spaced==',
    'sk-second',
  ]);
});

test('with no token there is no caller and the adapter is not asked', async () => {
  const tokens: string[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: (token) => {
        tokens.push(token);
        return { id: 'ada' };
      },
    },
  });
  const twice = new Headers();
  twice.append('authorization', 'Bearer sk-ada');
  twice.append('authorization', 'Bearer sk-ada');

  const callers = [
    await admit(asked()),
    await admit(asked({ authorization: '' })),
    await admit(asked({ authorization: 'sk-ada' })),
    await admit(asked({ authorization: 'Bearer' })),
    await admit(asked({ authorization: 'Bearersk-ada' })),
    await admit(asked({ authorization: 'Basic sk-ada' })),
    await admit(asked({ authorization: 'Bearer sk-ada more' })),
    await admit(asked({ authorization: 'Bearer "sk-ada"' })),
    await admit(asked({ authorization: 'Bearer\tsk-ada' })),
    await admit(asked({ authorization: 'Bearer p@ss' })),
    await admit({ ...asked(), headers: twice }),
  ].map(({ host }) => host.caller);

  expect(callers).toEqual(Array.from({ length: 11 }, () => undefined));
  expect(tokens).toEqual([]);
});

test('what the auth adapter throws is thrown to the host', async () => {
  const admit = hosting(echo(), {
    auth: {
      verify: () => {
        throw new Error('The key set could not be read');
      },
    },
  });

  await expect(admit(asked({ 'x-api-key': 'sk-ada' }))).rejects.toThrow(
    'The key set could not be read',
  );
});

test("the storage is handed over with the motty's name ahead of every key", async () => {
  const keys: string[] = [];
  const { host } = await hosting(echo(), {
    storage: {
      get: async (key) => {
        keys.push(`get ${key}`);
        return 4;
      },
      set: async (key, value, options) => {
        keys.push(`set ${key} ${value} ${options?.ttl}`);
      },
      delete: async (key) => {
        keys.push(`delete ${key}`);
      },
    },
  })(asked());

  expect(await host.storage?.get('seen')).toBe(4);
  await host.storage?.set('seen', 5, { ttl: 60_000 });
  await host.storage?.delete('seen');

  expect(keys).toEqual([
    'get coder:seen',
    'set coder:seen 5 60000',
    'delete coder:seen',
  ]);
  expect((await hosting(echo(), {})(asked())).host.storage).toBeUndefined();
});

test('two motties with different names never reach one stored key, a colon or a percent sign in a name or not', async () => {
  const keys: string[] = [];
  const storage = {
    get: async () => undefined,
    set: async (key: string) => {
      keys.push(key);
    },
    delete: async () => {},
  };
  for (const { name, key } of [
    { name: 'a', key: 'b:x' },
    { name: 'a:b', key: 'x' },
    { name: 'a%3Ab', key: 'x' },
    { name: 'acme/coder', key: 'x' },
  ]) {
    const served = motty({ name }).handle(() => answer(''));
    const { host } = await hosting(served, { storage })(asked());
    await host.storage?.set(key, 1);
  }

  expect(keys).toEqual(['a:b:x', 'a%3Ab:x', 'a%253Ab:x', 'acme/coder:x']);
});

test("a namespace the host gives is ahead of every key in place of the motty's name, escaped as a name is", async () => {
  const keys: string[] = [];
  const { host } = await hosting(echo(), {
    namespace: 'acme:50%',
    storage: {
      get: async (key) => {
        keys.push(`get ${key}`);
        return undefined;
      },
      set: async (key) => {
        keys.push(`set ${key}`);
      },
      delete: async (key) => {
        keys.push(`delete ${key}`);
      },
      increment: async (key) => {
        keys.push(`increment ${key}`);
        return 1;
      },
    },
  })(asked());

  await host.storage?.get('seen');
  await host.storage?.set('seen', 5);
  await host.storage?.delete('seen');
  await host.storage?.increment?.('seen', 1);

  expect(keys).toEqual([
    'get acme%3A50%25:seen',
    'set acme%3A50%25:seen',
    'delete acme%3A50%25:seen',
    'increment acme%3A50%25:seen',
  ]);
});

test("a host given no namespace keeps the motty's name ahead of its keys, beside one that was given one", async () => {
  const keys: string[] = [];
  const storage = {
    get: async () => undefined,
    set: async (key: string) => {
      keys.push(key);
    },
    delete: async () => {},
  };
  const named = await hosting(echo(), { storage })(asked());
  const spaced = await hosting(echo(), { storage, namespace: 'acme' })(asked());

  await named.host.storage?.set('seen', 1);
  await spaced.host.storage?.set('seen', 1);

  expect(keys).toEqual(['coder:seen', 'acme:seen']);
});

test("an increment is handed over with the motty's name ahead of its key, and its result comes back", async () => {
  const added: unknown[] = [];
  const { host } = await hosting(echo(), {
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      increment: async (...given) => {
        added.push(given);
        return 7;
      },
    },
  })(asked());

  expect(await host.storage?.increment?.('spent', 2, { ttl: 60_000 })).toBe(7);
  expect(added).toEqual([['coder:spent', 2, { ttl: 60_000 }]]);
});

test('a storage that is an instance of a class is asked to increment as its own method', async () => {
  class Counters {
    total = 5;
    async get() {
      return this.total;
    }
    async set() {}
    async delete() {}
    async increment(_key: string, by: number) {
      this.total += by;
      return this.total;
    }
  }
  const { host } = await hosting(echo(), { storage: new Counters() })(asked());

  expect(await host.storage?.increment?.('spent', 2)).toBe(7);
});

test('a storage that cannot increment is handed over without increment', async () => {
  const { host } = await hosting(echo(), {
    storage: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    },
  })(asked());

  expect(host.storage?.increment).toBeUndefined();
});

test("the cost of a call that finished is the host's price for its model and usage, in place of the one the upstream reported", async () => {
  const priced: unknown[] = [];
  const upstream = stubHost({
    'acme/small': [
      { type: 'text', text: 'Use a mutex.' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 1000, output: 200, cost: 9 },
      },
    ],
  });
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, call: upstream.models }],
    price: (...given) => {
      priced.push(given);
      return 0.25;
    },
  })(asked());

  const events = await Array.fromAsync(
    host.models('acme/small', { messages: [] }, host.signal),
  );

  expect(events).toEqual([
    { type: 'text', text: 'Use a mutex.' },
    {
      type: 'finish',
      reason: 'stop',
      usage: { input: 1000, output: 200, cost: 0.25 },
    },
  ]);
  expect(priced).toEqual([
    ['acme/small', { input: 1000, output: 200, cost: 9 }],
  ]);
});

test('a call that failed with usage is priced too', async () => {
  const upstream = stubHost({
    'acme/small': [
      {
        type: 'error',
        error: { code: 'overloaded', status: 503, message: 'Busy' },
        usage: { input: 1000 },
      },
    ],
  });
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, call: upstream.models }],
    price: (_model, usage) => (usage.input ?? 0) / 1000,
  })(asked());

  const events = await Array.fromAsync(
    host.models('acme/small', { messages: [] }, host.signal),
  );

  expect(events).toEqual([
    {
      type: 'error',
      error: { code: 'overloaded', status: 503, message: 'Busy' },
      usage: { input: 1000, cost: 1 },
    },
  ]);
});

test("where the price returns nothing the upstream's cost stands", async () => {
  const upstream = stubHost({
    'acme/small': [
      { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
    ],
    'acme/free': [{ type: 'finish', reason: 'stop', usage: { input: 1000 } }],
  });
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, call: upstream.models }],
    price: () => undefined,
  })(asked());

  expect(
    await Array.fromAsync(
      host.models('acme/small', { messages: [] }, host.signal),
    ),
  ).toEqual([
    { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
  ]);
  expect(
    await Array.fromAsync(
      host.models('acme/free', { messages: [] }, host.signal),
    ),
  ).toEqual([{ type: 'finish', reason: 'stop', usage: { input: 1000 } }]);
});

test('a call that ended with no usage is left as it is, and no price is asked', async () => {
  const priced: string[] = [];
  const upstream = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, call: upstream.models }],
    price: (model) => {
      priced.push(model);
      return 0.25;
    },
  })(asked());

  expect(
    await Array.fromAsync(
      host.models('acme/small', { messages: [] }, host.signal),
    ),
  ).toEqual([{ type: 'finish', reason: 'stop' }]);
  expect(
    await Array.fromAsync(
      host.models('acme/missing', { messages: [] }, host.signal),
    ),
  ).toMatchObject([{ type: 'error', error: { code: 'unknown_model' } }]);
  expect(priced).toEqual([]);
});

test("a price that is no amount leaves the upstream's cost for the motty to count", async () => {
  const reports: Report[] = [];
  const upstream = stubHost({
    'acme/small': [
      { type: 'text', text: 'Use a mutex.' },
      { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
    ],
  });
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    model('acme/small').complete(prompt),
  );
  const { request, host } = await hosting(served, {
    models: [{ serves: () => true, call: upstream.models }],
    price: () => -1,
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(reports).toMatchObject([{ outcome: 'completed' }]);
  expect(reports[0]?.usage).toEqual({ input: 1000, cost: 9 });
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
  "a price of %p for a call is no amount, and the upstream's cost stands",
  async (figure) => {
    const upstream = stubHost({
      'acme/small': [
        { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
      ],
    });
    const { host } = await hosting(echo(), {
      models: [{ serves: () => true, call: upstream.models }],
      price: () => figure,
    })(asked());

    expect(
      await Array.fromAsync(
        host.models('acme/small', { messages: [] }, host.signal),
      ),
    ).toEqual([
      { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
    ]);
  },
);

test("a price that is a promise for a call is no amount, and the upstream's cost stands", async () => {
  const upstream = stubHost({
    'acme/small': [
      { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
    ],
  });
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, call: upstream.models }],
    // @ts-expect-error the price is asked for an amount, not a promise of one
    price: async () => 0.25,
  })(asked());

  expect(
    await Array.fromAsync(
      host.models('acme/small', { messages: [] }, host.signal),
    ),
  ).toEqual([
    { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
  ]);
});

test('a price that throws does not fail the call: what was spent is counted with no cost of the host, and the report holds the throw', async () => {
  const reports: Report[] = [];
  const upstream = stubHost({
    'acme/small': [
      { type: 'text', text: 'Use a mutex.' },
      { type: 'finish', reason: 'stop', usage: { input: 900, output: 400 } },
    ],
  });
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    model('acme/small').complete(prompt),
  );
  const { request, host } = await hosting(served, {
    models: [{ serves: () => true, call: upstream.models }],
    price: () => {
      throw new Error('No row in postgres://billing:hunter2@db');
    },
    report: (report) => reports.push(report),
  })(asked());

  const events = await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(events).toEqual([
    { type: 'text', text: 'Use a mutex.' },
    { type: 'finish', reason: 'stop', usage: { input: 900, output: 400 } },
  ]);
  expect(reports).toMatchObject([
    {
      outcome: 'completed',
      usage: { input: 900, output: 400 },
      calls: [{ model: 'acme/small', input: 900, output: 400 }],
      failed: [
        {
          service: 'price',
          error: { message: 'No row in postgres://billing:hunter2@db' },
        },
      ],
    },
  ]);
  expect(reports[0]?.calls[0]).not.toHaveProperty('code');
  expect(reports[0]?.usage).not.toHaveProperty('cost');
});

test("a price that throws leaves a decision's output as the adapter gave it, and the report holds the throw", async () => {
  const reports: Report[] = [];
  const served = motty({ name: 'coder' }).handle(async () =>
    answer(
      JSON.stringify(
        await hosted().decisions?.('typesafe/jev', {}, hosted().signal),
      ),
    ),
  );
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: () => true,
        decide: async () => ({
          answers: {},
          usage: { input_tokens: 40, output_tokens: 2 },
        }),
      },
    ],
    price: () => {
      throw new Error('No row in postgres://billing:hunter2@db');
    },
    report: (report) => reports.push(report),
  })(asked());

  const events = await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(events[0]).toEqual({
    type: 'text',
    text: '{"answers":{},"usage":{"input_tokens":40,"output_tokens":2}}',
  });
  expect(reports[0]?.failed).toMatchObject([
    {
      service: 'price',
      error: { message: 'No row in postgres://billing:hunter2@db' },
    },
  ]);
});

test("the usage a decision call reported is priced under the counts' own names, and the cost is put beside what it reported", async () => {
  const priced: unknown[] = [];
  const { host } = await hosting(echo(), {
    models: [
      {
        serves: () => true,
        decide: async () => ({
          answers: { software: { type: 'noul', noul: 0.97 } },
          usage: { input_tokens: 41, output_tokens: 1, cost: 9 },
        }),
      },
    ],
    price: (...given) => {
      priced.push(given);
      return 0.002;
    },
  })(asked());

  expect(await host.decisions?.('typesafe/jev', {}, host.signal)).toEqual({
    answers: { software: { type: 'noul', noul: 0.97 } },
    usage: { input_tokens: 41, output_tokens: 1, cost: 0.002 },
  });
  expect(priced).toEqual([['typesafe/jev', { input: 41, output: 1, cost: 9 }]]);
});

test("where the price returns nothing a decision's output is passed on as it is", async () => {
  const output = {
    answers: {},
    usage: { input_tokens: 41, output_tokens: 1, cost: 9 },
  };
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, decide: async () => output }],
    price: () => undefined,
  })(asked());

  expect(await host.decisions?.('typesafe/jev', {}, host.signal)).toBe(output);
});

test.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
  'a price of %p for a decision is no amount, and its output is passed on as it is',
  async (figure) => {
    const output = {
      answers: {},
      usage: { input_tokens: 41, output_tokens: 1, cost: 9 },
    };
    const { host } = await hosting(echo(), {
      models: [{ serves: () => true, decide: async () => output }],
      price: () => figure,
    })(asked());

    expect(await host.decisions?.('typesafe/jev', {}, host.signal)).toBe(
      output,
    );
  },
);

test('a price that is a promise for a decision is no amount, and its output is passed on as it is', async () => {
  const output = {
    answers: {},
    usage: { input_tokens: 41, output_tokens: 1, cost: 9 },
  };
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, decide: async () => output }],
    // @ts-expect-error the price is asked for an amount, not a promise of one
    price: async () => 0.002,
  })(asked());

  expect(await host.decisions?.('typesafe/jev', {}, host.signal)).toBe(output);
});

test.each([{ answers: {} }, { answers: {}, usage: 'none' }, 'no output', null])(
  'a decision that reported no usage is passed on as it is, and no price is asked: %p',
  async (output) => {
    const priced: string[] = [];
    const { host } = await hosting(echo(), {
      models: [{ serves: () => true, decide: async () => output }],
      price: (model) => {
        priced.push(model);
        return 0.002;
      },
    })(asked());

    expect(await host.decisions?.('typesafe/jev', {}, host.signal)).toBe(
      output,
    );
    expect(priced).toEqual([]);
  },
);

test('with no price the calls are the adapters own, cost and all', async () => {
  const upstream = stubHost({
    'acme/small': [
      { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
    ],
  });
  const { host } = await hosting(echo(), {
    models: [{ serves: () => true, call: upstream.models }],
  })(asked());

  expect(
    await Array.fromAsync(
      host.models('acme/small', { messages: [] }, host.signal),
    ),
  ).toEqual([
    { type: 'finish', reason: 'stop', usage: { input: 1000, cost: 9 } },
  ]);
});

test('the duration is kept by the host as a stop that says timed out, and the rest of the limits go to the motty', async () => {
  const { host } = await hosting(echo(), {
    limits: { duration: 10, calls: 3, afterResponse: 20 },
  })(asked());

  expect(host.limits).toEqual({ calls: 3, afterResponse: 20 });
  expect(host.signal.aborted).toBe(false);
  await Bun.sleep(30);
  expect(host.signal.reason).toMatchObject({ name: 'TimeoutError' });
});

test("the edge's body limit is kept out of the limits the motty reads, as the duration is", async () => {
  const { host } = await hosting(echo(), {
    limits: { body: 1024, calls: 3 },
  })(asked());

  expect(host.limits).toEqual({ calls: 3 });
});

test.each([
  [{ calls: 1.5 }, 'limits.calls must be a whole number'],
  [{ calls: -1 }, 'limits.calls must be a whole number'],
  [{ calls: Number.NaN }, 'limits.calls must be a whole number'],
  [{ body: 0.5 }, 'limits.body must be a whole number'],
  [{ body: Number.POSITIVE_INFINITY }, 'limits.body must be a whole number'],
  [{ duration: -1 }, 'limits.duration must be a finite number'],
  [{ duration: Number.NaN }, 'limits.duration must be a finite number'],
  [
    { duration: Number.POSITIVE_INFINITY },
    'limits.duration must be a finite number',
  ],
  [{ afterResponse: -1 }, 'limits.afterResponse must be a finite number'],
  [
    { afterResponse: Number.NaN },
    'limits.afterResponse must be a finite number',
  ],
])(
  'a limit that is no number of zero or more is refused when the host is made, by its name: %o',
  (limits, said) => {
    expect(() => hosting(echo(), { limits })).toThrow(
      `${said} of zero or more`,
    );
  },
);

test('a limit of zero, and a time limit of part of a millisecond, are taken when the host is made', async () => {
  const { host } = await hosting(echo(), {
    limits: { calls: 0, body: 0, duration: 0.5, afterResponse: 0.5 },
  })(asked());

  expect(host.limits).toEqual({ calls: 0, afterResponse: 0.5 });
});

test("the stop follows the caller's own signal, and is fired with the host's reason", async () => {
  const leaving = new AbortController();
  const admit = hosting(echo(), {});
  const left = await admit({ ...asked(), signal: leaving.signal });
  const stopped = await admit(asked());
  const untouched = await admit(asked());
  const reason = new Overloaded('The server is shutting down');

  leaving.abort();
  stopped.stop(reason);

  expect(left.host.signal.aborted).toBe(true);
  expect(stopped.host.signal.reason).toBe(reason);
  expect(untouched.host.signal.aborted).toBe(false);
});

test('each request gets its own id, and the report is the record with that id and the overrides in effect', async () => {
  const order: string[] = [];
  const reports: Report[] = [];
  const served = echo();
  const admit = hosting(served, {
    settings: { tiers: { deepProbability: 0.5 } },
    report: (report) => {
      order.push('report');
      reports.push(report);
    },
  });
  const first = await admit({ ...asked(), over: () => order.push('over') });
  const second = await admit(asked());

  await Array.fromAsync(contractOf(served).run(first.request, first.host));
  await Array.fromAsync(contractOf(served).run(second.request, second.host));
  await Bun.sleep(0);

  expect(first.request.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.request.id).not.toBe(first.request.id);
  expect(order).toEqual(['over', 'report', 'report']);
  expect(reports).toMatchObject([
    {
      id: first.request.id,
      outcome: 'completed',
      settings: { tiers: { deepProbability: 0.5 } },
    },
    { id: second.request.id },
  ]);
  expect(first.host.settings).toEqual({ tiers: { deepProbability: 0.5 } });
});

test("an id the host gives is the request's, the report's and the one a models function is told", async () => {
  const reports: Report[] = [];
  const told: string[] = [];
  const served = echo();
  const { request, host } = await hosting(served, {
    models: (given) => {
      told.push(given.id);
      return [];
    },
    report: (report) => reports.push(report),
  })({ ...asked(), id: 'req_7.a~b-c' });

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(request.id).toBe('req_7.a~b-c');
  expect(told).toEqual(['req_7.a~b-c']);
  expect(reports.map(({ id }) => id)).toEqual(['req_7.a~b-c']);
});

test('an id as long as the host may give is taken', async () => {
  const { request } = await hosting(
    echo(),
    {},
  )({ ...asked(), id: 'a'.repeat(128) });

  expect(request.id).toBe('a'.repeat(128));
});

test.each(['', 'a b', 'a/b', 'req-7\n', 'r\u00e9q', 'a'.repeat(129)])(
  'an id of %p is not one the host may give, and the request is refused before the adapter is asked or anything reported',
  async (id) => {
    const tokens: string[] = [];
    const reports: Report[] = [];
    const works: Promise<void>[] = [];
    const admit = hosting(echo(), {
      auth: {
        verify: (token) => {
          tokens.push(token);
          return { id: 'ada' };
        },
      },
      report: (report) => reports.push(report),
    });

    const refused = await admit({
      ...asked({ 'x-api-key': 'sk-ada' }),
      id,
      delivered: (work) => works.push(work),
    }).catch((thrown: unknown) => thrown);
    const unasked = await admit({
      headers: new Headers({ 'x-api-key': 'sk-ada' }),
      credentials: ['x-api-key'],
      id,
    }).catch((thrown: unknown) => thrown);

    expect(refused).toEqual(
      new Error('The request id is not one the host may give'),
    );
    expect(unasked).toEqual(
      new Error('The request id is not one the host may give'),
    );
    expect(tokens).toEqual([]);
    expect(reports).toEqual([]);
    expect(works).toEqual([]);
  },
);

test('a request given no id gets its own, beside one whose id the host gave', async () => {
  const admit = hosting(echo(), {});

  const given = await admit({ ...asked(), id: 'req-7' });
  const first = await admit(asked());
  const second = await admit(asked());

  expect(given.request.id).toBe('req-7');
  expect(first.request.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.request.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.request.id).not.toBe(first.request.id);
});

test('what the edge left out of the reply is on the report, and a reply with nothing left out says nothing', async () => {
  const reports: Report[] = [];
  const served = echo();
  const admit = hosting(served, { report: (report) => reports.push(report) });
  const warnings = [
    { setting: 'citation', detail: 'This API has no form for a citation' },
  ];
  const first = await admit({ ...asked(), leftOut: () => warnings });
  const second = await admit({ ...asked(), leftOut: () => [] });

  await Array.fromAsync(contractOf(served).run(first.request, first.host));
  await Array.fromAsync(contractOf(served).run(second.request, second.host));
  await Bun.sleep(0);

  expect(reports[0]?.warnings).toEqual(warnings);
  expect(reports[1]).not.toHaveProperty('warnings');
});

test('with no overrides the motty is handed none and the report says none', async () => {
  const reports: Report[] = [];
  const served = echo();
  const { request, host } = await hosting(served, {
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect('settings' in host).toBe(false);
  expect(reports).toMatchObject([{ settings: {} }]);
});

test.each(['get', 'set', 'delete', 'increment'] as const)(
  'what the storage throws on %s reaches the motty as an SDK error that says only that storage failed, and the report holds the rest',
  async (method) => {
    const reports: Report[] = [];
    const caught: unknown[] = [];
    const served = motty({ name: 'coder' }).handle(async () => {
      const { storage } = hosted();
      await storage?.[method]?.('seen', 1).catch((thrown: unknown) => {
        caught.push(thrown);
      });
      return answer('Use a mutex.');
    });
    const broken = () => {
      throw new Error('redis://:hunter2@db refused', {
        cause: new Error('ECONNREFUSED hunter2'),
      });
    };
    const { request, host } = await hosting(served, {
      storage: { get: broken, set: broken, delete: broken, increment: broken },
      report: (report) => reports.push(report),
    })(asked());

    await Array.fromAsync(contractOf(served).run(request, host));
    await Bun.sleep(0);

    expect(caught).toEqual([new MottyError("The host's storage failed")]);
    expect(caught[0]).toBeInstanceOf(MottyError);
    expect(Bun.inspect(caught[0])).not.toContain('hunter2');
    expect(reports).toMatchObject([
      {
        outcome: 'completed',
        failed: [
          {
            service: 'storage',
            error: {
              message: 'redis://:hunter2@db refused',
              stack: expect.stringContaining('redis://:hunter2@db refused'),
              cause: 'ECONNREFUSED hunter2',
            },
          },
        ],
      },
    ]);
  },
);

test('an SDK error the storage raised reaches the motty as it is', async () => {
  const raised = new Overloaded('The storage is busy');
  const { host } = await hosting(echo(), {
    storage: {
      get: () => Promise.reject(raised),
      set: async () => {},
      delete: async () => {},
    },
  })(asked());

  expect(await host.storage?.get('seen').catch((thrown) => thrown)).toBe(
    raised,
  );
});

test.each(['AbortError', 'TimeoutError'])(
  "a platform %s of the storage's own, the request not stopped, is a failure of the storage like any other, and the report holds it",
  async (name) => {
    const reports: Report[] = [];
    const caught: unknown[] = [];
    const served = motty({ name: 'coder' }).handle(async () => {
      await hosted()
        .storage?.get('seen')
        .catch((thrown: unknown) => {
          caught.push(thrown);
        });
      return answer('Use a mutex.');
    });
    const { request, host } = await hosting(served, {
      storage: {
        get: () =>
          Promise.reject(new DOMException('redis://:hunter2@db gave up', name)),
        set: async () => {},
        delete: async () => {},
      },
      report: (report) => reports.push(report),
    })(asked());

    await Array.fromAsync(contractOf(served).run(request, host));
    await Bun.sleep(0);

    expect(caught).toEqual([new MottyError("The host's storage failed")]);
    expect(caught[0]).toMatchObject({ code: 'internal', retryable: false });
    expect(reports[0]?.failed).toMatchObject([
      {
        service: 'storage',
        error: { code: 'internal', message: 'redis://:hunter2@db gave up' },
      },
    ]);
  },
);

test('a stop the storage threw once the request was stopped is told as a stop, in the words of the SDK, and is no failure on the report', async () => {
  const reports: Report[] = [];
  const caught: unknown[] = [];
  const served = motty({ name: 'coder' }).handle(async () => {
    admitted.stop();
    await hosted()
      .storage?.get('seen')
      .catch((thrown: unknown) => {
        caught.push(thrown);
      });
    return answer('Use a mutex.');
  });
  const admitted = await hosting(served, {
    storage: {
      get: () =>
        Promise.reject(new DOMException('key sk-live gave up', 'AbortError')),
      set: async () => {},
      delete: async () => {},
    },
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(
    contractOf(served).run(admitted.request, admitted.host),
  );
  await Bun.sleep(0);

  expect(caught).toEqual([new Aborted('The work was stopped')]);
  expect(reports).toMatchObject([{ outcome: 'aborted' }]);
  expect(reports[0]).not.toHaveProperty('failed');
});

test.each(['AbortError', 'TimeoutError'])(
  "a platform %s of a decision adapter's own, its call not stopped, is a failure of decisions, and the report holds it",
  async (name) => {
    const reports: Report[] = [];
    const caught: unknown[] = [];
    const served = motty({ name: 'coder' }).handle(async () => {
      await hosted()
        .decisions?.('typesafe/jev', {}, hosted().signal)
        .catch((thrown: unknown) => {
          caught.push(thrown);
        });
      return answer('Use a mutex.');
    });
    const { request, host } = await hosting(served, {
      models: [
        {
          serves: () => true,
          decide: () =>
            Promise.reject(new DOMException('key ts-live gave up', name)),
        },
      ],
      report: (report) => reports.push(report),
    })(asked());

    await Array.fromAsync(contractOf(served).run(request, host));
    await Bun.sleep(0);

    expect(caught).toEqual([new MottyError("The host's decisions failed")]);
    expect(reports[0]?.failed).toMatchObject([
      { service: 'decisions', error: { message: 'key ts-live gave up' } },
    ]);
  },
);

test('what a decision adapter throws once its call was stopped is told as the stop, and is no failure on the report', async () => {
  const reports: Report[] = [];
  const caught: unknown[] = [];
  const served = motty({ name: 'coder' }).handle(async () => {
    const cut = new AbortController();
    cut.abort();
    await hosted()
      .decisions?.('typesafe/jev', {}, cut.signal)
      .catch((thrown: unknown) => {
        caught.push(thrown);
      });
    return answer('Use a mutex.');
  });
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: () => true,
        decide: () => Promise.reject(new Error('socket of ts-live closed')),
      },
    ],
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(caught).toEqual([new Aborted('The work was stopped')]);
  expect(reports[0]).not.toHaveProperty('failed');
});

test('what a decision adapter throws reaches the motty as an SDK error that says only that decisions failed, and the report holds the rest', async () => {
  const reports: Report[] = [];
  const caught: unknown[] = [];
  const served = motty({ name: 'coder' }).handle(async () => {
    await hosted()
      .decisions?.('typesafe/jev', {}, hosted().signal)
      .catch((thrown: unknown) => {
        caught.push(thrown);
      });
    return answer('Use a mutex.');
  });
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: () => true,
        decide: () => {
          throw new TypeError('key ts-live is not a header value');
        },
      },
    ],
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(caught).toEqual([new MottyError("The host's decisions failed")]);
  expect(Bun.inspect(caught[0])).not.toContain('ts-live');
  expect(reports[0]?.failed).toMatchObject([
    {
      service: 'decisions',
      error: { message: 'key ts-live is not a header value' },
    },
  ]);
});

test.each([
  [
    'throws when called',
    (): EventStream => {
      throw new TypeError('key sk-live is not a header value');
    },
    [],
  ],
  [
    'throws on its first read',
    (): EventStream => ({
      [Symbol.asyncIterator]: () => ({
        next: () =>
          Promise.reject(new TypeError('key sk-live is not a header value')),
      }),
    }),
    [],
  ],
  [
    'throws from its first read before it returns a promise',
    (): EventStream => ({
      [Symbol.asyncIterator]: () => ({
        next: () => {
          throw new TypeError('key sk-live is not a header value');
        },
      }),
    }),
    [],
  ],
  [
    'throws mid-stream',
    async function* (): EventStream {
      yield { type: 'text', text: 'Half' };
      throw new TypeError('key sk-live is not a header value');
    },
    [{ type: 'text', text: 'Half' }],
  ],
])(
  'a model adapter that %s fails the call as an SDK error that names the model and nothing thrown, and the report holds the rest',
  async (_when, call, read) => {
    const reports: Report[] = [];
    const served = motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete(prompt),
    );
    const { request, host } = await hosting(served, {
      models: [{ serves: () => true, call }],
      report: (report) => reports.push(report),
    })(asked());

    const events = await Array.fromAsync(contractOf(served).run(request, host));
    await Bun.sleep(0);

    expect(JSON.stringify(events)).not.toContain('sk-live');
    expect(events).toMatchObject([
      ...read,
      {
        type: 'error',
        error: { code: 'internal', message: 'Internal error' },
      },
    ]);
    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'internal',
          status: 500,
          message: 'The model call to acme/small failed',
          retryable: false,
          upstream: true,
          unexpected: true,
        },
        calls: [
          {
            model: 'acme/small',
            code: 'internal',
            message: 'The model call to acme/small failed',
          },
        ],
        failed: [
          {
            service: 'models',
            error: {
              message: 'key sk-live is not a header value',
              stack: expect.stringContaining('TypeError'),
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(reports[0]?.error)).not.toContain('sk-live');
  },
);

test.each(['AbortError', 'TimeoutError'])(
  "a platform %s of a model adapter's own, its call not stopped, fails the call like anything else it throws, and the report holds it",
  async (name) => {
    const reports: Report[] = [];
    const served = motty({ name: 'coder' }).handle(({ prompt }) =>
      model('acme/small').complete(prompt),
    );
    const { request, host } = await hosting(served, {
      models: [
        {
          serves: () => true,
          call: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () =>
                Promise.reject(new DOMException('key sk-live gave up', name)),
            }),
          }),
        },
      ],
      report: (report) => reports.push(report),
    })(asked());

    await Array.fromAsync(contractOf(served).run(request, host));
    await Bun.sleep(0);

    expect(reports).toMatchObject([
      {
        outcome: 'failed',
        error: {
          code: 'internal',
          message: 'The model call to acme/small failed',
          retryable: false,
        },
        failed: [
          {
            service: 'models',
            error: { code: 'internal', message: 'key sk-live gave up' },
          },
        ],
      },
    ]);
  },
);

test('a model call a throwing adapter failed is not retried, and a fallback moves on from it', async () => {
  const called: string[] = [];
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    fallback(retry(model('acme/broken'), 2), model('acme/small')).complete(
      prompt,
    ),
  );
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: () => true,
        call: async function* (name) {
          called.push(name);
          if (name === 'acme/broken') throw new TypeError('key sk-live');
          yield { type: 'text', text: 'Use a mutex.' };
          yield { type: 'finish', reason: 'stop' };
        },
      },
    ],
  })(asked());

  const events = await Array.fromAsync(contractOf(served).run(request, host));

  expect(called).toEqual(['acme/broken', 'acme/small']);
  expect(events).toMatchObject([
    { type: 'text', text: 'Use a mutex.' },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('an SDK error a model adapter throws mid-stream ends the stream as it is, and is no failure on the report', async () => {
  const reports: Report[] = [];
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    model('acme/small').complete(prompt),
  );
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: () => true,
        call: async function* () {
          yield { type: 'text', text: 'Half' };
          throw new Overloaded('Too busy', { retryAfter: 30 });
        },
      },
    ],
    report: (report) => reports.push(report),
  })(asked());

  const events = await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(events.at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'overloaded', message: 'Too busy', retryAfter: 30 },
  });
  expect(reports[0]).not.toHaveProperty('failed');
});

test('a model adapter that throws as its request is stopped ends the request as stopped, and is no failure on the report', async () => {
  const reports: Report[] = [];
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    model('acme/small').complete(prompt),
  );
  const admitted = await hosting(served, {
    models: [
      {
        serves: () => true,
        call: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => {
              admitted.stop();
              return Promise.reject(
                new DOMException('key sk-live gave up', 'AbortError'),
              );
            },
          }),
        }),
      },
    ],
    report: (report) => reports.push(report),
  })(asked());

  const events = await Array.fromAsync(
    contractOf(served).run(admitted.request, admitted.host),
  );
  await Bun.sleep(0);

  expect(JSON.stringify(events)).not.toContain('sk-live');
  expect(reports).toMatchObject([{ outcome: 'aborted' }]);
  expect(reports[0]).not.toHaveProperty('failed');
});

test('a race loser whose read fails once it was cut is no failure on the report, however soon after the cut it fails', async () => {
  const reports: Report[] = [];
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    race(model('acme/slow'), model('acme/small')).complete(prompt),
  );
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: (name) => name === 'acme/slow',
        call: (_name, _prompt, signal) => ({
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise((_resolve, reject) => {
                signal.addEventListener('abort', () =>
                  reject(new Error('socket of sk-live hung up')),
                );
              }),
          }),
        }),
      },
      {
        serves: () => true,
        call: async function* () {
          yield { type: 'text', text: 'Use a mutex.' };
          await Bun.sleep(5);
          yield { type: 'finish', reason: 'stop' };
        },
      },
    ],
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(5);

  expect(reports).toMatchObject([
    {
      outcome: 'completed',
      calls: [{ model: 'acme/slow', code: 'aborted' }, { model: 'acme/small' }],
    },
  ]);
  expect(reports[0]).not.toHaveProperty('failed');
});

test('a race loser whose read had failed before the other won is a failure on the report', async () => {
  const reports: Report[] = [];
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    race(model('acme/slow'), model('acme/small')).complete(prompt),
  );
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: (name) => name === 'acme/slow',
        call: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.reject(new Error('socket of sk-live hung up')),
          }),
        }),
      },
      {
        serves: () => true,
        call: async function* () {
          await Bun.sleep(5);
          yield { type: 'text', text: 'Use a mutex.' };
          yield { type: 'finish', reason: 'stop' };
        },
      },
    ],
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(reports[0]?.failed).toMatchObject([
    { service: 'models', error: { message: 'socket of sk-live hung up' } },
  ]);
});

test('a read that fails once the stream was closed with its call not cut is no failure on the report', async () => {
  const reports: Report[] = [];
  const failing = Promise.withResolvers<never>();
  const served = motty({ name: 'coder' }).handle(() => answer('Use a mutex.'));
  const { request, host } = await hosting(served, {
    models: [
      {
        serves: () => true,
        call: () => ({
          [Symbol.asyncIterator]: () => ({ next: () => failing.promise }),
        }),
      },
    ],
    report: (report) => reports.push(report),
  })(asked());
  const events = host
    .models('acme/small', { messages: [] }, host.signal)
    [Symbol.asyncIterator]();
  events.next().catch(() => {});
  await events.return?.();
  await Bun.sleep(0);
  failing.reject(new Error('socket of sk-live hung up'));

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(reports[0]).not.toHaveProperty('failed');
});

test('the stream of a model adapter is closed through the one the motty was handed', async () => {
  let closed = 0;
  const { host } = await hosting(echo(), {
    models: [
      {
        serves: () => true,
        call: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({
              done: false,
              value: { type: 'text', text: 'Half' },
            }),
            return: async () => {
              closed += 1;
              return { done: true, value: undefined };
            },
          }),
        }),
      },
    ],
  })(asked());

  const events = host
    .models('acme/small', { messages: [] }, host.signal)
    [Symbol.asyncIterator]();
  await events.next();
  await events.return?.();

  expect(closed).toBe(1);
});

test('what the auth adapter throws that is no SDK error is reported as a request that failed before the motty ran', async () => {
  const reports: Report[] = [];
  const admit = hosting(echo(), {
    settings: { tiers: { deep: 0.5 } },
    auth: {
      verify: () => {
        throw new Error('https://issuer.test/keys?secret=hunter2 timed out');
      },
    },
    report: (report) => reports.push(report),
  });

  await expect(admit(asked({ 'x-api-key': 'sk-ada' }))).rejects.toThrow(
    'https://issuer.test/keys?secret=hunter2 timed out',
  );

  expect(reports).toEqual([
    {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      settings: { tiers: { deep: 0.5 } },
      outcome: 'failed',
      error: {
        code: 'internal',
        status: 500,
        message: "The host's auth failed",
        retryable: false,
      },
      path: [],
      entries: [],
      calls: [],
      usage: {},
      time: { answer: 0, total: 0 },
      afterResponse: { failed: [], skipped: [], unreached: [] },
      failed: [
        {
          service: 'auth',
          error: expect.objectContaining({
            message: 'https://issuer.test/keys?secret=hunter2 timed out',
            stack: expect.stringContaining('hunter2'),
          }),
        },
      ],
    },
  ]);
});

test('an SDK error the auth adapter throws refuses the request with no report', async () => {
  const reports: Report[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: () => {
        throw new Overloaded('The key set is being rotated');
      },
    },
    report: (report) => reports.push(report),
  });

  await expect(admit(asked({ 'x-api-key': 'sk-ada' }))).rejects.toThrow(
    'The key set is being rotated',
  );

  expect(reports).toEqual([]);
});

test('whoever asked is told the id of the report made when the auth adapter threw, and nothing when an SDK error made no report', async () => {
  const reports: Report[] = [];
  const told: string[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: (token) => {
        throw token === 'sk-ada'
          ? new Error('The key set is gone')
          : new Overloaded('The key set is being rotated');
      },
    },
    report: (report) => reports.push(report),
  });

  await expect(
    admit({
      ...asked({ 'x-api-key': 'sk-eve' }),
      reported: (id) => told.push(id),
    }),
  ).rejects.toThrow('The key set is being rotated');
  await expect(
    admit({
      ...asked({ 'x-api-key': 'sk-ada' }),
      reported: (id) => told.push(id),
    }),
  ).rejects.toThrow('The key set is gone');

  expect(reports).toHaveLength(1);
  expect(told).toEqual(reports.map(({ id }) => id));
});

test('the report made when the auth adapter threw carries the id the host gave, and whoever asked is told it', async () => {
  const reports: Report[] = [];
  const told: string[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: () => {
        throw new Error('The key set is gone');
      },
    },
    report: (report) => reports.push(report),
  });

  await expect(
    admit({
      ...asked({ 'x-api-key': 'sk-ada' }),
      id: 'req-7',
      reported: (id) => told.push(id),
    }),
  ).rejects.toThrow('The key set is gone');

  expect(reports.map(({ id }) => id)).toEqual(['req-7']);
  expect(told).toEqual(['req-7']);
});

test('whoever asked is handed, once, the work of the report made when the auth adapter threw, and none when an SDK error made no report', async () => {
  const order: string[] = [];
  const works: Promise<void>[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: (token) => {
        throw token === 'sk-ada'
          ? new Error('The key set is gone')
          : new Overloaded('The key set is being rotated');
      },
    },
    report: async () => {
      await Bun.sleep(0);
      order.push('report');
    },
  });

  await expect(
    admit({
      ...asked({ 'x-api-key': 'sk-eve' }),
      delivered: (work) => works.push(work),
    }),
  ).rejects.toThrow('The key set is being rotated');
  await expect(
    admit({
      headers: new Headers({ 'x-api-key': 'sk-ada' }),
      credentials: ['x-api-key'],
      delivered: (work) => works.push(work),
    }),
  ).rejects.toThrow('The key set is gone');

  expect(works).toHaveLength(1);
  expect(order).toEqual([]);
  await works[0];
  expect(order).toEqual(['report']);
});

test('a request in which no service of the host threw has no failures on its report', async () => {
  const reports: Report[] = [];
  const served = echo();
  const { request, host } = await hosting(served, {
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(reports[0]).not.toHaveProperty('failed');
});

test("whoever asked is handed work that ends only once the report's own has, after the request is over", async () => {
  const order: string[] = [];
  const works: Promise<void>[] = [];
  const held = Promise.withResolvers<void>();
  const served = echo();
  const { request, host } = await hosting(served, {
    report: async () => {
      order.push('report');
      await held.promise;
    },
  })({
    ...asked(),
    over: () => order.push('over'),
    delivered: (work) => {
      order.push('delivered');
      works.push(work);
    },
  });

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);
  works[0]?.then(() => order.push('ended'));
  await Bun.sleep(0);

  expect(works).toHaveLength(1);
  expect(order).toEqual(['over', 'report', 'delivered']);
  held.resolve();
  await works[0];
  expect(order).toEqual(['over', 'report', 'delivered', 'ended']);
});

test.each([
  {
    how: 'rejects',
    report: async () => {
      throw new Error('The log is full');
    },
  },
  {
    how: 'throws',
    report: () => {
      throw new Error('The log is full');
    },
  },
])(
  'a report that $how still ends the work it is handed over as, and leaves no rejection unhandled',
  async ({ report }) => {
    const unhandled: unknown[] = [];
    const seen = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', seen);
    const works: Promise<void>[] = [];
    const served = echo();
    const { request, host } = await hosting(served, { report })({
      ...asked(),
      delivered: (work) => works.push(work),
    });

    const events = await Array.fromAsync(contractOf(served).run(request, host));
    await Bun.sleep(0);
    const ended = await works[0];
    await Bun.sleep(0);
    process.off('unhandledRejection', seen);

    expect(works).toHaveLength(1);
    expect(ended).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
    expect(unhandled).toEqual([]);
  },
);

test('a host with no report still hands over work, which has ended', async () => {
  const works: Promise<void>[] = [];
  const served = echo();
  const { request, host } = await hosting(
    served,
    {},
  )({ ...asked(), delivered: (work) => works.push(work) });

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(works).toHaveLength(1);
  expect(await works[0]).toBeUndefined();
});

test('what one request writes into the overrides, the limits or its caller is refused, and the next request reads them as the host gave them', async () => {
  const given = { tiers: { deep: 0.5, models: ['acme/big'] } };
  const known = { id: 'ada' };
  const admit = hosting(echo(), {
    settings: given,
    limits: { calls: 3 },
    auth: { verify: () => known },
  });
  const first = await admit(asked({ 'x-api-key': 'sk-ada' }));
  const { tiers } = first.host.settings ?? {};

  expect(() =>
    Object.assign(Object(first.host.settings), { planted: 1 }),
  ).toThrow();
  expect(() => Object.assign(Object(tiers), { deep: 1 })).toThrow();
  expect(() => Object(Object(tiers).models).push('acme/huge')).toThrow();
  expect(() =>
    Object.assign(Object(first.host.limits), { calls: 99 }),
  ).toThrow();
  expect(() =>
    Object.assign(Object(first.host.caller), { id: 'eve' }),
  ).toThrow();

  const second = await admit(asked({ 'x-api-key': 'sk-ada' }));
  expect(second.host.settings).toEqual({
    tiers: { deep: 0.5, models: ['acme/big'] },
  });
  expect(second.host.limits).toEqual({ calls: 3 });
  expect(second.host.caller).toEqual({ id: 'ada' });
});

test("the host's own overrides and the caller its adapter keeps are left as they were, not frozen", async () => {
  const given = { tiers: { deep: 0.5 } };
  const known = { id: 'ada' };
  const { host } = await hosting(echo(), {
    settings: given,
    auth: { verify: () => known },
  })(asked({ 'x-api-key': 'sk-ada' }));

  given.tiers.deep = 0.9;
  known.id = 'eve';

  expect(host.settings).toEqual({ tiers: { deep: 0.5 } });
  expect(host.caller).toEqual({ id: 'ada' });
});

test('the storage of one request is not the object of the next', async () => {
  const admit = hosting(echo(), {
    storage: {
      get: async () => 4,
      set: async () => {},
      delete: async () => {},
    },
  });
  const first = await admit(asked());
  Object.assign(Object(first.host.storage), { get: async () => 'planted' });

  expect(await (await admit(asked())).host.storage?.get('seen')).toBe(4);
});

test('models given as a function are asked for once per request, with the request as the host holds it and the caller', async () => {
  const given: unknown[] = [];
  const upstream = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });
  const admit = hosting(echo(), {
    auth: { verify: () => ({ id: 'ada' }) },
    models: (request, caller) => {
      given.push([request.id, request.model, [...request.headers], caller]);
      return [{ serves: () => true, call: upstream.models }];
    },
  });

  const first = await admit(
    asked({ 'x-api-key': 'sk-ada', 'x-trace': 'trace-7' }),
  );
  const second = await admit(asked());
  await Array.fromAsync(
    first.host.models('acme/small', { messages: [] }, first.host.signal),
  );
  await Array.fromAsync(
    first.host.models('acme/small', { messages: [] }, first.host.signal),
  );

  expect(given).toEqual([
    [
      first.request.id,
      'motty/coder',
      [
        ['x-api-key', 'sk-ada'],
        ['x-trace', 'trace-7'],
      ],
      { id: 'ada' },
    ],
    [second.request.id, 'motty/coder', [], undefined],
  ]);
  expect(upstream.sent('acme/small')).toHaveLength(2);
});

test('given the headers and no request, the host says only who the caller is: no models are asked for, and what the adapter throws is reported', async () => {
  const reports: Report[] = [];
  const told: string[] = [];
  let models = 0;
  const admit = hosting(echo(), {
    auth: {
      verify: (token) => {
        if (token === 'sk-broken') throw new Error('The key set is gone');
        return token === 'sk-ada' ? { id: 'ada' } : undefined;
      },
    },
    models: () => {
      models += 1;
      return [];
    },
    limits: { duration: 10 },
    report: (report) => reports.push(report),
  });

  expect(
    await admit({
      headers: new Headers({ authorization: 'Bearer sk-ada' }),
      credentials: ['x-api-key', 'authorization'],
    }),
  ).toEqual({ id: 'ada' });
  expect(
    await admit({
      headers: new Headers({ 'x-api-key': 'sk-eve' }),
      credentials: ['x-api-key', 'authorization'],
    }),
  ).toBeUndefined();
  await expect(
    admit({
      headers: new Headers({ 'x-api-key': 'sk-broken' }),
      credentials: ['x-api-key', 'authorization'],
      reported: (id) => told.push(id),
    }),
  ).rejects.toThrow('The key set is gone');

  expect(models).toBe(0);
  expect(reports).toMatchObject([
    { outcome: 'failed', failed: [{ service: 'auth' }] },
  ]);
  expect(told).toEqual(reports.map(({ id }) => id));
});

test('given the headers and a caller, the host says that caller and the adapter is not asked', async () => {
  const tokens: string[] = [];
  const admit = hosting(echo(), {
    auth: {
      verify: (token) => {
        tokens.push(token);
        return { id: 'eve' };
      },
    },
  });

  expect(
    await admit({
      headers: new Headers({ authorization: 'Bearer sk-eve' }),
      credentials: ['x-api-key', 'authorization'],
      caller: { id: 'ada' },
    }),
  ).toEqual({ id: 'ada' });
  expect(tokens).toEqual([]);
});

test('models given as a promise of the list are waited for', async () => {
  const upstream = stubHost({
    'acme/small': [{ type: 'finish', reason: 'stop' }],
  });
  const { host } = await hosting(echo(), {
    models: async () => {
      await Bun.sleep(1);
      return [{ serves: () => true, call: upstream.models }];
    },
  })(asked());

  expect(
    await Array.fromAsync(
      host.models('acme/small', { messages: [] }, host.signal),
    ),
  ).toEqual([{ type: 'finish', reason: 'stop' }]);
});

test("what the models function throws fails the request's calls as an SDK error that says only that models failed, and the report holds the rest", async () => {
  const reports: Report[] = [];
  const caught: unknown[] = [];
  const served = motty({ name: 'coder' }).handle(async ({ prompt }) => {
    await model('acme/small')
      .complete(prompt)
      .catch((thrown: unknown) => {
        caught.push(thrown);
      });
    return answer('Use a mutex.');
  });
  const { request, host } = await hosting(served, {
    models: () => {
      throw new Error('The vault refused token hvs.hunter2');
    },
    report: (report) => reports.push(report),
  })(asked());

  await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(caught).toMatchObject([
    { code: 'internal', message: "The host's models failed" },
  ]);
  expect(caught[0]).not.toHaveProperty('upstream');
  expect(Bun.inspect(caught[0])).not.toContain('hunter2');
  await expect(
    host.decisions?.('typesafe/jev', {}, host.signal),
  ).rejects.toThrow("The host's models failed");
  expect(reports).toMatchObject([
    {
      outcome: 'completed',
      calls: [{ model: 'acme/small', code: 'internal' }],
      failed: [
        {
          service: 'models',
          error: { message: 'The vault refused token hvs.hunter2' },
        },
      ],
    },
  ]);
});

test("a timeout of the models function's own is a failure of models that no retry repeats, and the report holds it", async () => {
  const reports: Report[] = [];
  let asks = 0;
  const served = motty({ name: 'coder' }).handle(({ prompt }) =>
    retry(model('acme/small'), 3).complete(prompt),
  );
  const { request, host } = await hosting(served, {
    models: () => {
      asks += 1;
      throw new DOMException(
        'https://keys.test/?token=hunter2 timed out',
        'TimeoutError',
      );
    },
    report: (report) => reports.push(report),
  })(asked());

  const events = await Array.fromAsync(contractOf(served).run(request, host));
  await Bun.sleep(0);

  expect(asks).toBe(1);
  expect(events).toMatchObject([
    { type: 'error', error: { code: 'internal', retryable: false } },
  ]);
  expect(reports).toMatchObject([
    {
      outcome: 'failed',
      error: { code: 'internal', message: "The host's models failed" },
      calls: [{ model: 'acme/small', code: 'internal' }],
      failed: [
        {
          service: 'models',
          error: { message: 'https://keys.test/?token=hunter2 timed out' },
        },
      ],
    },
  ]);
  expect(reports[0]?.calls).toHaveLength(1);
});

test.each([
  [
    'holds itself',
    () => {
      const tiers: { [name: string]: Json } = { deep: 0.5 };
      return Object.assign(tiers, { again: tiers });
    },
  ],
  ['holds a function', () => Object({ deep: 0.5, pick: () => 'sk-live' })],
])(
  'an override that %s fails when the options are read, named by its group and without its value',
  (_how, made) => {
    expect(() =>
      hosting(echo(), { settings: { limits: { calls: 3 }, tiers: made() } }),
    ).toThrow(new Error('The settings overrides of tiers are not plain data'));
  },
);

test('an override that holds one value in two places is copied, since nothing in it holds itself', async () => {
  const models = ['acme/big'];
  const { host } = await hosting(echo(), {
    settings: { tiers: { deep: models, standard: models } },
  })(asked());

  expect(host.settings).toEqual({
    tiers: { deep: ['acme/big'], standard: ['acme/big'] },
  });
});

test('the overrides are typed by the settings of the motty they are given with', () => {
  const tuned = motty({ name: 'coder' })
    .derive(() => ({ settings: { tiers: { deep: 0.5, model: 'acme/big' } } }))
    .handle(() => answer('Use a mutex.'));

  hosting(tuned, { settings: {} });
  hosting(tuned, { settings: { tiers: {} } });
  hosting(tuned, { settings: { tiers: { deep: 0.9 } } });
  // @ts-expect-error the motty declares no group of that name
  hosting(tuned, { settings: { tires: { deep: 0.9 } } });
  // @ts-expect-error the value is a number
  hosting(tuned, { settings: { tiers: { deep: 'often' } } });
  // @ts-expect-error the group has no such value
  hosting(tuned, { settings: { tiers: { depth: 0.9 } } });
  // A motty that declares no settings, or is held without its types, is
  // not checked: nothing says what its groups are.
  hosting(echo(), { settings: { anything: { goes: true } } });
  hosting({ [mark]: contractOf(tuned) }, { settings: { tires: 1 } });
});
