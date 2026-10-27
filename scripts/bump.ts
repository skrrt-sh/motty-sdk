import { $, Glob } from 'bun';

const version = Bun.argv[2] ?? '';

if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(version)) {
  console.error('Usage: bun run bump X.Y.Z, or X.Y.Z-rc.N');
  process.exit(1);
}

const field = /"version": "[^"]*"/;

for await (const manifest of new Glob('packages/*/package.json').scan()) {
  const text = await Bun.file(manifest).text();
  if (!field.test(text)) {
    console.error(`${manifest} has no version to set`);
    process.exit(1);
  }
  await Bun.write(manifest, text.replace(field, `"version": "${version}"`));
}

// Node and Deno give a JSON module no named exports, and the whole manifest
// imported would grow every bundle, so the SDK's version is a constant.
const constant = 'packages/core/src/version.ts';
const declared = /export const version = '[^']*';/;
const text = await Bun.file(constant).text();
if (!declared.test(text)) {
  console.error(`${constant} has no version to set`);
  process.exit(1);
}
await Bun.write(
  constant,
  text.replace(declared, `export const version = '${version}';`),
);

// The packer reads a sibling's version from the lockfile, not its manifest.
await $`bun install`;
