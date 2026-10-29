import { bundled, file } from '../../examples/coder/test/bundled.ts';
import { host } from './host.ts';
import { workerd } from './workerd.ts';

type Where = Parameters<typeof host>[1];

export const runtimes = {
  bun: async (at: Where) => {
    const answered = host(await bundled(), at);
    return {
      address: 'http://bun.test',
      fetch: (request: Request) => answered.fetch(request),
      stop: async () => {},
    };
  },
  workerd: async (at: Where) => {
    await bundled();
    const { outputs } = await Bun.build({
      entrypoints: [`${import.meta.dir}/worker.ts`],
      target: 'node',
      conditions: ['@mottyjs/source'],
    });
    const [worker] = outputs;
    if (worker === undefined) throw new Error('The worker was not built');
    const { address, stop } = await workerd({
      modules: {
        'worker.js': await worker.text(),
        'motty.js': await Bun.file(file).text(),
      },
      // Without the request signal flag workerd tells a worker nothing of a
      // caller who left, and the request runs to its end.
      flags: ['nodejs_compat', 'enable_request_signal'],
      bindings: { UPSTREAM: at.upstream, RECORDS: at.records },
    });
    return { address, fetch: (request: Request) => fetch(request), stop };
  },
};
