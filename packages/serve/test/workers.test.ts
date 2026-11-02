import { beforeAll, describe, expect, test } from 'bun:test';
import { workerd } from '../../../gates/hosts/workerd.ts';

// A mount at global scope in the real runtime, where the clock stands at the
// epoch and the user agent is what the mount goes by.
let bundle = '';

beforeAll(async () => {
  const { outputs } = await Bun.build({
    entrypoints: [`${import.meta.dir}/global-scope.ts`],
    target: 'node',
    conditions: ['workerd', '@mottyjs/source'],
    external: ['node:*', 'cloudflare:*'],
  });
  bundle = (await outputs[0]?.text()) ?? '';
});

const secret = 'plain-words-9';

async function started(flags: { date?: string; flags?: readonly string[] }) {
  const { address, stop } = await workerd({
    ...flags,
    modules: { 'worker.js': bundle },
    bindings: { KEY: secret },
  });
  return {
    address,
    written: async () => (await fetch(`${address}/written`)).json(),
    [Symbol.asyncDispose]: stop,
  };
}

test('a warning made at global scope is written by the first fetch, once, and a model is dated by the time of the listing', async () => {
  await using worker = await started({});
  const { address, written } = worker;
  expect(await written()).toEqual({ clock: 0, written: [], given: secret });

  const listed = await fetch(`${address}/v1/models`);
  const warned = {
    clock: 0,
    written: [expect.stringContaining('without a valid token')],
    given: secret,
  };
  expect(await written()).toEqual(warned);
  expect(await listed.json()).not.toMatchObject({ data: [{ created: 0 }] });

  const read = await fetch(`${address}/v1/models/coder`, {
    headers: { 'anthropic-version': '2023-06-01' },
  });
  expect(await read.json()).toMatchObject({
    created_at: expect.not.stringContaining('1970'),
  });
  expect(await written()).toEqual(warned);
}, 30_000);

// Each of these leaves `process.env` something else: filled, empty or missing.
describe.each([
  ['a current date and no flag', {}],
  [
    'nodejs_compat on a date that fills the process',
    { date: '2026-02-24', flags: ['nodejs_compat'] },
  ],
  [
    'nodejs_compat on a date that leaves it empty',
    { date: '2025-03-31', flags: ['nodejs_compat'] },
  ],
  [
    'nodejs_als alone, with no process',
    { date: '2026-02-24', flags: ['nodejs_als'] },
  ],
])('on %s', (_name, flags) => {
  test('the options read a secret, and the reply never holds it', async () => {
    await using worker = await started(flags);
    const reply = await fetch(`${worker.address}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'coder',
        messages: [{ role: 'user', content: 'Which lock?' }],
      }),
    });

    expect(reply.status).toBe(500);
    expect(await reply.text()).not.toContain(secret);
    expect(await worker.written()).toMatchObject({ given: secret });
  }, 30_000);
});

test('a date before 2026-08-04 with neither flag is refused by the platform, by the name of the module', async () => {
  await expect(started({ date: '2026-08-03' })).rejects.toThrow(
    'No such module "node:async_hooks"',
  );
}, 30_000);
