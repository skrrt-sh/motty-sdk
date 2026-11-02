import { afterAll, beforeAll, expect, test } from 'bun:test';
import { z } from 'zod';
import { event } from '../bench/rivals/upstream.ts';
import { workerd } from '../hosts/workerd.ts';

// Requests overlapping in one isolate of the real runtime. The log is read
// whole once workerd has stopped, so nothing it said can be missed under load,
// as a tail of a deployed Worker may.
const record = z.object({ id: z.string(), outcome: z.string() });
const records: z.infer<typeof record>[] = [];
const asking = z.object({
  messages: z.array(
    z.object({
      content: z.union([z.string(), z.tuple([z.object({ text: z.string() })])]),
    }),
  ),
});
const provider = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/records') {
      const sent = record.safeParse(await request.json());
      if (sent.success) records.push(sent.data);
      return new Response('{}');
    }
    const { messages } = asking.parse(await request.json());
    const asked = messages.at(-1)?.content;
    const text = typeof asked === 'string' ? asked : asked?.[0].text;
    async function* answer() {
      await Bun.sleep(Math.random() * 20);
      yield event({ role: 'assistant', content: `echo ${text}` }, null);
      await Bun.sleep(Math.random() * 20);
      yield event({}, 'stop');
      yield 'data: [DONE]\n\n';
    }
    return new Response(answer(), {
      headers: { 'content-type': 'text/event-stream' },
    });
  },
});

let worker: Awaited<ReturnType<typeof workerd>>;

beforeAll(async () => {
  const { outputs } = await Bun.build({
    entrypoints: [
      `${import.meta.dir}/../../packages/serve/test/load.worker.ts`,
    ],
    target: 'browser',
    conditions: ['workerd', '@mottyjs/source'],
    external: ['node:*', 'cloudflare:*'],
  });
  worker = await workerd({
    modules: { 'worker.js': (await outputs[0]?.text()) ?? '' },
    flags: ['enable_request_signal'],
    verbose: true,
    bindings: {
      UPSTREAM: new URL('/v1', provider.url).href,
      RECORDS: new URL('/records', provider.url).href,
    },
    objects: { STORAGE: 'MottyStorage' },
  });
}, 30_000);

afterAll(async () => {
  await worker.stop();
  await provider.stop(true);
});

const crossed = /different request|never generate a response|Uncaught|error:/;

async function asked(number: number) {
  const reply = await fetch(`${worker.address}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'coder',
      stream: number % 2 === 0,
      messages: [{ role: 'user', content: `question ${number}` }],
    }),
  });
  return {
    status: reply.status,
    id: reply.headers.get('x-request-id'),
    text: await reply.text(),
  };
}

// More connections opened at once over TCP than a machine that filters its
// network lets through are refused, so this many stay open at a time, and each
// that ends is followed by the next.
const open = 32;

test('two thousand overlapping requests each get their own answer and their own record, and workerd says nothing of one touching another', async () => {
  const total = 2000;
  const replies: Awaited<ReturnType<typeof asked>>[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: open }, async () => {
      while (next < total) {
        const number = next;
        next += 1;
        replies[number] = await asked(number);
      }
    }),
  );

  for (const [number, { status, text }] of replies.entries()) {
    expect(status).toBe(200);
    expect(text).toContain(`echo question ${number}"`);
    expect(text.match(/echo question/g)).toHaveLength(1);
  }
  for (let waits = 0; records.length < total && waits < 2000; waits += 1) {
    await Bun.sleep(5);
  }
  expect(records.map(({ id }) => id).sort()).toEqual(
    replies.map(({ id }) => id ?? '').sort(),
  );
  expect(records.every(({ outcome }) => outcome === 'completed')).toBe(true);
}, 30_000);

// Last, as it writes an error of its own, told from any other by its mark and
// workerd's own words, which a plain throw lacks: the whole log is judged here,
// the first case's included.
test('the log shows a reply one request opened and another read, and nothing else of the kind', async () => {
  expect(await (await fetch(`${worker.address}/shared`)).text()).toBe('kept');
  const read = await fetch(`${worker.address}/shared`);
  expect(read.status).toBe(500);

  await worker.stop();
  const said = await worker.written;
  const lines = said.split('\n').filter((line) => crossed.test(line));
  expect(lines).not.toEqual([]);
  expect(
    lines.filter(
      (line) =>
        !/control: Error: Cannot perform I\/O on behalf of a different request/.test(
          line,
        ),
    ),
  ).toEqual([]);
}, 30_000);
