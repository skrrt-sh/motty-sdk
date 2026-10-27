import { describe, expect, test } from 'bun:test';
import { memory } from '@mottyjs/test';
import { RedisClient } from 'bun';
import { redis } from '../src/redis.ts';

// biome-ignore lint/complexity/useLiteralKeys: the compiler wants the bracket
const url = process.env['REDIS_URL'];
// A run's keys are its own, since the server may be one a developer shares.
const run = `motty-test:${crypto.randomUUID()}`;

describe.skipIf(url === undefined)('against a server', () => {
  test('every kind of JSON value is read back as it was set', async () => {
    const storage = redis({ url });
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
      await storage.set(`${run}:kind:${kind}`, value);
    }
    const read = Object.fromEntries(
      await Promise.all(
        Object.keys(kinds).map(async (kind) => [
          kind,
          await storage.get(`${run}:kind:${kind}`),
        ]),
      ),
    );
    for (const kind of Object.keys(kinds)) {
      await storage.delete(`${run}:kind:${kind}`);
    }

    expect(read).toEqual(kinds);
  });

  test('a key never set reads as nothing', async () => {
    expect(await redis({ url }).get(`${run}:never`)).toBeUndefined();
  });

  test('a value set again replaces the first and drops its time to live', async () => {
    const storage = redis({ url });

    await storage.set(`${run}:again`, 'fast', { ttl: 1_000 });
    await storage.set(`${run}:again`, 'deep');
    await Bun.sleep(1200);
    const held = await storage.get(`${run}:again`);
    await storage.delete(`${run}:again`);

    expect(held).toBe('deep');
  });

  test('a time to live may be shorter than a second', async () => {
    const storage = redis({ url });

    await storage.set(`${run}:part`, 'deep', { ttl: 200 });
    const before = await storage.get(`${run}:part`);
    await Bun.sleep(400);
    const after = await storage.get(`${run}:part`);

    expect(before).toBe('deep');
    expect(after).toBeUndefined();
  });

  test('a stored value that is not JSON fails the read and is left as it is', async () => {
    const storage = redis({ url });
    const other = new RedisClient(url);
    await other.set(`${run}:foreign`, 'not json');

    const read = await storage.get(`${run}:foreign`).catch((error) => error);
    const kept = await other.get(`${run}:foreign`);
    await other.del(`${run}:foreign`);
    other.close();

    expect(read).toBeInstanceOf(Error);
    expect(read.message).toBe(
      `The value stored under ${run}:foreign is not JSON`,
    );
    expect(kept).toBe('not json');
  });

  test('an increment of a key never set starts from zero, and the total is read back as a number', async () => {
    const storage = redis({ url });

    const total = await storage.increment?.(`${run}:fresh`, 2.5);
    const held = await storage.get(`${run}:fresh`);
    await storage.delete(`${run}:fresh`);

    expect(total).toBe(2.5);
    expect(held).toBe(2.5);
  });

  test('an increment adds to the number held, and takes away with an amount below zero', async () => {
    const storage = redis({ url });
    await storage.set(`${run}:spent`, 4);

    const totals = [
      await storage.increment?.(`${run}:spent`, 1),
      await storage.increment?.(`${run}:spent`, -3),
    ];
    const held = await storage.get(`${run}:spent`);
    await storage.delete(`${run}:spent`);

    expect(totals).toEqual([5, 2]);
    expect(held).toBe(2);
  });

  test.each([
    ['a tenth and a fifth', [0.1, 0.2]],
    ['whole numbers past the last safe one', [2 ** 53, 1, 1, 1]],
    ['amounts written with an exponent', [1e21, 1e-7, -1e21, 1e-7]],
    ['the smallest amounts a number has', [5e-324, 5e-324]],
  ])(
    '%s add up to the total the same additions give in the test store',
    async (_name, amounts) => {
      const stores = [redis({ url }), memory()];
      const key = `${run}:sum:${crypto.randomUUID()}`;

      const totals = [];
      for (const storage of stores) {
        for (const by of amounts) await storage.increment?.(key, by);
        totals.push(await storage.increment?.(key, 0), await storage.get(key));
        await storage.delete(key);
      }

      const sum = amounts.reduce((total, by) => total + by, 0);
      expect(totals).toStrictEqual([sum, sum, sum, sum]);
    },
    30_000,
  );

  test.each([
    [1e21, 1e5],
    [1e-7, 1e-7],
  ])(
    'a held %p and an increment of %p give the total they give in the test store',
    async (held, by) => {
      const stores = [redis({ url }), memory()];
      const key = `${run}:held:${crypto.randomUUID()}`;

      const totals = [];
      for (const storage of stores) {
        await storage.set(key, held);
        totals.push(await storage.increment?.(key, by), await storage.get(key));
        await storage.delete(key);
      }

      expect(totals).toStrictEqual([
        held + by,
        held + by,
        held + by,
        held + by,
      ]);
    },
  );

  test('a total past the largest number is refused as the test store refuses it, and the value stays', async () => {
    const stores = [redis({ url }), memory()];
    const key = `${run}:past:${crypto.randomUUID()}`;

    const seen = [];
    for (const storage of stores) {
      await storage.set(key, 1.7976931348623157e308);
      seen.push(
        await storage
          .increment?.(key, 1.7976931348623157e308)
          .catch((raised: unknown) => raised),
        await storage.get(key),
      );
      await storage.delete(key);
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
      const storage = redis({ url });
      const other = new RedisClient(url);
      const key = `${run}:written:${crypto.randomUUID()}`;
      await other.set(key, text);

      const read = await storage.get(key);
      const total = await storage.increment?.(key, 1);
      await other.del(key);
      other.close();

      expect(total).toBe(Number(read) + 1);
    },
  );

  test.each(['0x10', '+5', '05', '5.', '5e', '\v5'])(
    'an increment of %p, which is no JSON number, is refused, and the text stays',
    async (text) => {
      const storage = redis({ url });
      const other = new RedisClient(url);
      const key = `${run}:foreign:${crypto.randomUUID()}`;
      await other.set(key, text);

      const thrown = await storage
        .increment?.(key, 1)
        .catch((raised: unknown) => raised);
      const kept = await other.get(key);
      await other.del(key);
      other.close();

      expect(thrown).toEqual(
        new Error(`The value stored under ${key} is not a number`),
      );
      expect(kept).toBe(text);
    },
  );

  test('a JSON number too large to hold is refused, and the text stays', async () => {
    const storage = redis({ url });
    const other = new RedisClient(url);
    await other.set(`${run}:vast`, '1e999');

    const thrown = await storage
      .increment?.(`${run}:vast`, 1)
      .catch((raised: unknown) => raised);
    const kept = await other.get(`${run}:vast`);
    await other.del(`${run}:vast`);
    other.close();

    expect(thrown).toEqual(
      new Error(
        `The total stored under ${run}:vast would not be a finite number`,
      ),
    );
    expect(kept).toBe('1e999');
  });

  test('increments made at once from two adapters are all kept', async () => {
    const adapters = [redis({ url }), redis({ url })];

    const totals = await Promise.all(
      Array.from({ length: 40 }, (_, at) =>
        adapters[at % 2]?.increment?.(`${run}:turns`, 1),
      ),
    );
    const held = await adapters[0]?.get(`${run}:turns`);
    await adapters[0]?.delete(`${run}:turns`);

    expect(totals.toSorted((one, other) => (one ?? 0) - (other ?? 0))).toEqual(
      Array.from({ length: 40 }, (_, at) => at + 1),
    );
    expect(held).toBe(40);
  });

  test('the time to live is set by the increment that made the key and left alone by the ones after', async () => {
    const storage = redis({ url });

    await storage.increment?.(`${run}:window`, 1, { ttl: 1_000 });
    await Bun.sleep(600);
    await storage.increment?.(`${run}:window`, 1, { ttl: 60_000 });
    const before = await storage.get(`${run}:window`);
    await Bun.sleep(600);
    const after = await storage.get(`${run}:window`);
    await storage.delete(`${run}:window`);

    expect(before).toBe(2);
    expect(after).toBeUndefined();
  });

  test('an increment with a time to live gives none to a key that was set without one', async () => {
    const storage = redis({ url });
    await storage.set(`${run}:kept`, 4);

    await storage.increment?.(`${run}:kept`, 1, { ttl: 200 });
    await Bun.sleep(400);
    const held = await storage.get(`${run}:kept`);
    await storage.delete(`${run}:kept`);

    expect(held).toBe(5);
  });

  test('an increment keeps the time to live the key was set with', async () => {
    const storage = redis({ url });
    await storage.set(`${run}:brief`, 4, { ttl: 200 });

    const total = await storage.increment?.(`${run}:brief`, 1);
    await Bun.sleep(400);
    const after = await storage.get(`${run}:brief`);

    expect(total).toBe(5);
    expect(after).toBeUndefined();
  });

  test.each(['5'])(
    'an increment of a held %p is refused, and the value stays',
    async (value) => {
      const storage = redis({ url });
      const key = `${run}:refused:${crypto.randomUUID()}`;
      await storage.set(key, value);

      const thrown = await storage
        .increment?.(key, 1)
        .catch((raised: unknown) => raised);
      const held = await storage.get(key);
      await storage.delete(key);

      expect(thrown).toEqual(
        new Error(`The value stored under ${key} is not a number`),
      );
      expect(held).toEqual(value);
    },
  );

  test('two adapters on one server see each other’s keys', async () => {
    const first = redis({ url });
    const second = redis({ url });

    await first.set(`${run}:shared`, { tier: 'deep' });
    const seen = await second.get(`${run}:shared`);
    await second.delete(`${run}:shared`);

    expect(seen).toEqual({ tier: 'deep' });
    expect(await first.get(`${run}:shared`)).toBeUndefined();
  });

  // The relay passes plain TCP bytes, so it stands in front of neither TLS
  // nor a Unix socket.
  test.skipIf(!(url?.startsWith('redis:') ?? false))(
    'a connection the server dropped is made again by the next call',
    async () => {
      const target = new URL(url ?? '');
      const open: { end: () => void }[] = [];
      let made = 0;
      // A relay in front of the server, so the test can drop the connection
      // as a server's idle timeout or a restart does.
      using relay = Bun.listen<{ ahead?: Bun.Socket; held: Uint8Array[] }>({
        hostname: '127.0.0.1',
        port: 0,
        socket: {
          open: async (caller) => {
            caller.data = { held: [] };
            made += 1;
            open.push(caller);
            const ahead = await Bun.connect({
              hostname: target.hostname,
              port: Number(target.port || 6379),
              socket: {
                data: (_, chunk) => {
                  caller.write(chunk);
                },
                close: () => {
                  caller.end();
                },
              },
            });
            open.push(ahead);
            caller.data.ahead = ahead;
            for (const chunk of caller.data.held) ahead.write(chunk);
          },
          data: (caller, chunk) => {
            const { ahead } = caller.data;
            if (ahead === undefined) caller.data.held.push(chunk);
            else ahead.write(chunk);
          },
          close: (caller) => {
            caller.data.ahead?.end();
          },
        },
      });
      const relayed = new URL(target);
      relayed.hostname = '127.0.0.1';
      relayed.port = `${relay.port}`;
      const storage = redis({ url: relayed.href });

      await storage.set(`${run}:dropped`, 'first');
      for (const socket of open.splice(0)) socket.end();
      await Bun.sleep(50);
      const read = await storage
        .get(`${run}:dropped`)
        .catch((raised: unknown) => raised);
      await storage.delete(`${run}:dropped`);

      expect(read).toBe('first');
      expect(made).toBe(2);
    },
  );
});

