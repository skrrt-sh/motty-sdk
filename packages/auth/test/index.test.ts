import { expect, test } from 'bun:test';
import { answer, type ChatRequest, type Motty, motty } from '@mottyjs/core';
import { type EventStream, type Host, mark } from '@mottyjs/core/host';
import * as entry from '../src/index.ts';
import { auth } from '../src/index.ts';

function ask(): ChatRequest {
  return {
    id: 'req_1',
    model: 'motty/coder',
    messages: [{ role: 'user', text: 'Why does this deadlock?' }],
    tools: [],
    options: {},
    headers: new Headers(),
  };
}

async function* unserved(): EventStream {
  yield {
    type: 'error',
    error: { code: 'unknown_model', status: 404, message: 'No model' },
  };
}

function told(served: Motty, rest: Partial<Host> = {}) {
  return Array.fromAsync(
    served[mark].run(ask(), {
      models: unserved,
      signal: new AbortController().signal,
      ...rest,
    }),
  );
}

test('a motty with auth fails with Unauthenticated, 401, when the host knows no caller', async () => {
  let reached = false;

  const seen = await told(
    motty({ name: 'coder' })
      .use(auth())
      .handle(() => {
        reached = true;
        return answer('Hi');
      }),
  );

  expect(seen).toEqual([
    expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ code: 'unauthenticated', status: 401 }),
    }),
  ]);
  expect(reached).toBe(false);
});

test('the caller is read-only by type and holds nothing but its id', () => {
  motty({ name: 'coder' })
    .use(auth())
    .handle(({ caller }) => {
      // @ts-expect-error
      caller.id = 'user_2';
      // @ts-expect-error
      caller.token;
      return answer(caller.id);
    });
});

test('every hook after auth reads the caller', async () => {
  const ids: string[] = [];

  const seen = await told(
    motty({ name: 'coder' })
      .use(auth())
      .beforeHandle(({ caller }) => {
        ids.push(caller.id);
      })
      .handle(({ caller }) => answer(`Hi ${caller.id}`)),
    { caller: { id: 'user_1' } },
  );

  expect(seen[0]).toEqual({ type: 'text', text: 'Hi user_1' });
  expect(ids).toEqual(['user_1']);
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/index.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['auth']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
