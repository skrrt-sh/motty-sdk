import { event } from '../bench/rivals/upstream.ts';

export function upstream() {
  const records: unknown[] = [];
  // Bun's server does not say how many connections it took, and a caller's
  // port is one of them. Records come here too, so only a call's is kept.
  const called = new Set<number>();
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
    fetch: async (request, server) => {
      if (new URL(request.url).pathname === '/records') {
        records.push(await request.json());
        return new Response();
      }
      const caller = server.requestIP(request);
      if (caller !== null) called.add(caller.port);
      return new Response(answer(request.signal), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    address: new URL('/v1', server.url).href,
    records: new URL('/records', server.url).href,
    connections: () => called.size,
    reported: async () => {
      // A record that was lost fails its case by name, not by the clock.
      for (let waits = 0; records.length === 0; waits += 1) {
        if (waits === 600) throw new Error('No record came in three seconds');
        await Bun.sleep(5);
      }
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
