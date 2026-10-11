import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

test('both entries and a plugin written against them emit declaration files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'motty-declarations-'));
  const compiled =
    await $`bun tsc -p gates/tsconfig.declarations.json --outDir ${folder}`
      .nothrow()
      .quiet();
  const declared = await Promise.all(
    [
      'packages/core/src/index.d.ts',
      'packages/core/src/host.d.ts',
      'gates/plugin.d.ts',
    ].map((file) => Bun.file(join(folder, file)).exists()),
  );
  await rm(folder, { recursive: true });

  expect([compiled.stdout.toString(), compiled.exitCode, declared]).toEqual([
    '',
    0,
    [true, true, true],
  ]);
}, 30_000);