test('with no url it fails when made', () => {
  expect(() => redis({ url: undefined })).toThrow(
    'The redis adapter was given no url',
  );
  expect(() => redis({ url: '' })).toThrow(
    'The redis adapter was given no url',
  );
});

test('a url that cannot be parsed fails when made, and is not quoted', () => {
  expect(() => redis({ url: 'not-a-url' })).toThrow(
    'The redis adapter was given a url that cannot be parsed',
  );
});

test.each([0, 1.5, Number.NaN])(
  'a time to live of %d milliseconds is named as the mistake before any call',
  async (ttl) => {
    const storage = redis({ url: 'redis://127.0.0.1:1' });

    const thrown = await storage
      .set('tier:c1', 'deep', { ttl })
      .catch((raised: unknown) => raised);

    expect(thrown).toEqual(
      new Error(
        `A time to live is a positive, whole number of milliseconds, and ${ttl} is not`,
      ),
    );
  },
);

test.each([Number.POSITIVE_INFINITY])(
  'an increment by %d is named as the mistake before any call',
  async (by) => {
    const storage = redis({ url: 'redis://127.0.0.1:1' });

    const thrown = await storage
      .increment?.('spent:c1', by)
      .catch((raised: unknown) => raised);

    expect(thrown).toEqual(
      new Error(`An increment is a finite number, and ${by} is not`),
    );
  },
);

test.each([0])(
  'an increment with a time to live of %d milliseconds is named as the mistake before any call',
  async (ttl) => {
    const storage = redis({ url: 'redis://127.0.0.1:1' });

    const thrown = await storage
      .increment?.('spent:c1', 1, { ttl })
      .catch((raised: unknown) => raised);

    expect(thrown).toEqual(
      new Error(
        `A time to live is a positive, whole number of milliseconds, and ${ttl} is not`,
      ),
    );
  },
);

test('a server that is down fails every call at once, and keeps failing', async () => {
  const storage = redis({ url: 'redis://127.0.0.1:1' });
  const started = performance.now();

  const calls = await Promise.allSettled([
    storage.get('tier:c1'),
    storage.set('tier:c1', 'deep'),
    storage.set('tier:c1', 'deep', { ttl: 60_000 }),
    storage.delete('tier:c1'),
    storage.increment?.('tier:c1', 1),
  ]);
  const later = await Promise.allSettled([storage.get('tier:c1')]);

  expect([...calls, ...later].map((call) => call.status)).toEqual([
    'rejected',
    'rejected',
    'rejected',
    'rejected',
    'rejected',
    'rejected',
  ]);
  expect(performance.now() - started).toBeLessThan(2000);
});
