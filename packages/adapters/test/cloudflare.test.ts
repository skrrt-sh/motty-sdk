import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Storage } from '@mottyjs/core/host';
import { memory } from '@mottyjs/test';
import { workerd } from '../../../gates/hosts/workerd.ts';
import { parsed } from '../src/json.ts';

// Bun cannot load `cloudflare:workers`, so the adapter runs in workerd behind
// the test worker, and each call here is one request to it.
let address = '';
let stop = async () => {};

beforeAll(async () => {
  const { outputs } = await Bun.build({
    entrypoints: [`${import.meta.dir}/cloudflare.worker.ts`],
    target: 'browser',
    external: ['cloudflare:workers'],
  });
  ({ address, stop } = await workerd({
    modules: { 'worker.js': (await outputs[0]?.text()) ?? '' },
    flags: ['delete_all_deletes_alarm'],
    bindings: {},
    objects: { STORAGE: 'MottyStorage' },
  }));
}, 30_000);

afterAll(async () => {
  await stop();
});

async function sent(
  call: string,
  key: string,
  query: { by?: number; ttl?: number; group?: string },
  body?: string,
): Promise<string> {
  const search = new URLSearchParams({ key });
  for (const [name, value] of Object.entries(query)) {
    search.set(name, `${value}`);
  }
  const reply = await fetch(`${address}/${call}?${search}`, {
    method: 'POST',
    body: body ?? null,
  });
  const text = await reply.text();
  if (!reply.ok) throw new Error(text);
  return text;
}

function cloudflare(group?: string): Storage {
  const at = group === undefined ? {} : { group };
  return {
    get: async (key) => {
      const text = await sent('get', key, at);
      return text === '' ? undefined : parsed(text);
    },
    set: async (key, value, options) => {
      await sent('set', key, { ...at, ...options }, JSON.stringify(value));
    },
    delete: async (key) => {
      await sent('delete', key, at);
    },
    increment: async (key, by, options) => {
      const total = parsed(
        await sent('increment', key, { ...at, ...options, by }),
      );
      if (typeof total !== 'number') throw new Error(`${total} is no total`);
      return total;
    },
  };
}

// Text in the object as another writer would leave it.
const other = {
  set: (key: string, text: string) => sent('raw', key, {}, text),
  get: (key: string) => sent('text', key, {}),
};

test('every kind of JSON value is read back as it was set', async () => {
  const storage = cloudflare();
  const kinds = {
    text: 'deep',
    empty: '',
    number: 1.5,
    zero: 0,
    yes: true,
    no: false,
    nothing: null,
    list: [1, 'two', null, [3]],
    record: { tier: 'deep', turns: [1, 2], nested: { on: true } },
  };

  for (const [kind, value] of Object.entries(kinds)) {
    await storage.set(`kind:${kind}`, value);
  }
  const read = Object.fromEntries(
    await Promise.all(
      Object.keys(kinds).map(async (kind) => [
        kind,
        await storage.get(`kind:${kind}`),
      ]),
    ),
  );

  expect(read).toEqual(kinds);
});

test('a key never set reads as nothing', async () => {
  expect(await cloudflare().get('never')).toBeUndefined();
});

test('a value set again replaces the first and drops its time to live', async () => {
  const storage = cloudflare();

  await storage.set('again', 'fast', { ttl: 1_000 });
  await storage.set('again', 'deep');
  await Bun.sleep(1200);

  expect(await storage.get('again')).toBe('deep');
});

test('a time to live may be shorter than a second', async () => {
  const storage = cloudflare();

  await storage.set('part', 'deep', { ttl: 200 });
  const before = await storage.get('part');
  await Bun.sleep(400);
  const after = await storage.get('part');

  expect(before).toBe('deep');
  expect(after).toBeUndefined();
});

test('an increment of a key never set starts from zero, and the total is read back as a number', async () => {
  const storage = cloudflare();

  const total = await storage.increment?.('fresh', 2.5);

  expect(total).toBe(2.5);
  expect(await storage.get('fresh')).toBe(2.5);
});

