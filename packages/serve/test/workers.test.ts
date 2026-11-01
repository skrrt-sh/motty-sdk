import { afterAll, beforeAll, expect, test } from 'bun:test';
import { workerd } from '../../../gates/hosts/workerd.ts';

// A mount at global scope in the real runtime, where the clock stands at the
// epoch and the user agent is what the mount goes by.
let address = '';
let stop = async () => {};

beforeAll(async () => {
  const { outputs } = await Bun.build({
    entrypoints: [`${import.meta.dir}/global-scope.ts`],
    target: 'node',
    conditions: ['@mottyjs/source'],
  });
  ({ address, stop } = await workerd({
    modules: { 'worker.js': (await outputs[0]?.text()) ?? '' },
    flags: ['nodejs_compat'],
    bindings: {},
  }));
}, 30_000);

afterAll(async () => {
  await stop();
});

const written = async () => (await fetch(`${address}/written`)).json();

test('a warning made at global scope is written by the first fetch, once, and a model is dated by the time of the listing', async () => {
  expect(await written()).toEqual({ clock: 0, written: [] });

  const listed = await fetch(`${address}/v1/models`);
  const warned = {
    clock: 0,
    written: [expect.stringContaining('without a valid token')],
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
});
