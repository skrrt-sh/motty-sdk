import { expect, test } from 'bun:test';
import {
  ahead,
  bundleSize,
  coldStart,
  rivals,
  scenarios,
  timePerCall,
} from '../bench/rivals/compare.ts';

// Where motty is behind today. Each fails until its cause is fixed, and
// from then on fails for being listed here.
const behind = ['text, 20 chunks: langchain'];

const timed = Object.keys(scenarios).flatMap((scenario) =>
  rivals.map((rival) => ({ scenario, rival, name: `${scenario}: ${rival}` })),
);

async function measure() {
  return {
    time: ahead(await timePerCall(2400, 5)),
    cold: coldStart(3).ahead,
    size: (await bundleSize()).ahead,
  };
}

// Measured once for every test here, the first of which waits for it.
const measured = measure();

test('a tracing switch left on in a developer`s shell is off before any rival is loaded', () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      '-e',
      `await import(${JSON.stringify(`${import.meta.dir}/../bench/rivals/programs.ts`)}); console.log(Object.keys(process.env).filter((name) => /^LANG(SMITH|CHAIN)_/.test(name)).join())`,
    ],
    {
      env: {
        ...process.env,
        LANGSMITH_TRACING: 'true',
        LANGSMITH_TRACING_V2: 'true',
        LANGCHAIN_TRACING_V2: 'true',
        LANGCHAIN_TRACING: 'true',
        LANGCHAIN_VERBOSE: 'true',
        LANGCHAIN_CALLBACKS_BACKGROUND: 'false',
      },
    },
  );

  expect(child.stdout.toString().trim()).toBe('');
});

// A tie has to fail, so a rival must take a tenth more than motty: over
// repeated runs, some with every core busy, a tie read 1.00 at the most
// and the narrowest lead 1.43 at the least.
test.each(timed.filter(({ name }) => !behind.includes(name)))(
  'a call takes less time through motty, $name',
  async ({ scenario, rival }) => {
    const { time } = await measured;
    expect(time[scenario]?.[rival]).toBeGreaterThan(1.1);
  },
  60_000,
);

test.failing.each(timed.filter(({ name }) => behind.includes(name)))(
  'a call takes less time through motty, $name',
  async ({ scenario, rival }) => {
    const { time } = await measured;
    expect(time[scenario]?.[rival]).toBeGreaterThan(1.1);
  },
  60_000,
);

test.each(rivals)(
  'a fresh process imports motty and reads its first answer sooner than %s',
  async (rival) => {
    const { cold } = await measured;
    expect(cold[rival]).toBeGreaterThan(1.1);
  },
  60_000,
);

test.each(rivals)(
  'the minified program is smaller with motty than with %s',
  async (rival) => {
    const { size } = await measured;
    expect(size[rival]).toBeGreaterThan(1);
  },
  60_000,
);
