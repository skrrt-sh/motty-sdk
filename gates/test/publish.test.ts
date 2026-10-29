import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { $, Glob } from 'bun';
import { z } from 'zod';
import { workerd } from '../hosts/workerd.ts';

const packed: {
  name: string;
  files: string[];
  contents: Map<string, File>;
  manifest: string;
}[] = [];

const entries = z.object({
  exports: z.record(
    z.string(),
    z.object({
      types: z.string(),
      bun: z.string().optional(),
      workerd: z.string().optional(),
      default: z.string().optional(),
    }),
  ),
});

let folder = '';
let project = '';

// One at a time: every pack builds all the packages into one folder before
// it copies its own. A release names the folder of the tarballs it is about
// to publish, so that those very files are the ones checked.
beforeAll(async () => {
  const { TARBALLS: given } = Bun.env;
  folder = await mkdtemp(join(tmpdir(), 'motty-publish-'));
  const tarballs = given ?? folder;
  if (given === undefined) {
    for await (const manifest of new Glob('packages/*/package.json').scan()) {
      await $`bun pm pack --destination ${folder} --quiet`
        .cwd(dirname(manifest))
        .quiet();
    }
  }
  for (const tarball of (
    await Array.fromAsync(new Glob('*.tgz').scan(tarballs))
  ).sort()) {
    const contents = await new Bun.Archive(
      await Bun.file(join(tarballs, tarball)).bytes(),
    ).files();
    packed.push({
      name: tarball.replace(/-\d.*/, ''),
      files: [...contents.keys()].sort(),
      contents,
      manifest: (await contents.get('package/package.json')?.text()) ?? '{}',
    });
  }

  // Installed as a registry would, with the one dependency from outside.
  project = join(folder, 'project');
  for (const { name, contents } of packed) {
    const installed = join(
      project,
      'node_modules',
      name.replace('mottyjs-', '@mottyjs/'),
    );
    for (const [path, file] of contents) {
      await Bun.write(join(installed, path.replace('package/', '')), file);
    }
  }
  await symlink(
    Bun.resolveSync(
      'jose',
      `${import.meta.dir}/../../packages/adapters`,
    ).replace(/\/dist\/.*/, ''),
    join(project, 'node_modules', 'jose'),
  );
  await symlink(
    `${import.meta.dir}/../../node_modules/@cloudflare`,
    join(project, 'node_modules', '@cloudflare'),
  );
  await Bun.write(join(project, 'package.json'), '{ "type": "module" }');
  for (const host of ['bun.ts', 'worker.ts']) {
    await Bun.write(
      join(project, host),
      Bun.file(`${import.meta.dir}/../hosts/packed/${host}`),
    );
  }
}, 60_000);

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
});

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

test('a tarball holds sources, their JavaScript and declarations, the manifest, the readme and the licence, and nothing else', () => {
  const allowed =
    /^package\/(package\.json|README\.md|LICENSE|src\/.+\.ts|dist\/.+\.(js|d\.ts))$/;

  expect(
    packed.flatMap(({ name, files }) =>
      files
        .filter((file) => !allowed.test(file) || /\.(test|live)\./.test(file))
        .map((file) => `${name}: ${file}`),
    ),
  ).toEqual([]);
});

test('a tarball holds the readme, the licence, and the source, the JavaScript and the declaration of every entry its manifest exports', () => {
  expect(
    packed.flatMap(({ name, files, manifest }) =>
      [
        './README.md',
        './LICENSE',
        ...Object.values(entries.parse(JSON.parse(manifest)).exports).flatMap(
          ({ types, ...code }) => [
            types,
            ...Object.values(code).filter((path) => path !== undefined),
          ],
        ),
      ]
        .map((path) => path.replace('./', 'package/'))
        .filter((file) => !files.includes(file))
        .map((file) => `${name}: ${file}`),
    ),
  ).toEqual([]);
});

test('the version a description carries is the one the core package is published at', async () => {
  const core = packed.find(({ name }) => name === 'mottyjs-core');
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(core?.manifest ?? '{}'));

  expect(await core?.contents.get('package/dist/version.js')?.text()).toContain(
    `export const version = '${version}';`,
  );
});

