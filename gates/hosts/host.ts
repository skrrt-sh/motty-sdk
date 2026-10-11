import { bearer } from '../../packages/adapters/src/jwt.ts';
import { openai } from '../../packages/adapters/src/openai.ts';
import type { Marked, Report } from '../../packages/core/src/host.ts';
import { decision } from '../../packages/decision/src/index.ts';
import { mount } from '../../packages/serve/src/index.ts';
import { fake, memory, on } from '../../packages/test/src/index.ts';

export function host(motty: Marked, at: { upstream: string; records: string }) {
  const deliveries = new Map<string, PromiseWithResolvers<void>>();

  // Whichever of the reply and its record comes first makes the entry.
  function delivery(id: string): PromiseWithResolvers<void> {
    const held = deliveries.get(id) ?? Promise.withResolvers<void>();
    deliveries.set(id, held);
    return held;
  }

  const chat = { key: 'sk-upstream', address: at.upstream };
  const edge = mount(motty, () => ({
    models: [
      fake(on(decision('typesafe/jev-latest'), { software: 0.97 })),
      openai({ ...chat, api: 'chat-completions' }),
      openai({ ...chat, api: 'chat-completions', prefix: 'anthropic' }),
    ],
    storage: memory(),
    auth: bearer({ secret: 's3cret', id: 'ada' }),
    report: (report: Report) => {
      // A reply left unread costs its connection. A record that is lost is
      // said here, as the case that waits for it knows only that none came.
      fetch(at.records, { method: 'POST', body: JSON.stringify(report) })
        .then((reply) => reply.arrayBuffer())
        .catch((thrown) => console.error('A record was not delivered', thrown))
        .finally(() => delivery(report.id).resolve());
    },
  }));

  return async (
    request: Request,
    wait: (work: Promise<unknown>) => void,
  ): Promise<Response> => {
    const reply = await edge.fetch(request);
    const id = reply.headers.get('x-request-id');
    // A runtime may stop the work soon after the response ends, and the
    // record is delivered after it.
    if (id !== null) {
      wait(delivery(id).promise.then(() => deliveries.delete(id)));
    }
    return reply;
  };
}
