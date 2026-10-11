import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { baseSources, median, nanosecondsPerCall } from '../../measure.ts';
import { answering, upstream } from '../rivals/upstream.ts';
import type { subjects } from './subjects.ts';

const packages = ['core', 'serve', 'adapters'];

// The base's packages name each other as packages do, so each name has to
// lead to the base's own copy and not to this tree's.
async function linked(folder: string) {
  await mkdir(join(folder, 'node_modules/@mottyjs'), { recursive: true });
  for (const name of packages) {
    await symlink(
      join(folder, 'packages', name),
      join(folder, 'node_modules/@mottyjs', name),
    );
  }
}

// Each subject as a share of the same subject on the base: the median over
// pairs of single calls, the two taking turns in one process and neither
// always first. A batch timed whole read up to 1.46 with every core busy.
async function shares(base: typeof subjects, ours: typeof subjects) {
  const network = globalThis.fetch;
  globalThis.fetch = upstream;
  try {
    const { chunks } = answering('long');
    const share: Record<string, number> = {};
    for (const [name, mine] of Object.entries(ours)) {
      const theirs = base[name];
      if (theirs === undefined) {
        throw new Error(`The base commit has no subject ${name}`);
      }
      for (const run of [theirs, mine]) {
        const read = (await run()).split('token').length - 1;
        if (read < chunks) {
          throw new Error(`${name} read ${read} of ${chunks} tokens`);
        }
      }
      const taken: number[] = [];
      // The first pairs run code the engine has not compiled yet.
      for (let pair = -20; pair < 150; pair++) {
        const [first, second] =
          pair % 2 === 0 ? [theirs, mine] : [mine, theirs];
        const before = await nanosecondsPerCall(first, 1);
        const after = await nanosecondsPerCall(second, 1);
        if (pair >= 0)
          taken.push(pair % 2 === 0 ? after / before : before / after);
      }
      share[name] = median(taken);
    }
    return share;
  } finally {
    globalThis.fetch = network;
  }
}

async function loaded(folder: string, file: string) {
  await linked(folder);
  const { subjects: found }: typeof import('./subjects.ts') = await import(
    join(folder, file)
  );
  return found;
}

// This tree is timed from a copy as new to the engine as the base's. Timed
// where it stands, after tests that had run it, it read up to a twentieth
// under a copy of itself.
export async function againstBase(commit: string) {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), 'motty-serve-base-')),
  );
  try {
    const file = 'gates/bench/serve/subjects.ts';
    const [base, tree] = [join(folder, 'base'), join(folder, 'tree')];
    await mkdir(base);
    await mkdir(tree);
    await baseSources(commit, base);
    const here = packages.map((name) => `packages/${name}`);
    await $`tar -c --exclude node_modules ${here} ${file} | tar -x -C ${tree}`.quiet();
    return await shares(await loaded(base, file), await loaded(tree, file));
  } finally {
    await rm(folder, { recursive: true });
  }
}
