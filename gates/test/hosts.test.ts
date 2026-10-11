import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parsed } from '../../packages/serve/src/sse.ts';
import { runtimes } from '../hosts/runtimes.ts';
import { upstream } from '../hosts/upstream.ts';

async function pieces(reply: Response): Promise<string[]> {
  if (reply.body === null) return [];
  const read: string[] = [];
  for await (const { data } of parsed(reply.body)) read.push(data);
  return read;
}

describe.each(Object.entries(runtimes))('on %s', (_name, start) => {
  let provider: ReturnType<typeof upstream>;
  let runtime: Awaited<ReturnType<typeof start>>;

  beforeAll(async () => {
    provider = upstream();
    runtime = await start({
      upstream: provider.address,
      records: provider.records,
    });
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    await provider.stop();
  });

  function ask(
    sent: {
      token?: string;
      stream?: boolean;
      signal?: AbortSignal;
      question?: string;
    } = {},
  ): Promise<Response> {
    return runtime.fetch(
      new Request(`${runtime.address}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sent.token ?? 's3cret'}`,
        },
        body: JSON.stringify({
          model: 'acme/coder',
          stream: sent.stream ?? true,
          messages: [
            {
              role: 'user',
              content: sent.question ?? 'What does git stash do?',
            },
          ],
        }),
        signal: sent.signal ?? null,
      }),
    );
  }

  test("the example's bundle answers a streamed request behind the host side, and the record carries the id of the response", async () => {
    const reply = await ask();

    expect(reply.status).toBe(200);
    const read = (await pieces(reply)).join('\n');
    expect(read).toContain('"content":"git stash "');
    expect(read).toContain('"content":"shelves changes"');
    expect(read).toEndWith('[DONE]');
    expect(await provider.reported()).toMatchObject({
      id: reply.headers.get('x-request-id'),
      outcome: 'completed',
      path: ['chat', 'quick'],
    });
  });

  test('a whole answer is one JSON body', async () => {
    const reply = await ask({ stream: false });

    expect(await reply.json()).toMatchObject({
      choices: [{ message: { content: 'git stash shelves changes' } }],
    });
    expect(await provider.reported()).toMatchObject({ outcome: 'completed' });
  });

  test('a caller the host does not know is refused', async () => {
    const reply = await ask({ token: 'wrong' });

    expect(reply.status).toBe(401);
    expect(await provider.reported()).toMatchObject({
      outcome: 'failed',
      part: 'auth',
      error: { code: 'unauthenticated' },
    });
  });

  test('a caller who leaves stops every upstream call', async () => {
    const left = provider.stall();
    const leaving = new AbortController();
    const reply = await ask({ signal: leaving.signal });
    await reply.body?.getReader().read();
    leaving.abort();

    expect(await provider.reported()).toMatchObject({ outcome: 'aborted' });
    const seen = left();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen).not.toContain(false);
  }, 20_000);

  test('a run of streamed requests, each answered by one model, opens far fewer upstream connections than it makes calls', async () => {
    const before = provider.connections();
    for (let sent = 0; sent < 30; sent += 1) {
      // A question this long is past the tier whose two models race, where
      // the one that loses is stopped and its connection is rightly lost.
      const reply = await ask({
        question: 'What does git stash do? '.repeat(20),
      });
      await pieces(reply);
      expect(await provider.reported()).toMatchObject({
        outcome: 'completed',
        path: ['chat', 'standard'],
      });
    }

    expect(provider.connections() - before).toBeLessThan(4);
  }, 60_000);
});
