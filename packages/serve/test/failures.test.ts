import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { auth } from '@mottyjs/auth';
import { answer, model, motty } from '@mottyjs/core';
import type { ModelAdapter } from '@mottyjs/core/host';
import { settings } from '@mottyjs/settings';
import { store } from '@mottyjs/store';
import { fake, on } from '@mottyjs/test';
import { z } from 'zod';
import { mount } from '../src/index.ts';

const gpt = model('openai/gpt');

function ask(signal?: AbortSignal): Request {
  return new Request('http://motty.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'coder',
      messages: [{ role: 'user', content: 'Why does this deadlock?' }],
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

let stderr: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  stderr = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  stderr.mockRestore();
});

function lines(): string[] {
  return stderr.mock.calls.map(([line]) => String(line));
}

const throwing: ModelAdapter = {
  serves: () => true,
  call: () => {
    throw new TypeError('The adapter misread its stream');
  },
};

const breaking: ModelAdapter = {
  serves: () => true,
  // biome-ignore lint/correctness/useYield: it fails before its first event
  call: async function* () {
    throw new TypeError('The adapter misread its stream');
  },
};

test.each([
  [
    'a handle that returns no answer',
    motty({ name: 'coder' }).handle(
      // @ts-expect-error a handle returns an answer
      () => 42,
    ),
    {},
    'The handle of "coder" gave no answer',
  ],
  [
    'a TypeError in the motty',
    motty({ name: 'coder' }).handle(() => {
      throw new TypeError('settings.tier is not a function');
    }),
    {},
    'settings.tier is not a function',
  ],
  [
    'an adapter that throws',
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    { models: [throwing] },
    'The adapter misread its stream',
  ],
  [
    'an adapter whose stream throws',
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    { models: [breaking] },
    'The adapter misread its stream',
  ],
  [
    'a store with no storage',
    motty({ name: 'coder' }).handle(async () => {
      await store.get('seen');
      return answer('Hi');
    }),
    {},
    'the host supplied no storage',
  ],
] as const)(
  '%s is told to stderr in one line with the id of the reply, and the caller still reads the sealed message',
  async (_, served, options, real) => {
    const { fetch, close } = mount(served, () => options);

    const reply = await fetch(ask());
    await close();

    expect(reply.status).toBe(500);
    expect(await reply.json()).toMatchObject({
      error: { message: 'Internal error' },
    });
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain(real);
    expect(lines()[0]).toContain(String(reply.headers.get('x-request-id')));
    expect(lines()[0]).not.toContain('\n');
  },
);

test('a list of models that cannot be made is told by what was thrown, which the caller does not read', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    () => ({
      models: () => {
        throw new TypeError('The key service is gone');
      },
    }),
  );

  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(500);
  expect(await reply.text()).not.toContain('The key service is gone');
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('The key service is gone');
});

test('the line says which service of the host failed', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    () => ({ models: [throwing] }),
  );

  await fetch(ask());
  await close();

  expect(lines()[0]).toContain('models');
});

test('no adapter serving a name is told to the host as that, and the caller reads the message it always read', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    () => ({ models: [] }),
  );

  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(404);
  expect(await reply.json()).toMatchObject({
    error: { message: 'No model named openai/gpt' },
  });
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('openai/gpt');
  expect(lines()[0]).toContain('no adapter of this host serves');
});

test('an upstream that knows no such model is not told as a host with no adapter for it', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    () => ({
      models: [
        {
          serves: () => true,
          call: async function* () {
            yield {
              type: 'error',
              error: {
                code: 'unknownModel',
                status: 404,
                upstream: true,
                message: 'The model gpt does not exist',
              },
            } as const;
          },
        },
      ],
    }),
  );

  await fetch(ask());
  await close();

  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('The model gpt does not exist');
  expect(lines()[0]).not.toContain('no adapter');
});

test('a request that succeeds writes nothing', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    () => ({ models: [fake(on(gpt, 'Use a mutex.'))] }),
  );

  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(200);
  expect(lines()).toEqual([]);
});

test('a caller who left is no failure, and writes nothing', async () => {
  const left = new AbortController();
  const asked = Promise.withResolvers<void>();
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(async ({ signal }) => {
      asked.resolve();
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
      return answer('Too late');
    }),
    () => ({}),
  );

  const replied = fetch(ask(left.signal));
  await asked.promise;
  left.abort();
  await replied;
  await close();

  expect(lines()).toEqual([]);
});

test('a time limit that ends the request is a failure, unlike a caller who left', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(async ({ signal }) => {
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
      return answer('Too late');
    }),
    () => ({ limits: { duration: 5 } }),
  );

  await fetch(ask());
  await close();

  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('timed out');
});

test('what work after the response threw is told, though the caller had the answer', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' })
      .afterResponse(() => {
        throw new TypeError('The tally is not a number');
      })
      .handle(() => answer('Use a mutex.')),
    () => ({}),
  );

  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(200);
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('The tally is not a number');
});

test('a failure of a service the motty got past is told, though the request answered', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(async ({ prompt }) => {
      await gpt.complete(prompt).catch(() => {});
      return answer('Use a mutex.');
    }),
    () => ({ models: [throwing] }),
  );

  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(200);
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('The adapter misread its stream');
});

test('a host with a report is told there, and nothing is written', async () => {
  const reports: unknown[] = [];
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(() => {
      throw new TypeError('settings.tier is not a function');
    }),
    () => ({ report: (report) => reports.push(report) }),
  );

  await fetch(ask());
  await close();

  expect(reports).toHaveLength(1);
  expect(lines()).toEqual([]);
});

