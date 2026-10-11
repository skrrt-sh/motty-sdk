import { expect, test } from 'bun:test';
import { devDependencies } from '../../package.json';
import { rivals } from '../bench/rivals/compare.ts';

const root = `${import.meta.dir}/../..`;

async function imported(path: string) {
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  return transpiler
    .scanImports(await Bun.file(`${root}/${path}`).text())
    .map(({ path: name }) => name);
}

// What a rival's program imports and motty's own does not is the rival:
// the package's name, whichever of its entries is read.
async function packages() {
  const own = await imported('gates/bench/rivals/motty.ts');
  const theirs = await Promise.all(
    rivals.map((rival) => imported(`gates/bench/rivals/${rival}.ts`)),
  );
  return [
    ...new Set(
      theirs
        .flat()
        .filter((name) => !name.startsWith('.') && !own.includes(name))
        .map((name) =>
          name
            .split('/')
            .slice(0, name.startsWith('@') ? 2 : 1)
            .join('/'),
        ),
    ),
  ];
}

test('the rivals are the packages the gate`s programs import, each installed for the gate alone', async () => {
  const names = await packages();

  expect(names.length).toBeGreaterThanOrEqual(rivals.length);
  expect(names.filter((name) => !(name in devDependencies))).toEqual([]);
});

test('no file of a package or an example imports a rival', async () => {
  const names = await packages();
  const found: string[] = [];
  const files = new Bun.Glob('{packages,examples}/**/*.{ts,tsx,mts,js,mjs}');
  for await (const path of files.scan({ cwd: root })) {
    if (path.includes('node_modules/')) continue;
    for (const name of await imported(path)) {
      const rival = names.find(
        (held) => name === held || name.startsWith(`${held}/`),
      );
      if (rival !== undefined) found.push(`${path} imports ${name}`);
    }
  }

  expect(found).toEqual([]);
});