test('an increment adds to the number held, and takes away with an amount below zero', async () => {
  const storage = cloudflare();
  await storage.set('spent', 4);

  const totals = [
    await storage.increment?.('spent', 1),
    await storage.increment?.('spent', -3),
  ];

  expect(totals).toEqual([5, 2]);
  expect(await storage.get('spent')).toBe(2);
});

test.each([
  ['a tenth and a fifth', [0.1, 0.2]],
  ['whole numbers past the last safe one', [2 ** 53, 1, 1, 1]],
  ['amounts written with an exponent', [1e21, 1e-7, -1e21, 1e-7]],
  ['the smallest amounts a number has', [5e-324, 5e-324]],
])(
  '%s add up to the total the same additions give in the test store',
  async (_name, amounts) => {
    const key = `sum:${crypto.randomUUID()}`;

    const totals = [];
    for (const storage of [cloudflare(), memory()]) {
      for (const by of amounts) await storage.increment?.(key, by);
      totals.push(await storage.increment?.(key, 0), await storage.get(key));
    }

    const sum = amounts.reduce((total, by) => total + by, 0);
    expect(totals).toStrictEqual([sum, sum, sum, sum]);
  },
);

test.each([
  [1e21, 1e5],
  [1e-7, 1e-7],
])(
  'a held %p and an increment of %p give the total they give in the test store',
  async (held, by) => {
    const key = `held:${crypto.randomUUID()}`;

    const totals = [];
    for (const storage of [cloudflare(), memory()]) {
      await storage.set(key, held);
      totals.push(await storage.increment?.(key, by), await storage.get(key));
    }

    expect(totals).toStrictEqual([held + by, held + by, held + by, held + by]);
  },
);

test('a total past the largest number is refused as the test store refuses it, and the value stays', async () => {
  const key = `past:${crypto.randomUUID()}`;

  const seen = [];
  for (const storage of [cloudflare(), memory()]) {
    await storage.set(key, 1.7976931348623157e308);
    seen.push(
      await storage
        .increment?.(key, 1.7976931348623157e308)
        .catch((raised: unknown) => raised),
      await storage.get(key),
    );
  }

  expect(seen).toEqual([
    new Error(`The total stored under ${key} would not be a finite number`),
    1.7976931348623157e308,
    new Error(`The total stored under ${key} would not be a finite number`),
    1.7976931348623157e308,
  ]);
});

test.each([' 5', '5.0', '500E-2', '-0'])(
  'an increment adds to a number another writer stored as %p, as a read gives it',
  async (text) => {
    const storage = cloudflare();
    const key = `written:${crypto.randomUUID()}`;
    await other.set(key, text);

    const read = await storage.get(key);
    const total = await storage.increment?.(key, 1);

    expect(total).toBe(Number(read) + 1);
  },
);

test.each(['0x10', '+5', '05', '5.', '5e', '\v5'])(
  'an increment of %p, which is no JSON number, is refused, and the text stays',
  async (text) => {
    const key = `foreign:${crypto.randomUUID()}`;
    await other.set(key, text);

    const thrown = await cloudflare()
      .increment?.(key, 1)
      .catch((raised: unknown) => raised);

    expect(thrown).toEqual(
      new Error(`The value stored under ${key} is not a number`),
    );
    expect(await other.get(key)).toBe(text);
  },
);

test('a JSON number too large to hold is refused, and the text stays', async () => {
  await other.set('vast', '1e999');

  const thrown = await cloudflare()
    .increment?.('vast', 1)
    .catch((raised: unknown) => raised);

  expect(thrown).toEqual(
    new Error('The total stored under vast would not be a finite number'),
  );
  expect(await other.get('vast')).toBe('1e999');
});

test('increments made at once from two adapters are all kept', async () => {
  const adapters = [cloudflare(), cloudflare()];

  const totals = await Promise.all(
    Array.from({ length: 40 }, (_, at) =>
      adapters[at % 2]?.increment?.('turns', 1),
    ),
  );

  expect(totals.toSorted((one, other) => (one ?? 0) - (other ?? 0))).toEqual(
    Array.from({ length: 40 }, (_, at) => at + 1),
  );
  expect(await adapters[0]?.get('turns')).toBe(40);
});

