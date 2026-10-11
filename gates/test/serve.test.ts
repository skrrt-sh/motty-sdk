import { expect, test } from 'bun:test';
import { againstBase, serves } from '../bench/serve/compare.ts';
import { subjects } from '../bench/serve/subjects.ts';
import { baseCommit } from '../measure.ts';

const commit = await baseCommit();

// Measured once for every test here, the first of which waits for it.
const measured =
  commit === undefined || !(await serves(commit))
    ? undefined
    : againstBase(commit);

// A quarter over fails: room for what a feature honestly costs. The same
// code against itself read 0.95 to 1.06 over repeated runs, some with
// every core busy, and one made half again slower 1.43 at the least.
test.skipIf(measured === undefined).each(Object.keys(subjects))(
  'a served request takes no more than a quarter over the base commit, %s',
  async (name) => {
    expect((await measured)?.[name]).toBeLessThan(1.25);
  },
  60_000,
);
