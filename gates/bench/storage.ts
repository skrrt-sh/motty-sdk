import type { Storage } from '@mottyjs/core/host';
import { redis } from '../../packages/adapters/src/redis.ts';
import { speedWorker, timedCalls } from '../hosts/storage.ts';
import { median, nanosecondsPerCall } from '../measure.ts';

// Reproduces the local figures in the README's Storage section. The shares
// are the gate's, in gates/test/storage.test.ts.

// biome-ignore lint/complexity/useLiteralKeys: the compiler wants the bracket
const url = process.env['REDIS_URL'];
const run = `motty-bench:${crypto.randomUUID()}`;

// The first rounds run code the engine has not compiled yet.
async function medianOf(rounds: number, round: () => number | Promise<number>) {
  const taken: number[] = [];
  for (let done = -Math.ceil(rounds / 10); done < rounds; done++) {
    const result = await round();
    if (done >= 0) taken.push(result);
  }
  return median(taken);
}

// `width` subjects at once, each making `calls` calls. `made` counts the
// warm-up rounds too, since their calls reach the server all the same.
async function inFlight(subject: () => unknown, width: number, calls: number) {
  let made = 0;
  const perSecond = await medianOf(5, async () => {
    const start = Bun.nanoseconds();
    await Promise.all(
      Array.from({ length: width }, () => nanosecondsPerCall(subject, 1)),
    );
    made += width * calls;
    return (width * calls * 1e9) / (Bun.nanoseconds() - start);
  });
  return { perSecond, made };
}

function time(nanoseconds: number) {
  return nanoseconds < 150_000
    ? `${(nanoseconds / 1_000).toFixed(1)} µs`
    : `${(nanoseconds / 1_000_000).toFixed(2)} ms`;
}

function line(label: string, figure: string) {
  console.log(`  ${label.padEnd(44)} ${figure.padStart(16)}`);
}

function rate(label: string, calls: number) {
  const rounded = Number(calls.toPrecision(3));
  line(label, `${rounded.toLocaleString('en-US')} /s`);
}

// A count short of what was sent fails the run: it is the one figure here
// that is a promise and not a measure.
function counted(made: number, total: number) {
  const lost = made - total;
  line(
    'Increments made at once',
    lost === 0 ? `${made} of ${made}` : `LOST ${lost} of ${made}`,
  );
  if (lost !== 0) process.exitCode = 1;
}

async function onRedis(storage: Storage) {
  const calls = timedCalls(storage, run);
  const each = (call: () => unknown) =>
    medianOf(2000, () => nanosecondsPerCall(call, 1));
  const total = async () => Number((await storage.get(`${run}:counted`)) ?? 0);
  const loaded = (call: () => unknown) =>
    inFlight(() => nanosecondsPerCall(call, 200), 100, 200);
  try {
    await calls.set();
    line('Get', time(await each(calls.get)));
    line('Set with an expiry', time(await each(calls.set)));
    line('Increment with an expiry', time(await each(calls.increment)));
    rate('Gets, 100 in flight', (await loaded(calls.get)).perSecond);
    rate('Sets, 100 in flight', (await loaded(calls.set)).perSecond);
    const before = await total();
    const { perSecond, made } = await loaded(calls.increment);
    rate('Increments, 100 in flight', perSecond);
    counted(made, (await total()) - before);
  } finally {
    await storage.delete(`${run}:timed`);
    await storage.delete(`${run}:counted`);
  }
}

async function onWorkers() {
  const { made, stop } = await speedWorker();
  // Timed from outside, as the gate times it, with enough calls to a request
  // that the time of the request itself is too small to count.
  const each = (call: string, calls: number, rounds: number) =>
    medianOf(
      rounds,
      async () => (await nanosecondsPerCall(made(call, calls), 1)) / calls,
    );
  const total = async () => Number(await (await made('total', 1)()).text());
  const loaded = (call: string) => inFlight(made(call, 200), 50, 200);
  try {
    line('Get', time(await each('motty get', 1000, 30)));
    line('Set with an expiry', time(await each('motty set', 1000, 30)));
    line(
      'Increment with an expiry',
      time(await each('motty increment', 1000, 30)),
    );
    // Every call makes an object, a file on disk, and the time rose past a
    // few hundred of them. The count is fixed and small, so runs compare.
    line('Set of a new key, own object', time(await each('new key', 20, 15)));
    line(
      'Set of a new key, object shared by name',
      time(await each('new key, shared', 100, 20)),
    );
    rate('Gets, 50 in flight', (await loaded('motty get')).perSecond);
    const before = await total();
    const { perSecond, made: sent } = await loaded('motty increment');
    rate('Increments of one key, 50 in flight', perSecond);
    counted(sent, (await total()) - before);
  } finally {
    await stop();
  }
}

if (url === undefined) {
  console.log('Redis: skipped, REDIS_URL is not set');
} else {
  const storage = redis({ url });
  // Only the host: the rest of a url may hold a password.
  console.log(`Redis at ${new URL(url).host}, local, value of 512 bytes`);
  await onRedis(storage);
}
console.log('Durable Object in workerd, local, value of 512 bytes');
await onWorkers();
