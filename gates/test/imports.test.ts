import { expect, test } from 'bun:test';
import { build } from '../measure.ts';

test('a bundle of the core imports its own files, the async context and nothing else', async () => {
  const author = await build('packages/core/src/index.ts');
  const host = await build('packages/core/src/host.ts');

  expect(
    author.imports.filter((path) => !path.startsWith('packages/core/src/')),
  ).toEqual(['node:async_hooks']);
  expect(
    host.imports.filter((path) => !path.startsWith('packages/core/src/')),
  ).toEqual(['node:async_hooks']);
});

test('a bundle of the example is built from its own files, the core, the plugins and its schema library, and imports the async context and nothing else', async () => {
  const { files, imports } = await build('examples/coder/src/motty.ts');
  const own =
    /^(examples\/coder\/src|packages\/(core|auth|store|settings|decision)\/src|node_modules\/\.bun\/zod@[^/]+\/node_modules\/zod)\//;

  expect(files.filter((path) => !own.test(path))).toEqual([]);
  expect(files).not.toContain('packages/core/src/host-options.ts');
  // A re-export nothing reads is left unresolved, and listed as written.
  expect(
    imports.filter((path) => !own.test(path) && !path.startsWith('./')),
  ).toEqual(['node:async_hooks']);
});
