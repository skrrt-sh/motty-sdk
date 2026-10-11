import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { baseCommit, nanosecondsPerCall, share, typeCost } from '../measure.ts';

test('the counts are read from the compiler diagnostics', () => {
  expect(
    typeCost(
      'Files:             245\nTypes:             422\nInstantiations:     42\nMemory used:    44000K\nCheck time:     0.000s\n',
    ),
  ).toEqual({ instantiations: 42, types: 422 });
});

test('diagnostics without a count are rejected', () => {
  expect(() => typeCost('Files: 245\nTypes: 422\n')).toThrow('Instantiations');
  expect(() => typeCost('Types: many\nInstantiations: 42\n')).toThrow('Types');
});

test('every iteration calls the subject once', async () => {
  let calls = 0;
  const nanoseconds = await nanosecondsPerCall(() => {
    calls++;
  }, 500);
  expect(calls).toBe(500);
  expect(nanoseconds).toBeGreaterThan(0);
});

test('a burst that slows one side in a third of the rounds leaves the share where it was', async () => {
  const [theirs, ours] = [() => {}, () => {}];
  let timed = 0;
  expect(
    await share(theirs, ours, (subject) => {
      const round = timed++ >> 1;
      if (round % 3 === 0) return subject === ours ? 400 : 100;
      return subject === ours ? 117 : 100;
    }),
  ).toBeCloseTo(1.17);
});

test('the rounds the engine has not compiled yet are left out, and the two take turns at going first', async () => {
  const [theirs, ours] = [() => {}, () => {}];
  const order: string[] = [];
  expect(
    await share(theirs, ours, (subject) => {
      order.push(subject === ours ? 'ours' : 'theirs');
      return subject === ours && order.length <= 200 ? 900 : 100;
    }),
  ).toBe(1);
  expect(order.slice(0, 4)).toEqual(['theirs', 'ours', 'ours', 'theirs']);
  expect(order.filter((side) => side === 'ours')).toHaveLength(
    order.length / 2,
  );
});

test('a first commit has no base to be timed against, and the next has its parent', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'motty-first-'));
  try {
    const git = (...words: string[]) =>
      $`git -c user.name=gate -c user.email=gate@motty.test -c commit.gpgsign=false ${words}`
        .cwd(folder)
        .quiet();
    await git('init', '--initial-branch=main');
    await git('commit', '--allow-empty', '--message=first');
    expect(await baseCommit(folder)).toBeUndefined();

    await git('commit', '--allow-empty', '--message=second');
    const head = (await git('rev-parse', 'HEAD')).text().trim();
    expect(await baseCommit(folder)).toBe(`${head}^`);
  } finally {
    await rm(folder, { recursive: true });
  }
});

test('an SDK error raised in the bundle the example ships keeps the name of its class', async () => {
  await $`bun run build`.cwd('examples/coder').quiet();
  const folder = await mkdtemp(join(tmpdir(), 'motty-bundle-'));
  // The bundle exports the motty alone, so a copy that also exports one of
  // its error classes is what lets an error out.
  await Bun.write(
    join(folder, 'motty.js'),
    `${await Bun.file('examples/coder/dist/motty.js').text()}\nexport { Overloaded };\n`,
  );
  const loaded: unknown = await import(join(folder, 'motty.js'));
  await rm(folder, { recursive: true });

  expect(() => {
    throw Reflect.construct(Object(loaded).Overloaded, ['busy']);
  }).toThrow(
    expect.objectContaining({ name: 'Overloaded', code: 'overloaded' }),
  );
});
