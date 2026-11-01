import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { redis } from '../../packages/adapters/src/redis.ts';
import { speedWorker, timedCalls, value } from '../hosts/storage.ts';
import { nanosecondsPerCall, share } from '../measure.ts';

// Each adapter call as a share of the least its server does for the same
// call. The shares read 1.31 at most on the CI runner, an increment on Valkey.
// One more round trip in a get read 2.0 on both, which this is here to catch.

// biome-ignore lint/complexity/useLiteralKeys: the compiler wants the bracket
const url = process.env['REDIS_URL'];
// A run's keys are its own, since the server may be one a developer shares.
const run = `motty-gate:${crypto.randomUUID()}`;

// Made once the server is known: a skipped block still runs its body.
describe.skipIf(url === undefined)('on Valkey', () => {
  let calls: ReturnType<typeof timedCalls>;
  let client: RedisClient;
  const timed = (subject: () => unknown) => nanosecondsPerCall(subject, 10);

  beforeAll(async () => {
    const storage = redis({ url });
    calls = timedCalls(storage, run);
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
      motty: () => calls.get(),
      bare: async () => JSON.parse((await client.get(`${run}:timed`)) ?? ''),
    },
    {
      call: 'set',
      motty: () => calls.set(),
      bare: () =>
        client.set(`${run}:timed`, JSON.stringify(value), 'PX', 60_000),
    },
    {
      call: 'increment',
      motty: () => calls.increment(),
      bare: () => client.incrby(`${run}:bare`, 1),
    },
  ])(
    'a $call through the adapter takes about what the bare client takes',
    async ({ motty, bare }) => {
      expect(await share(bare, motty, timed, 200)).toBeLessThan(1.5);
    },
    60_000,
  );
});

describe('on Workers', () => {
  let worker: Awaited<ReturnType<typeof speedWorker>>;

  beforeAll(async () => {
    worker = await speedWorker();
  }, 30_000);

  afterAll(async () => {
    await worker.stop();
  });

  test.each(['get', 'set', 'increment'])(
    'a %s through the adapter takes about what a bare Durable Object takes',
    async (call) => {
      const taken = await share(
        worker.made(`bare ${call}`, 100),
        worker.made(`motty ${call}`, 100),
        (subject) => nanosecondsPerCall(subject, 1),
        200,
      );
      expect(taken).toBeLessThan(1.5);
    },
    60_000,
  );
});
