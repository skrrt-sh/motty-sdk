import { expect, test } from 'bun:test';
import {
  answer,
  type ChatRequest,
  type Motty,
  motty,
  Unauthenticated,
} from '@mottyjs/core';
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

test('the error a boundary gets is the Unauthenticated of the core', async () => {
  const caught: unknown[] = [];

  await told(
    motty({ name: 'coder' })
      .use(auth())
      .handle(() => answer('Hi'))
      .onError((thrown) => {
        caught.push(thrown);
      }),
  );

  expect(caught).toEqual([expect.any(Unauthenticated)]);
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

test('auth used by a part and by its root is one part', async () => {
  const served = motty({ name: 'coder' })
    .use(auth())
    .use(motty({ name: 'audit' }).use(auth()))
    .handle(({ caller }) => answer(caller.id));

  expect(served[mark].description.plugins).toEqual(['auth', 'audit']);
  expect((await told(served, { caller: { id: 'user_1' } }))[0]).toEqual({
    type: 'text',
    text: 'user_1',
  });
});

test('without auth a motty is open: it answers whoever reaches its host', async () => {
  const seen = await told(
    motty({ name: 'coder' }).handle((context) => {
      // @ts-expect-error
      context.caller;
      return answer('Hi');
    }),
  );

  expect(seen[0]).toEqual({ type: 'text', text: 'Hi' });
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/index.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['auth']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
