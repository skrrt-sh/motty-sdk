import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { subjects } from './bench/subjects.ts';

const samples = 15;

export async function build(entry: string) {
  const { outputs, metafile } = await Bun.build({
    entrypoints: [entry],
    target: 'node',
    minify: true,
    metafile: true,
  });
  if (metafile === undefined) {
    throw new Error(`The build of ${entry} returned no metafile`);
  }
  const texts = await Promise.all(outputs.map((output) => output.text()));
  return {
    bytes: Object.values(metafile.outputs).reduce(
      (sum, output) => sum + output.bytes,
      0,
    ),
    hash: Bun.hash(texts.join('\n')).toString(16),
    files: Object.keys(metafile.inputs).sort(),
    // Read from the inputs: the output no longer shows a dependency the
    // bundler inlined.
    imports: [
      ...new Set(
        Object.values(metafile.inputs).flatMap((input) =>
          input.imports.map((found) => found.path),
        ),
      ),
    ].sort(),
  };
}

function count(diagnostics: string, label: string) {
  const digits = new RegExp(`^${label}:\\s+(\\d+)\\s*$`, 'm').exec(
    diagnostics,
  )?.[1];
  if (digits === undefined) {
    throw new Error(`The compiler reported no ${label} count`);
  }
  return Number(digits);
}

export function typeCost(diagnostics: string) {
  return {
    instantiations: count(diagnostics, 'Instantiations'),
    types: count(diagnostics, 'Types'),
  };
}

export async function nanosecondsPerCall(
  subject: () => unknown,
  iterations = 5000,
) {
  const start = Bun.nanoseconds();
  for (let call = 0; call < iterations; call++) await subject();
  return (Bun.nanoseconds() - start) / iterations;
}

export function median(taken: number[]) {
  const sorted = taken.toSorted((left, right) => left - right);
  return sorted.at(sorted.length >> 1) ?? Number.NaN;
}

// The file an author ships, as the example's own build script writes it.
async function shipped() {
  await $`bun run build`.cwd('examples/coder').quiet();
  const written = await Bun.file('examples/coder/dist/motty.js').bytes();
  return { bytes: written.length, hash: Bun.hash(written).toString(16) };
}

const builds = {
  core: () => build('packages/core/src/index.ts'),
  coder: shipped,
};

// Where the branch left the main branch, or the parent of a commit on it.
// CI fetches no main branch and checks out a pull request merged into it,
// so the parent is the base there too.
export async function baseCommit() {
  const head = (await $`git rev-parse HEAD`.text()).trim();
  const left = await $`git merge-base HEAD origin/main`.nothrow().quiet();
  const commit = left.text().trim();
  return left.exitCode !== 0 || commit === head ? `${head}^` : commit;
}

// The packages and the bench of a commit, and the path there of one bench
// file. A base older than that file is timed through this tree's, against
// its own packages.
export async function baseSources(
  commit: string,
  folder: string,
  bench: string,
) {
  const copied =
    await $`git archive ${commit} packages gates/bench | tar -x -C ${folder}`
      .nothrow()
      .quiet();
  if (copied.exitCode !== 0) {
    throw new Error(
      `The base commit ${commit} has no packages and bench to time against: ${copied.stderr.toString().trim()}`,
    );
  }
  const file = join(folder, bench);
  if (!(await Bun.file(file).exists())) await Bun.write(file, Bun.file(bench));
  return file;
}

async function subjectsOf(commit: string, folder: string) {
  const loaded: typeof import('./bench/subjects.ts') = await import(
    await baseSources(commit, folder, 'gates/bench/subjects.ts')
  );
  return loaded.subjects;
}

// Each subject as a share of the same subject on the base commit: the median
// over samples the two take in turn in one process, neither always first.
async function againstBase() {
  const commit = await baseCommit();
  const folder = await mkdtemp(join(tmpdir(), 'motty-base-'));
  try {
    const base = await subjectsOf(commit, folder);
    const shares = Object.keys(subjects).map((): number[] => []);
    for (let round = 0; round <= samples; round++) {
      for (const [index, [name, ours]] of Object.entries(subjects).entries()) {
        const theirs = base[name];
        if (theirs === undefined) {
          throw new Error(`The base commit ${commit} has no subject ${name}`);
        }
        const [first, second] =
          round % 2 === 0 ? [theirs, ours] : [ours, theirs];
        const before = await nanosecondsPerCall(first);
        const after = await nanosecondsPerCall(second);
        const share = round % 2 === 0 ? after / before : before / after;
        if (round > 0) shares[index]?.push(share);
      }
    }
    const timePerCall: Record<string, number> = {};
    for (const [index, name] of Object.keys(subjects).entries()) {
      timePerCall[name] = median(shares[index] ?? []);
    }
    return timePerCall;
  } finally {
    await rm(folder, { recursive: true });
  }
}

export async function measure() {
  const size: Record<string, number> = {};
  const reproducibility: Record<string, string[]> = {};
  for (const [name, built] of Object.entries(builds)) {
    const first = await built();
    const second = await built();
    size[name] = first.bytes;
    reproducibility[name] = [first.hash, second.hash];
  }

  return {
    size,
    reproducibility,
    typeCost: typeCost(
      await $`bun tsc -p gates/tsconfig.type-cost.json --extendedDiagnostics`
        .quiet()
        .text(),
    ),
    timePerCall: await againstBase(),
  };
}

export type Measured = Awaited<ReturnType<typeof measure>>;
