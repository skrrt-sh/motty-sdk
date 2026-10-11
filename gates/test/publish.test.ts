import { beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { $, Glob } from 'bun';
import { z } from 'zod';

const packed: { name: string; files: string[]; manifest: string }[] = [];

// One at a time: every pack writes the declarations of all the packages
// to one folder before it copies its own. A release names the folder of the
// tarballs it is about to publish, so that those very files are the ones checked.
beforeAll(async () => {
  const { TARBALLS: given } = Bun.env;
  const folder = given ?? (await mkdtemp(join(tmpdir(), 'motty-publish-')));
  if (given === undefined) {
    for await (const manifest of new Glob('packages/*/package.json').scan()) {
      await $`bun pm pack --destination ${folder} --quiet`
        .cwd(dirname(manifest))
        .quiet();
    }
  }
  const tarballs = await Array.fromAsync(new Glob('*.tgz').scan(folder));
  for (const tarball of tarballs.sort()) {
    const files = await new Bun.Archive(
      await Bun.file(join(folder, tarball)).bytes(),
    ).files();
    const manifest = (await files.get('package/package.json')?.text()) ?? '{}';
    packed.push({
      name: tarball.replace(/-\d.*/, ''),
      files: [...files.keys()].sort(),
      manifest,
    });
  }
  if (given === undefined) await rm(folder, { recursive: true });
}, 60_000);

test('all eight packages are packed', () => {
  expect(packed.map(({ name }) => name)).toEqual([
    'mottyjs-adapters',
    'mottyjs-auth',
    'mottyjs-core',
    'mottyjs-decision',
    'mottyjs-serve',
    'mottyjs-settings',
    'mottyjs-store',
    'mottyjs-test',
  ]);
});

test('a tarball holds sources, their declarations, the manifest, the readme and the licence, and nothing else', () => {
  const allowed =
    /^package\/(package\.json|README\.md|LICENSE|src\/.+\.ts|dist\/.+\.d\.ts)$/;

  expect(
    packed.flatMap(({ name, files }) =>
      files
        .filter((file) => !allowed.test(file) || /\.(test|live)\./.test(file))
        .map((file) => `${name}: ${file}`),
    ),
  ).toEqual([]);
});

test('a tarball holds the readme, the licence, and the source and the declaration of every entry its manifest exports', () => {
  expect(
    packed.flatMap(({ name, files, manifest }) =>
      [
        './README.md',
        './LICENSE',
        ...Object.values(
          z
            .object({
              exports: z.record(
                z.string(),
                z.object({ types: z.string(), default: z.string() }),
              ),
            })
            .parse(JSON.parse(manifest)).exports,
        ).flatMap((entry) => [entry.default, entry.types]),
      ]
        .map((path) => path.replace('./', 'package/'))
        .filter((file) => !files.includes(file))
        .map((file) => `${name}: ${file}`),
    ),
  ).toEqual([]);
});

test('no packed manifest keeps a workspace or a catalog reference', () => {
  expect(
    packed.flatMap(({ name, manifest }) =>
      (manifest.match(/"[^"]+": "(workspace|catalog):[^"]*"/g) ?? []).map(
        (reference) => `${name}: ${reference}`,
      ),
    ),
  ).toEqual([]);
});

test('every package carries the same version', () => {
  expect(
    new Set(
      packed.map(
        ({ manifest }) =>
          z.object({ version: z.string() }).parse(JSON.parse(manifest)).version,
      ),
    ).size,
  ).toBe(1);
});

// The packer reads a sibling's version from the lockfile, so a lockfile left
// behind by a version bump would publish packages that ask for the old ones.
test('every package depends on the others at the version it carries', () => {
  expect(
    packed.flatMap(({ name, manifest }) => {
      const { version, dependencies } = z
        .object({
          version: z.string(),
          dependencies: z.record(z.string(), z.string()).default({}),
        })
        .parse(JSON.parse(manifest));
      return Object.entries(dependencies)
        .filter(
          ([dependency, range]) =>
            dependency.startsWith('@mottyjs/') && range !== version,
        )
        .map(([dependency, range]) => `${name}: ${dependency} ${range}`);
    }),
  ).toEqual([]);
});
