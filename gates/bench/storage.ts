import { AsyncLocalStorage } from 'node:async_hooks';
import { current, enter } from '../../packages/core/src/request/context.ts';
import { stubHost } from '../../packages/core/test/stub-host.ts';

const callsPerSample = 1_000_000;
const requestsPerSample = 100_000;
const hooks = 10;
const samples = 9;

const storage = new AsyncLocalStorage<{ seen: number }>();
const store = { seen: 1 };
const host = stubHost();

let total = 0;

function plain() {
  total += store.seen;
}

function found() {
  total += storage.getStore()?.seen ?? 0;
}

function limited() {
  total += current().limits.calls ?? 1;
}

function counted(count: number, call: () => void) {
  for (let done = 0; done < count; done++) call();
}

async function hook() {
  await Promise.resolve();
  found();
}

async function awaited(call: () => Promise<void>) {
  for (let done = 0; done < hooks; done++) await call();
}

async function requested(count: number, request: () => Promise<void>) {
  for (let done = 0; done < count; done++) await request();
}

function candidate(
  count: number,
  per: string,
  run: (count: number) => void | Promise<void>,
) {
  return { count, per, run };
}

const candidates = {
  'plain call, no context': candidate(callsPerSample, 'call', (count) =>
    counted(count, plain),
  ),
  'enter: run()': candidate(callsPerSample, 'call', (count) =>
    counted(count, () => storage.run(store, plain)),
  ),
  'read: getStore(), inside one entry': candidate(
    callsPerSample,
    'call',
    (count) => storage.run(store, () => counted(count, found)),
  ),
  'enter and read once': candidate(callsPerSample, 'call', (count) =>
    counted(count, () => storage.run(store, found)),
  ),
  "the core's enter()": candidate(callsPerSample, 'call', (count) =>
    counted(count, () => enter(host, plain)),
  ),
  "the core's current(), inside one entry": candidate(
    callsPerSample,
    'call',
    (count) => enter(host, () => counted(count, limited)),
  ),
  [`${hooks} awaited hooks, never entered`]: candidate(
    requestsPerSample,
    'request',
    (count) => requested(count, () => awaited(hook)),
  ),
  [`${hooks} awaited hooks, entered once`]: candidate(
    requestsPerSample,
    'request',
    (count) => requested(count, () => storage.run(store, () => awaited(hook))),
  ),
  [`${hooks} awaited hooks, entered per hook`]: candidate(
    requestsPerSample,
    'request',
    (count) => requested(count, () => awaited(() => storage.run(store, hook))),
  ),
};

async function sample(
  run: (count: number) => void | Promise<void>,
  count: number,
) {
  const start = Bun.nanoseconds();
  await run(count);
  return (Bun.nanoseconds() - start) / count;
}

for (const { run, count } of Object.values(candidates))
  await sample(run, count);

const rows: Record<string, string>[] = [];
for (const [name, { run, count, per }] of Object.entries(candidates)) {
  await sample(run, count);
  const taken: number[] = [];
  for (let done = 0; done < samples; done++)
    taken.push(await sample(run, count));
  taken.sort((left, right) => left - right);
  const median = taken.at(samples >> 1) ?? Number.NaN;
  rows.push({
    candidate: name,
    per,
    ns: median.toFixed(1),
    'least to most': `${taken.at(0)?.toFixed(1)} to ${taken.at(-1)?.toFixed(1)}`,
  });
}

console.log(
  `bun ${Bun.version}, ${samples} samples, median nanoseconds per call (${callsPerSample} a sample) or per request (${requestsPerSample} a sample)`,
);
console.table(rows);
console.log(`${total} stores read`);
