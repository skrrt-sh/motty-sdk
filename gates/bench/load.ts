import { assemble } from '../../packages/core/src/chain/assemble.ts';
import {
  type AnyMotty,
  type Chain,
  chain,
} from '../../packages/core/src/chain/builder.ts';
import { contractOf } from '../../packages/core/src/chain/run.ts';
import { coder } from './coder.ts';

const chainsPerSample = 2_000;
const samples = 9;
const processes = 9;

// What each builder call returned on the way to `root`: one chain per prefix
// of its steps, after the same for every part it uses and motty it routes to.
function intermediates(root: Chain, seen: Set<Chain>, found: Chain[]) {
  if (seen.has(root)) return found;
  seen.add(root);
  for (const step of root.steps) {
    if (step.kind === 'use') intermediates(step.part, seen, found);
    if (step.kind !== 'route') continue;
    for (const target of Object.values(step.table)) {
      if ('part' in target) intermediates(target.part, seen, found);
    }
  }
  for (let length = 0; length < root.steps.length; length++) {
    found.push({ ...root, steps: root.steps.slice(0, length) });
  }
  found.push(root);
  return found;
}

function microseconds(run: () => void, divisor: number) {
  const start = Bun.nanoseconds();
  run();
  return (Bun.nanoseconds() - start) / divisor / 1000;
}

function sample() {
  const lazy: AnyMotty[] = [];
  const eager: Chain[][] = [];
  for (let done = 0; done < chainsPerSample; done++) {
    lazy.push(coder());
    eager.push(intermediates(coder()[chain], new Set(), []));
  }
  const built = microseconds(() => {
    for (let done = 0; done < chainsPerSample; done++) coder();
  }, chainsPerSample);
  const once = microseconds(() => {
    for (const made of lazy) contractOf(made);
  }, chainsPerSample);
  const every = microseconds(() => {
    for (const made of eager) for (const part of made) assemble(part);
  }, chainsPerSample);
  return { built, once, every };
}

function spread(taken: number[]) {
  const sorted = taken.toSorted((left, right) => left - right);
  const median = sorted.at(sorted.length >> 1) ?? Number.NaN;
  const range = `${sorted.at(0)?.toFixed(2)} to ${sorted.at(-1)?.toFixed(2)}`;
  return { median, range };
}

// The first calls in a fresh process, before any compiler tier has seen the
// code: what a cold start pays. One way of assembling per process, or the
// second would be timed on code the first had already warmed.
function cold(eagerly: boolean) {
  const made: AnyMotty[] = [];
  const built = microseconds(() => {
    made.push(coder());
  }, 1);
  const parts: Chain[] = [];
  for (const root of made) intermediates(root[chain], new Set(), parts);
  const assembled = microseconds(() => {
    if (!eagerly) made.forEach(contractOf);
    else for (const part of parts) assemble(part);
  }, 1);
  console.log(built, assembled);
}

function fresh(way: string) {
  const child = Bun.spawnSync([process.execPath, import.meta.path, way]);
  const [built = Number.NaN, assembled = Number.NaN] = child.stdout
    .toString()
    .split(' ')
    .map(Number);
  return { built, assembled };
}

function report() {
  const once = Array.from({ length: processes }, () => fresh('once'));
  const every = Array.from({ length: processes }, () => fresh('every'));
  sample();
  const warm = Array.from({ length: samples }, sample);
  const phases = [
    {
      phase: 'build the chain',
      cold: spread(once.map(({ built }) => built)),
      warm: spread(warm.map(({ built }) => built)),
    },
    {
      phase: 'assemble once, at first use',
      cold: spread(once.map(({ assembled }) => assembled)),
      warm: spread(warm.map((taken) => taken.once)),
    },
    {
      phase: 'assemble on every builder call',
      cold: spread(every.map(({ assembled }) => assembled)),
      warm: spread(warm.map((taken) => taken.every)),
    },
  ];
  const [, lazy, eager] = phases;

  console.log(
    `bun ${Bun.version}, ${intermediates(coder()[chain], new Set(), []).length} builder calls in the chain; cold is the first call in each of ${processes} fresh processes, warm is ${samples} samples of ${chainsPerSample} chains, median microseconds per chain`,
  );
  console.table(
    phases.map(({ phase, cold, warm }) => ({
      phase,
      'cold µs': cold.median.toFixed(1),
      'cold range': cold.range,
      'warm µs': warm.median.toFixed(2),
      'warm range': warm.range,
    })),
  );
  if (lazy !== undefined && eager !== undefined) {
    console.log(
      `assembling on every builder call costs ${(eager.cold.median / lazy.cold.median).toFixed(1)} times assembling once when cold, ${(eager.warm.median / lazy.warm.median).toFixed(1)} times when warm`,
    );
  }
}

if (Bun.argv.includes('once')) cold(false);
else if (Bun.argv.includes('every')) cold(true);
else report();