test.each([
  [
    'throws',
    () => {
      throw new Error('The log sink is gone');
    },
  ],
  ['rejects', () => Promise.reject(new Error('The log sink is gone'))],
] as const)(
  'a report that %s is written with the id of the record it lost',
  async (_, report) => {
    const { fetch, close } = mount(
      motty({ name: 'coder' }).handle(() => answer('Use a mutex.')),
      () => ({ report }),
    );

    const reply = await fetch(ask());
    await close();

    expect(reply.status).toBe(200);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('The log sink is gone');
    expect(lines()[0]).toContain(String(reply.headers.get('x-request-id')));
  },
);

test('a failure whose report is lost is written too, as the host will read it nowhere else', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(() => {
      throw new TypeError('settings.tier is not a function');
    }),
    () => ({
      report: () => {
        throw new Error('The log sink is gone');
      },
    }),
  );

  await fetch(ask());
  await close();

  expect(lines()).toHaveLength(2);
  expect(lines().join()).toContain('The log sink is gone');
  expect(lines().join()).toContain('settings.tier is not a function');
});

test('a failure of the edge has no record, and is written whether or not the host has a report', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(() => answer('Use a mutex.')),
    () => ({ report: () => {} }),
  );

  const reply = await fetch(ask(), undefined, { caller: { id: '' } });
  await close();

  expect(reply.status).toBe(500);
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('The caller the host gave has no id');
});

test('a request the caller got wrong is no failure of the host, and writes nothing', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(() => answer('Use a mutex.')),
    () => ({}),
  );

  const reply = await fetch(
    new Request('http://motty.test/v1/chat/completions', {
      method: 'POST',
      body: '{"model":"coder"}',
    }),
  );
  await close();

  expect(reply.status).toBe(400);
  expect(lines()).toEqual([]);
});

test('a caller the motty turns away is no failure of the host, so a flood of bad tokens writes nothing', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' })
      .use(auth())
      .handle(() => answer('Use a mutex.')),
    () => ({ auth: { verify: () => undefined } }),
  );

  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(401);
  expect(lines()).toEqual([]);
});

test('an upstream that refuses what the adapter sent is written, as the host may have wired it wrong', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(({ prompt }) => gpt.complete(prompt)),
    () => ({
      models: [
        {
          serves: () => true,
          call: async function* () {
            yield {
              type: 'error',
              error: {
                code: 'invalidRequest',
                status: 400,
                message: "property 'prompt_cache_key' is unsupported",
              },
            };
          },
        },
      ],
    }),
  );

  const reply = await fetch(ask());
  await close();

  expect(reply.status).toBe(400);
  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('is unsupported');
});

test.each([
  ['a key', 'The upstream refused sk-proj-canary7'],
  ['a bearer token', 'Sent authorization: Bearer canary-7 and was refused'],
  ['a password in an address', 'No route to redis://ada:canary7@db:6379'],
  ['a key in a query', 'Refused https://up.test/v1?key=canary-7&alt=sse'],
  ['a long token of no known shape', `Refused ${'canary7'.repeat(8)}`],
] as const)('%s in what was thrown is not written', async (_, thrown) => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(() => {
      throw new Error(thrown);
    }),
    () => ({}),
  );

  await fetch(ask());
  await close();

  expect(lines()).toHaveLength(1);
  expect(lines()[0]).not.toContain('canary');
});

test('a value the host holds in its environment is not written', async () => {
  Object.assign(process.env, { MOTTY_TEST_KEY: 'gsk-held-in-env' });
  try {
    const { fetch, close } = mount(
      motty({ name: 'coder' }).handle(() => {
        throw new Error('Refused gsk-held-in-env');
      }),
      () => ({}),
    );

    await fetch(ask());
    await close();

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('Refused');
    expect(lines()[0]).not.toContain('gsk-held-in-env');
  } finally {
    Reflect.deleteProperty(process.env, 'MOTTY_TEST_KEY');
  }
});

test('a value of several lines the host holds in its environment is not written', async () => {
  Object.assign(process.env, { MOTTY_TEST_KEY: 'first-line\nsecond-line' });
  try {
    const { fetch, close } = mount(
      motty({ name: 'coder' }).handle(() => {
        throw new Error('Refused first-line\nsecond-line');
      }),
      () => ({}),
    );

    await fetch(ask());
    await close();

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toContain('Refused [held]');
  } finally {
    Reflect.deleteProperty(process.env, 'MOTTY_TEST_KEY');
  }
});

test('a value the host gave as a setting is not written', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' })
      .use(settings({ keys: z.object({ name: z.string().default('none') }) }))
      .handle(({ settings: { keys } }) => {
        throw new Error(`Refused ${keys.name} and 7`);
      }),
    () => ({ settings: { keys: { name: 'tenant-canary' } } }),
  );

  await fetch(ask());
  await close();

  expect(lines()).toHaveLength(1);
  expect(lines()[0]).toContain('Refused');
  expect(lines()[0]).toContain('and 7');
  expect(lines()[0]).not.toContain('tenant-canary');
});

test('a message of many lines stays one line, whoever chose its words', async () => {
  const { fetch, close } = mount(
    motty({ name: 'coder' }).handle(() => {
      throw new Error('first\r\nmotty: request forged\u001b[2K');
    }),
    () => ({}),
  );

  await fetch(ask());
  await close();

  expect(lines()).toHaveLength(1);
  expect(lines()[0]).not.toMatch(/[\r\n]/);
  expect(lines()[0]).not.toContain('\u001b');
});