test('the time to live is set by the increment that made the key and left alone by the ones after', async () => {
  const storage = cloudflare();

  await storage.increment?.('window', 1, { ttl: 1_000 });
  await Bun.sleep(600);
  await storage.increment?.('window', 1, { ttl: 60_000 });
  const before = await storage.get('window');
  await Bun.sleep(600);
  const after = await storage.get('window');

  expect(before).toBe(2);
  expect(after).toBeUndefined();
});

test('an increment with a time to live gives none to a key that was set without one', async () => {
  const storage = cloudflare();
  await storage.set('kept', 4);

  await storage.increment?.('kept', 1, { ttl: 200 });
  await Bun.sleep(400);

  expect(await storage.get('kept')).toBe(5);
});

test('an increment keeps the time to live the key was set with', async () => {
  const storage = cloudflare();
  await storage.set('brief', 4, { ttl: 200 });

  const total = await storage.increment?.('brief', 1);
  await Bun.sleep(400);

  expect(total).toBe(5);
  expect(await storage.get('brief')).toBeUndefined();
});

test('an increment of a key whose time ran out starts from zero, with a time to live of its own', async () => {
  const storage = cloudflare();
  await storage.set('lapsed', 4, { ttl: 200 });
  await Bun.sleep(400);

  const total = await storage.increment?.('lapsed', 1, { ttl: 400 });
  const before = await storage.get('lapsed');
  await Bun.sleep(600);
  const after = await storage.get('lapsed');

  expect(total).toBe(1);
  expect(before).toBe(1);
  expect(after).toBeUndefined();
});

test.each(['5'])(
  'an increment of a held %p is refused, and the value stays',
  async (value) => {
    const storage = cloudflare();
    const key = `refused:${crypto.randomUUID()}`;
    await storage.set(key, value);

    const thrown = await storage
      .increment?.(key, 1)
      .catch((raised: unknown) => raised);

    expect(thrown).toEqual(
      new Error(`The value stored under ${key} is not a number`),
    );
    expect(await storage.get(key)).toEqual(value);
  },
);

test('two adapters on one namespace see each other’s keys', async () => {
  const first = cloudflare();
  const second = cloudflare();

  await first.set('shared', { tier: 'deep' });
  const seen = await second.get('shared');
  await second.delete('shared');

  expect(seen).toEqual({ tier: 'deep' });
  expect(await first.get('shared')).toBeUndefined();
});

// The alarm deletes the object whole once its keys expired, and a deleted
// object takes a key again.
test('a key whose object its alarm deleted is set again', async () => {
  const storage = cloudflare();
  await storage.set('gone', 1, { ttl: 20 });
  await Bun.sleep(200);

  await storage.set('gone', 2);

  expect(await storage.get('gone')).toBe(2);
});

test('keys grouped in one object keep their own times, and an expired or deleted one leaves the others', async () => {
  const storage = cloudflare('ledger');
  await storage.set('brief', 1, { ttl: 50 });
  await storage.set('longer', 2, { ttl: 400 });
  await storage.set('lasting', 3);
  await storage.set('dropped', 4);

  await storage.delete('dropped');
  await Bun.sleep(200);
  const early = await Promise.all(
    ['brief', 'longer', 'lasting', 'dropped'].map((key) => storage.get(key)),
  );
  await Bun.sleep(400);
  const late = await Promise.all(
    ['brief', 'longer', 'lasting'].map((key) => storage.get(key)),
  );

  expect(early).toEqual([undefined, 2, 3, undefined]);
  expect(late).toEqual([undefined, undefined, 3]);
});

// Reads check each key's expiry, so only the rows left show whether the
// alarm came: here it is brought earlier, fires, and is set again.
test('the alarm sweeps each expired key from its object, the soonest first', async () => {
  const storage = cloudflare('swept');
  const held = async () => Number(await sent('held', '', { group: 'swept' }));
  await storage.set('later', 1, { ttl: 400 });
  await storage.set('sooner', 2, { ttl: 50 });

  await Bun.sleep(200);
  const between = await held();
  await Bun.sleep(400);
  const emptied = await held();
  await storage.set('again', 3, { ttl: 50 });
  await Bun.sleep(200);

  expect([between, emptied, await held()]).toEqual([1, 0, 0]);
});
