import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Storage } from '@mottyjs/core/host';
import { RedisClient } from 'bun';
import { redis } from '../../packages/adapters/src/redis.ts';
import { workerd } from '../hosts/workerd.ts';
import { nanosecondsPerCall, share } from '../measure.ts';

// Each adapter call as a share of the least its server does for the same
// call. Over ten runs the shares read 1.24 at most, a set on Workers; one more
// round trip in a get read 2.0 on both, which is what this is here to catch.

// biome-ignore lint/complexity/useLiteralKeys: the compiler wants the bracket
const url = process.env['REDIS_URL'];
// A run's keys are its own, since the server may be one a developer shares.
const run = `motty-gate:${crypto.randomUUID()}`;

// Made once the server is known: a skipped block still runs its body.
describe.skipIf(url === undefined)('on Valkey', () => {
  let storage: Storage;
  let client: RedisClient;
  const value = { role: 'user', text: 'x'.repeat(512) };
  const timed = (subject: () => unknown) => nanosecondsPerCall(subject, 10);

  beforeAll(async () => {
    storage = redis({ url });
    client = new RedisClient(url, {
      autoReconnect: false,
      enableAutoPipelining: false,
    });
    await client.connect();
    await storage.set(`${run}:timed`, value);
  });

  afterAll(async () => {
    await client.del(`${run}:timed`, `${run}:counted`, `${run}:bare`);
    client.close();
  });

  test.each([
    {
      call: 'get',
      motty: () => storage.get(`${run}:timed`),
      bare: async () => JSON.parse((await client.get(`${run}:timed`)) ?? ''),
    },
    {
      call: 'set',
      motty: () => storage.set(`${run}:timed`, value, { ttl: 60_000 }),
      bare: () =>
        client.set(`${run}:timed`, JSON.stringify(value), 'PX', 60_000),
    },
    {
      call: 'increment',
      motty: () => storage.increment?.(`${run}:counted`, 1, { ttl: 60_000 }),
      bare: () => client.incrby(`${run}:bare`, 1),
    },
  ])(
    'a $call through the adapter takes about what the bare client takes',
    async ({ motty, bare }) => {
      const taken = await share(bare, motty, timed, 200);
      console.log('SHARE valkey', taken);
      console.log('SHARE workers', call, taken);
      expect(taken).toBeLessThan(1.5);
    },
    60_000,
  );
});

describe('on Workers', () => {
  let address = '';
  let stop = async () => {};

  beforeAll(async () => {
    const { outputs } = await Bun.build({
      entrypoints: [
        `${import.meta.dir}/../../packages/adapters/test/speed.worker.ts`,
      ],
      target: 'browser',
      external: ['cloudflare:workers'],
    });
    ({ address, stop } = await workerd({
      modules: { 'worker.js': (await outputs[0]?.text()) ?? '' },
      flags: ['delete_all_deletes_alarm'],
      bindings: {},
      objects: { STORAGE: 'MottyStorage', BARE: 'BareStorage' },
    }));
    await made('motty set', 1)();
    await made('bare set', 1)();
  }, 30_000);

  afterAll(async () => {
    await stop();
  });

  function made(call: string, calls: number) {
    return async () => {
      const reply = await fetch(
        `${address}/?${new URLSearchParams({ call, calls: `${calls}` })}`,
      );
      if (!reply.ok) throw new Error(await reply.text());
    };
  }

  test.each(['get', 'set', 'plain', 'increment'])(
    'a %s through the adapter takes about what a bare Durable Object takes',
    async (call) => {
      const taken = await share(
        made(`bare ${call}`, 100),
        made(`motty ${call}`, 100),
        (subject) => nanosecondsPerCall(subject, 1),
        200,
      );
      console.log('SHARE workers', call, taken);
      expect(taken).toBeLessThan(1.5);
    },
    60_000,
  );
});