// A Workers consumer that checks every library it reads and holds no
// runtime's types: a declaration naming Bun's or Node's globals fails it.
// The Durable Object entry names the Workers types, as its host holds them.
test.each([
  [
    'every entry of the packed packages but the Durable Object adapter',
    'web-standard libraries',
    ['DOM', 'DOM.Iterable'],
    [],
  ],
  [
    'the Durable Object adapter',
    'Workers types',
    [],
    ['@cloudflare/workers-types'],
  ],
])(
  '%s type-checks with library checks on and only the %s',
  async (_entries, _libraries, lib, types) => {
    const cloudflare = types.length > 0;
    const specifiers = packed
      .flatMap(({ name, manifest }) =>
        Object.keys(entries.parse(JSON.parse(manifest)).exports).map(
          (path) => `${name.replace('mottyjs-', '@mottyjs/')}${path.slice(1)}`,
        ),
      )
      .filter(
        (specifier) =>
          (specifier === '@mottyjs/adapters/cloudflare') === cloudflare,
      );
    const consumer = cloudflare ? 'workers' : 'consumer';
    await Bun.write(
      join(project, `${consumer}.ts`),
      specifiers
        .map((specifier, at) => `export * as entry${at} from '${specifier}';`)
        .join('\n'),
    );
    await Bun.write(
      join(project, `${consumer}.json`),
      JSON.stringify({
        compilerOptions: {
          lib: ['ES2024', ...lib],
          target: 'ES2024',
          module: 'ES2022',
          moduleResolution: 'Bundler',
          types,
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        files: [`${consumer}.ts`],
      }),
    );
    const checked = await $`bun tsc -p ${join(project, `${consumer}.json`)}`
      .nothrow()
      .quiet();

    expect([checked.stdout.toString(), checked.exitCode]).toEqual(['', 0]);
  },
  30_000,
);

test('on Bun, the packed packages serve a motty, read as their sources', async () => {
  const served = await $`${process.execPath} bun.ts`
    .cwd(project)
    .nothrow()
    .quiet();

  expect([
    served.stderr.toString(),
    JSON.parse(served.stdout.toString()),
  ]).toEqual([
    '',
    { resolved: 'src/index.ts', whole: '200 true', streamed: '200 true' },
  ]);
}, 30_000);

// As a Workers bundler builds: the platform's conditions, and Node's modules
// left to the runtime's compatibility layer.
test('bundled for Workers, the packed packages answer in workerd', async () => {
  const { outputs } = await Bun.build({
    entrypoints: [join(project, 'worker.ts')],
    target: 'browser',
    conditions: ['workerd', 'worker'],
    external: ['node:*'],
  });
  const bundle = (await outputs[0]?.text()) ?? '';
  const { address, stop } = await workerd({
    modules: { 'worker.js': bundle },
    flags: ['nodejs_compat'],
    bindings: {},
  });
  try {
    const replies = await Promise.all(
      [false, true].map(async (stream) => {
        const reply = await fetch(`${address}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'echo',
            stream,
            messages: [{ role: 'user', content: 'Which lock?' }],
          }),
        });
        return `${reply.status} ${(await reply.text()).includes('Use a mutex.')}`;
      }),
    );

    expect([
      bundle.includes('@mottyjs/core/dist/'),
      bundle.includes('@mottyjs/core/src/'),
      replies,
    ]).toEqual([true, false, ['200 true', '200 true']]);
  } finally {
    await stop();
  }
}, 30_000);

// Redis is Bun's own client, so that one entry is exported to Bun alone. The
// Durable Object adapter imports the runtime's own module, left to workerd.
test('bundled for Workers, every entry of the packed packages but the Redis adapter loads in workerd', async () => {
  const specifiers = packed.flatMap(({ name, manifest }) =>
    Object.keys(entries.parse(JSON.parse(manifest)).exports)
      .map((path) => `${name.replace('mottyjs-', '@mottyjs/')}${path.slice(1)}`)
      .filter((specifier) => specifier !== '@mottyjs/adapters/redis'),
  );
  await Bun.write(
    join(project, 'entries.ts'),
    [
      ...specifiers.map(
        (specifier, at) => `import * as entry${at} from '${specifier}';`,
      ),
      `const loaded = [${specifiers.map((_, at) => `entry${at}`).join(', ')}];`,
      'export default { fetch: () => new Response(String(loaded.length)) };',
    ].join('\n'),
  );
  const { outputs } = await Bun.build({
    entrypoints: [join(project, 'entries.ts')],
    target: 'browser',
    conditions: ['workerd', 'worker'],
    external: ['node:*', 'cloudflare:*'],
  });
  const { address, stop } = await workerd({
    modules: { 'worker.js': (await outputs[0]?.text()) ?? '' },
    flags: ['nodejs_compat'],
    bindings: {},
  });
  try {
    expect(await (await fetch(address)).text()).toBe(String(specifiers.length));
  } finally {
    await stop();
  }
}, 30_000);

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
