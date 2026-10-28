import { $ } from 'bun';
import { build, median } from '../../measure.ts';
import { programs } from './programs.ts';
import { answering, type replies, upstream } from './upstream.ts';

type Subject = keyof Awaited<ReturnType<typeof programs.motty>>['subjects'];

// The narrowest lead is timed over more rounds: its median moves the most.
function scenario(reply: keyof typeof replies, subject: Subject, rounds = 1) {
  return { reply, subject, rounds };
}

export const scenarios = {
  'text, 20 chunks': scenario('short', 'text', 2),
  'stream, 20 chunks': scenario('short', 'stream'),
  'stream, 200 chunks': scenario('long', 'stream'),
  'stream of an object read by an output schema, 20 chunks': scenario(
    'object',
    'object',
  ),
  'serve, 200 chunks': scenario('long', 'serve'),
};

export const rivals = Object.keys(programs).filter((name) => name !== 'motty');

function tokens(text: string) {
  return text.split('token').length - 1;
}

// One SDK's garbage is collected before the next is timed, so that each
// pays for its own alone.
async function sample(run: () => Promise<string>, calls: number) {
  Bun.gc(true);
  const taken: number[] = [];
  for (let call = 0; call < calls; call++) {
    const start = Bun.nanoseconds();
    await run();
    taken.push(Bun.nanoseconds() - start);
  }
  return taken;
}

// The SDKs take turns in one process and each round begins with another of
// them, so a drift of the machine falls on all alike; the first round is
// discarded. A short answer is asked more often: its time is the noisier.
export async function timePerCall(chunksPerSample: number, rounds: number) {
  const loaded = await Promise.all(
    Object.entries(programs).map(async ([name, load]) => ({
      name,
      subjects: (await load()).subjects,
    })),
  );
  const network = globalThis.fetch;
  globalThis.fetch = upstream;
  try {
    const timed: Record<string, Record<string, number[][]>> = {};
    for (const [name, { reply, subject, rounds: times }] of Object.entries(
      scenarios,
    )) {
      const { text, chunks } = answering(reply);
      const expected = tokens(text);
      const calls = Math.ceil(chunksPerSample / chunks);
      const taken = loaded.map((): number[][] => []);
      for (let round = 0; round <= rounds * times; round++) {
        for (const turn of loaded.keys()) {
          const index = (round + turn) % loaded.length;
          const run = loaded[index]?.subjects[subject];
          if (run === undefined) continue;
          const read = tokens(await run());
          if (read !== expected) {
            throw new Error(
              `${loaded[index]?.name} read ${read} of ${expected} tokens in ${name}`,
            );
          }
          const sampled = await sample(run, calls);
          if (round > 0) taken[index]?.push(sampled);
        }
      }
      timed[name] = Object.fromEntries(
        loaded.map((sdk, index) => [sdk.name, taken[index] ?? []]),
      );
    }
    return timed;
  } finally {
    globalThis.fetch = network;
  }
}

// How many times motty's cost each rival's is: the median over the rounds
// of what the two took in the same round.
function shares(taken: Record<string, number[]>) {
  const { motty: ours = [] } = taken;
  return Object.fromEntries(
    rivals.map((rival) => [
      rival,
      median(
        (taken[rival] ?? []).map(
          (theirs, round) => theirs / (ours[round] ?? Number.NaN),
        ),
      ),
    ]),
  );
}

export function ahead(timed: Awaited<ReturnType<typeof timePerCall>>) {
  return Object.fromEntries(
    Object.entries(timed).map(([name, sdks]) => [
      name,
      shares(
        Object.fromEntries(
          Object.entries(sdks).map(([sdk, taken]) => [sdk, taken.map(median)]),
        ),
      ),
    ]),
  );
}

// Milliseconds from the first line of a program to the end of its first
// streamed call, each in a fresh process, the SDKs taking turns.
export function coldStart(rounds: number) {
  const names = Object.keys(programs);
  const taken: Record<string, number[]> = Object.fromEntries(
    names.map((name) => [name, []]),
  );
  for (let round = 0; round < rounds; round++) {
    for (const turn of names.keys()) {
      const name = names[(round + turn) % names.length] ?? 'motty';
      const child = Bun.spawnSync([
        process.execPath,
        `${import.meta.dir}/cold.ts`,
        name,
      ]);
      taken[name]?.push(Number(child.stdout.toString()));
    }
  }
  return { taken, ahead: shares(taken) };
}

export async function bundleSize() {
  const bytes: Record<string, number[]> = {};
  for (const name of Object.keys(programs)) {
    bytes[name] = [(await build(`gates/bench/rivals/${name}.ts`)).bytes];
  }
  return { bytes, ahead: shares(bytes) };
}

function percentile(sorted: number[], share: number) {
  return sorted.at(Math.floor((sorted.length - 1) * share)) ?? Number.NaN;
}

async function report() {
  const chunksPerSample = 20_000;
  const rounds = 15;
  // First and from a lean process: a start of a few milliseconds is the one
  // most moved by a parent that holds every SDK and has just timed them all.
  const cold = coldStart(21);
  const timed = await timePerCall(chunksPerSample, rounds);
  const size = await bundleSize();

  console.log(
    `bun ${Bun.version}; ${rounds} rounds of ${chunksPerSample} chunks after one discarded (twice the rounds for text), the SDKs taking turns in one process; microseconds per call over every call, and each rival's cost as a multiple of motty's, the median over the rounds`,
  );
  console.log(
    (await $`bun pm ls`.text())
      .split('\n')
      .filter((line) => /ai|langchain|mastra|zod/.test(line))
      .join('\n'),
  );
  const multiples = ahead(timed);
  console.table(
    Object.entries(timed).flatMap(([name, sdks]) =>
      Object.entries(sdks).map(([sdk, taken]) => {
        const sorted = taken.flat().toSorted((left, right) => left - right);
        return {
          scenario: name,
          sdk,
          'median µs': (percentile(sorted, 0.5) / 1000).toFixed(1),
          'p99 µs': (percentile(sorted, 0.99) / 1000).toFixed(1),
          'of motty': multiples[name]?.[sdk]?.toFixed(2) ?? '',
        };
      }),
    ),
  );
  console.table(
    Object.keys(programs).map((sdk) => ({
      sdk,
      'cold start ms': median(cold.taken[sdk] ?? []).toFixed(1),
      'of motty': cold.ahead[sdk]?.toFixed(2) ?? '',
      'bundle bytes': size.bytes[sdk]?.at(0),
      'of motty ': size.ahead[sdk]?.toFixed(2) ?? '',
    })),
  );
}

if (import.meta.main) await report();
