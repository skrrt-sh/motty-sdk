import { programs } from './programs.ts';
import { answering, upstream } from './upstream.ts';

const start = Bun.nanoseconds();
for (const [name, load] of Object.entries(programs)) {
  if (!Bun.argv.includes(name)) continue;
  globalThis.fetch = upstream;
  const expected = answering('short').text;
  const { subjects } = await load();
  const text = await subjects.stream();
  if (text !== expected) throw new Error(`${name} read ${text}`);
  console.log((Bun.nanoseconds() - start) / 1e6);
}
