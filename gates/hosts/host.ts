import { bearer } from '../../packages/adapters/src/jwt.ts';
import { openai } from '../../packages/adapters/src/openai.ts';
import type { Marked, Report } from '../../packages/core/src/host.ts';
import { decision } from '../../packages/decision/src/index.ts';
import { mount } from '../../packages/serve/src/index.ts';
import { fake, memory, on } from '../../packages/test/src/index.ts';

export function host(motty: Marked, at: { upstream: string; records: string }) {
  const chat = { key: 'sk-upstream', address: at.upstream };
  return mount(motty, () => ({
    models: [
      fake(on(decision('typesafe/jev-latest'), { software: 0.97 })),
      openai({ ...chat, api: 'chat-completions' }),
      openai({ ...chat, api: 'chat-completions', prefix: 'anthropic' }),
    ],
    storage: memory(),
    auth: bearer({ secret: 's3cret', id: 'ada' }),
    // A reply left unread costs its connection. A record that is lost is
    // said here, as the case that waits for it knows only that none came.
    report: (report: Report) =>
      fetch(at.records, { method: 'POST', body: JSON.stringify(report) })
        .then((reply) => reply.arrayBuffer())
        .catch((thrown) => console.error('A record was not delivered', thrown)),
  }));
}
