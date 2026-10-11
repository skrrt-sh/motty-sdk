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

// The packer reads a sibling's version from the lockfile, not its manifest.
await $`bun install`;
