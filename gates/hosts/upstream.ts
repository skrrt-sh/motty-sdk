import { event } from '../bench/rivals/upstream.ts';

export function upstream() {
  const records: unknown[] = [];
  let left: boolean[] | undefined;

  async function* answer(signal: AbortSignal) {
    yield event({ role: 'assistant', content: 'git stash ' }, null);
    const waited = left;
    if (waited !== undefined) {
      const gone = Promise.withResolvers<void>();
      signal.addEventListener('abort', () => gone.resolve());
      // A runtime that never tells of a caller leaving must not hang a test.
      await Promise.race([gone.promise, Bun.sleep(5000)]);
      waited.push(signal.aborted);
      if (signal.aborted) return;
    }
    yield event({ content: 'shelves changes' }, null);
    yield event({}, 'stop');
    yield 'data: [DONE]\n\n';
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      if (new URL(request.url).pathname === '/records') {
        records.push(await request.json());
        return new Response();
      }
      return new Response(answer(request.signal), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    address: new URL('/v1', server.url).href,
    records: new URL('/records', server.url).href,
    reported: async () => {
      while (records.length === 0) await Bun.sleep(5);
      return records.shift();
    },
    stall: () => {
      const waited: boolean[] = [];
      left = waited;
      return () => {
        left = undefined;
        return waited;
      };
    },
    stop: () => server.stop(true),
  };
}
