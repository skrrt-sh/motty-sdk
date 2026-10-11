import { motty } from '../../packages/core/src/chain/motty.ts';
import { contractOf } from '../../packages/core/src/chain/run.ts';
import type { Contract } from '../../packages/core/src/contract.ts';
import { answer } from '../../packages/core/src/request/answer.ts';
import { stubHost } from '../../packages/core/test/stub-host.ts';
import { ask, coder, script } from './coder.ts';

const requestsPerSample = 5_000;
const recordsPerSample = 1_000_000;
const samples = 9;

const chained = contractOf(coder());

function subject(
  contract: Contract,
  model: string,
  chunks: number,
  path: string[],
  models: string[],
) {
  const replies = script(chunks);
  const made = models.map((called) => ({
    model: called,
    input: 900,
    output: chunks,
    latencyMs: 412.5,
  }));
  return { contract, model, replies, path, made };
}

type Subject = ReturnType<typeof subject>;

const subjects: Record<string, Subject> = {
  'handle only, no hooks': subject(
    contractOf(
      motty({ name: 'bare' }).handle(() => answer('The lock order differs')),
    ),
    'motty/bare',
    4,
    [],
    [],
  ),
  'coder, standard tier, 4 chunks': subject(
    chained,
    'motty/coder',
    4,
    ['chat', 'standard'],
    ['jev', 'sonnet'],
  ),
  'coder, standard tier, 200 chunks': subject(
    chained,
    'motty/coder',
    200,
    ['chat', 'standard'],
    ['jev', 'sonnet'],
  ),
  'coder, deep tier, 4 chunks': subject(
    chained,
    'motty/coder:max',
    4,
    ['chat', 'deep'],
    ['jev', 'sonnet', 'opus'],
  ),
};

// A host and a request of its own for every request, as a real host makes.
async function read({ contract, model, replies }: Subject) {
  let last = '';
  for await (const event of contract.run(ask(model), stubHost(replies))) {
    last = event.type;
  }
  if (last !== 'finish') throw new Error(`The request ended with ${last}`);
}

// A simulation outside the core: the record is built here from values the
// core would already hold, which says what telling costs, not how to tell.
function record({ path, made }: Subject, began: number) {
  return {
    path: [...path],
    calls: made.map((call) => ({ ...call })),
    outcome: 'completed',
    durationMs: performance.now() - began,
  };
}

type Told = ReturnType<typeof record>;

let heard = 0;

function hear(told: Told) {
  heard += told.calls.length + told.path.length;
}

async function resolved(told: Told) {
  const telling = Promise.withResolvers<Told>();
  telling.resolve(told);
  hear(await telling.promise);
}

const tellings: Record<string, (asked: Subject) => Promise<void>> = {
  nothing: read,
  'record to a host callback': async (asked) => {
    const began = performance.now();
    await read(asked);
    hear(record(asked, began));
  },
  'record through a promise': async (asked) => {
    const began = performance.now();
    await read(asked);
    await resolved(record(asked, began));
  },
};

// The same three without a request around them, where the difference is not
// lost in the spread of the request itself.
const alone: Record<string, (asked: Subject) => void | Promise<void>> = {
  nothing: () => {
    heard += performance.now() > 0 ? 0 : 1;
  },
  'record to a host callback': (asked) =>
    hear(record(asked, performance.now())),
  'record through a promise': (asked) =>
    resolved(record(asked, performance.now())),
};

async function sample(run: () => void | Promise<void>, count: number) {
  const start = Bun.nanoseconds();
  for (let done = 0; done < count; done++) await run();
  return (Bun.nanoseconds() - start) / count;
}

function spread(taken: number[]) {
  const sorted = taken.toSorted((left, right) => left - right);
  return {
    median: sorted.at(sorted.length >> 1) ?? Number.NaN,
    least: sorted.at(0) ?? Number.NaN,
    most: sorted.at(-1) ?? Number.NaN,
  };
}

// The three are sampled in turn, not one after another, so that a drift of
// the machine falls on all of them alike.
async function timings(
  ways: Record<string, (asked: Subject) => void | Promise<void>>,
  asked: Subject,
  count: number,
) {
  const taken = Object.keys(ways).map((): number[] => []);
  for (let round = 0; round <= samples; round++) {
    for (const [index, run] of Object.values(ways).entries()) {
      const nanoseconds = await sample(() => run(asked), count);
      if (round > 0) taken[index]?.push(nanoseconds);
    }
  }
  return taken.map(spread);
}

for (const asked of Object.values(subjects)) {
  for (const run of Object.values(tellings))
    await sample(() => run(asked), 500);
}

const requests: Record<string, string>[] = [];
const told: Record<string, string>[] = [];
for (const [name, asked] of Object.entries(subjects)) {
  const around = await timings(tellings, asked, requestsPerSample);
  const bare = await timings(alone, asked, recordsPerSample);
  const [silent] = around;
  const [idle] = bare;
  if (silent === undefined || idle === undefined) continue;
  requests.push({
    request: name,
    'µs/request': (silent.median / 1000).toFixed(2),
    'least to most': `${(silent.least / 1000).toFixed(2)} to ${(silent.most / 1000).toFixed(2)}`,
    spread: `${(((silent.most - silent.least) / silent.median) * 100).toFixed(0)}%`,
    'requests/s': (1e9 / silent.median).toFixed(0),
  });
  for (const [index, telling] of Object.keys(tellings).entries()) {
    if (index === 0) continue;
    const within = around[index]?.median ?? Number.NaN;
    const apart = bare[index]?.median ?? Number.NaN;
    told.push({
      request: name,
      telling,
      'added ns, around the request': (within - silent.median).toFixed(0),
      'added ns, alone': (apart - idle.median).toFixed(0),
      'of the request': `${(((apart - idle.median) / silent.median) * 100).toFixed(2)}%`,
    });
  }
}

console.log(
  `bun ${Bun.version}, ${samples} samples of ${requestsPerSample} requests, one at a time through the stub host and read to the end`,
);
console.table(requests);
console.log(
  `simulated outside the core: one record per request, median of ${samples} samples; alone is ${recordsPerSample} records with no request around them (${heard} values heard)`,
);
console.table(told);
