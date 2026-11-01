import type { Storage } from '@mottyjs/core/host';
import { workerd } from './workerd.ts';

export const value = { role: 'user', text: 'x'.repeat(512) };

export function timedCalls(storage: Storage, run: string) {
  return {
    get: () => storage.get(`${run}:timed`),
    set: () => storage.set(`${run}:timed`, value, { ttl: 60_000 }),
    increment: () => storage.increment?.(`${run}:counted`, 1, { ttl: 60_000 }),
  };
}

// The speed worker in workerd, with its `timed` key written. `made` gives one
// request of `calls` calls, and leaves the reply's body to whoever wants it.
export async function speedWorker() {
  const { outputs } = await Bun.build({
    entrypoints: [
      `${import.meta.dir}/../../packages/adapters/test/speed.worker.ts`,
    ],
    target: 'browser',
    external: ['cloudflare:workers'],
  });
  const { address, stop } = await workerd({
    modules: { 'worker.js': (await outputs[0]?.text()) ?? '' },
    flags: ['delete_all_deletes_alarm'],
    bindings: {},
    objects: { STORAGE: 'MottyStorage', BARE: 'BareStorage' },
  });
  function made(call: string, calls: number) {
    return async () => {
      const reply = await fetch(
        `${address}/?${new URLSearchParams({ call, calls: `${calls}` })}`,
      );
      if (!reply.ok) throw new Error(await reply.text());
      return reply;
    };
  }
  await made('motty set', 1)();
  await made('bare set', 1)();
  return { made, stop };
}
