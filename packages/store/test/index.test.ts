import { expect, test } from 'bun:test';
import { answer, type ChatRequest, type Motty, motty } from '@mottyjs/core';
import {
  type EventStream,
  type Host,
  type Json,
  mark,
  type RequestRecord,
} from '@mottyjs/core/host';
import * as entry from '../src/index.ts';
import { store } from '../src/index.ts';

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

async function ran(served: Motty, rest: Partial<Host> = {}) {
  const record = Promise.withResolvers<RequestRecord>();
  const events = await Array.fromAsync(
    served[mark].run(ask(), {
      models: unserved,
      signal: new AbortController().signal,
      record: record.resolve,
      ...rest,
    }),
  );
  return { events, record: await record.promise };
}

// Keeps nothing: it reads what a test put there and lists what it was sent.
function recording(held: { [key: string]: Json } = {}) {
  const commands: unknown[][] = [];
  const storage: NonNullable<Host['storage']> = {
    get: async (...given) => {
      commands.push(['get', ...given]);
      return Object.hasOwn(held, given[0]) ? held[given[0]] : undefined;
    },
    set: async (...given) => {
      commands.push(['set', ...given]);
    },
    delete: async (...given) => {
      commands.push(['delete', ...given]);
    },
  };
  return { storage, commands };
}

test('increment is one command to the storage of the host, and gives back the total it answered', async () => {
  const { storage, commands } = recording();
  const totals: number[] = [];

  await ran(
    motty({ name: 'coder' }).handle(async () => {
      totals.push(await store.increment('spent:c1', 2.5, { ttl: 86_400 }));
      return answer('Hi');
    }),
    {
      storage: {
        ...storage,
        increment: async (...given) => {
          commands.push(['increment', ...given]);
          return 7.5;
        },
      },
    },
  );

  expect(commands).toEqual([['increment', 'spent:c1', 2.5, { ttl: 86_400 }]]);
  expect(totals).toEqual([7.5]);
});

test('a storage that is an instance of a class is asked to increment as its own method', async () => {
  class Counters {
    total = 5;
    async get() {
      return this.total;
    }
    async set() {}
    async delete() {}
    async increment(_key: string, by: number) {
      this.total += by;
      return this.total;
    }
  }
  const totals: number[] = [];

  await ran(
    motty({ name: 'coder' }).handle(async () => {
      totals.push(await store.increment('spent:c1', 2));
      return answer('Hi');
    }),
    { storage: new Counters() },
  );

  expect(totals).toEqual([7]);
});

test('an increment given no amount adds one, with no time to live', async () => {
  const { storage, commands } = recording();

  await ran(
    motty({ name: 'coder' }).handle(async () => {
      await store.increment('turns:c1');
      return answer('Hi');
    }),
    {
      storage: {
        ...storage,
        increment: async (...given) => {
          commands.push(['increment', ...given]);
          return 1;
        },
      },
    },
  );

  expect(commands).toEqual([['increment', 'turns:c1', 1, undefined]]);
});

test('a host whose storage cannot increment fails the call as unsupported, and makes it of no other command', async () => {
  const { storage, commands } = recording({ 'turns:c1': 4 });

  const { events, record } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      await store.increment('turns:c1');
      return answer('Hi');
    }),
    { storage },
  );

  expect(events).toEqual([
    expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ code: 'unsupported', status: 400 }),
    }),
  ]);
  expect(record.error?.message).toBe(
    'The store was asked to increment, and the storage of the host cannot',
  );
  expect(commands).toEqual([]);
});

test('an increment the storage refused rejects with what it threw, so a motty may go on', async () => {
  const { storage } = recording();

  const { events } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      const [added] = await Promise.allSettled([store.increment('tier:c1')]);
      return answer(
        added.status === 'rejected' ? String(added.reason.message) : 'added',
      );
    }),
    {
      storage: {
        ...storage,
        increment: async (key) => {
          throw new Error(`The value stored under ${key} is not a number`);
        },
      },
    },
  );

  expect(events[0]).toEqual({
    type: 'text',
    text: 'The value stored under tier:c1 is not a number',
  });
});

test('get, set and delete are each one command to the storage of the host, with the key and the value as given', async () => {
  const { storage, commands } = recording({ 'tier:c1': 'deep' });
  const read: unknown[] = [];

  await ran(
    motty({ name: 'coder' }).handle(async () => {
      read.push(await store.get('tier:c1'), await store.get('tier:c2'));
      await store.set('tier:c2', 'quick', { ttl: 86_400 });
      await store.delete('tier:c1');
      return answer('Hi');
    }),
    { storage },
  );

  expect(commands).toEqual([
    ['get', 'tier:c1'],
    ['get', 'tier:c2'],
    ['set', 'tier:c2', 'quick', { ttl: 86_400 }],
    ['delete', 'tier:c1'],
  ]);
  expect(read).toEqual(['deep', undefined]);
});

test('a value set without a time to live is sent with no options', async () => {
  const { storage, commands } = recording();

  await ran(
    motty({ name: 'coder' }).handle(async () => {
      await store.set('seen', { turns: [1, 2] });
      return answer('Hi');
    }),
    { storage },
  );

  expect(commands).toEqual([['set', 'seen', { turns: [1, 2] }]]);
});

test('nothing is cached: reading a key twice asks the storage twice', async () => {
  const { storage, commands } = recording();

  await ran(
    motty({ name: 'coder' }).handle(async () => {
      await store.get('tier:c1');
      await store.get('tier:c1');
      return answer('Hi');
    }),
    { storage },
  );

  expect(commands).toEqual([
    ['get', 'tier:c1'],
    ['get', 'tier:c1'],
  ]);
});

test('the store is read in a derive and written in after-response work', async () => {
  const { storage, commands } = recording({ 'tier:c1': 'deep' });

  const { events } = await ran(
    motty({ name: 'coder' })
      .derive(async () => ({ previous: await store.get<'deep'>('tier:c1') }))
      .handle(({ previous }) => answer(previous ?? 'none'))
      .afterResponse(() => store.set('tier:c1', 'deep', { ttl: 60 })),
    { storage },
  );

  expect(events[0]).toEqual({ type: 'text', text: 'deep' });
  expect(commands).toEqual([
    ['get', 'tier:c1'],
    ['set', 'tier:c1', 'deep', { ttl: 60 }],
  ]);
});

test('a host that supplied no storage fails the request that uses the store, and the record says why', async () => {
  const { events, record } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      await store.get('tier:c1');
      return answer('Hi');
    }),
  );

  expect(events).toEqual([
    expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ code: 'internal', status: 500 }),
    }),
  ]);
  expect(record.error?.message).toBe(
    'The store was used, and the host supplied no storage',
  );
});

test('each command without storage rejects, so a motty may go on without it', async () => {
  const { events } = await ran(
    motty({ name: 'coder' }).handle(async () => {
      const failed = await Promise.allSettled([
        store.get('tier:c1'),
        store.set('tier:c1', 'deep'),
        store.delete('tier:c1'),
        store.increment('tier:c1'),
      ]);
      return answer(failed.map((command) => command.status).join(' '));
    }),
  );

  expect(events[0]).toEqual({
    type: 'text',
    text: 'rejected rejected rejected rejected',
  });
});

test('the store used outside a request rejects', async () => {
  await expect(store.get('tier:c1')).rejects.toThrow(
    'Called outside a request',
  );
});

test('the store cannot be given other commands', () => {
  expect(Object.keys(store)).toEqual(['get', 'set', 'delete', 'increment']);
  expect(Object.isFrozen(store)).toBe(true);
});

test('a value is typed by what the author says it is, and only JSON is stored', () => {
  motty({ name: 'coder' }).handle(async () => {
    const tier: 'quick' | 'deep' | undefined = await store.get<
      'quick' | 'deep'
    >('tier:c1');
    // @ts-expect-error
    const sure: 'quick' | 'deep' = await store.get<'quick' | 'deep'>('tier:c1');
    // @ts-expect-error
    await store.get<Date>('tier:c1');
    // @ts-expect-error
    await store.set('tier:c1', undefined);
    // @ts-expect-error
    await store.set('tier:c1', new Date());
    // @ts-expect-error
    await store.set('tier:c1', 'deep', { ttl: '1h' });
    // @ts-expect-error
    await store.set('tier:c1', 'deep', { expires: 60 });
    const spent: number = await store.increment('spent:c1', 0.5, { ttl: 60 });
    // @ts-expect-error
    await store.increment('spent:c1', '1');
    // @ts-expect-error
    await store.increment('spent:c1', 1, { expires: 60 });
    void spent;
    return answer(tier ?? sure);
  });
});

test('the entry exports exactly the held values, and no type', async () => {
  const text = await Bun.file(
    new URL('../src/index.ts', import.meta.url),
  ).text();

  expect(Object.keys(entry).sort()).toEqual(['store']);
  expect(text.match(/export (type|interface) /g)).toBeNull();
});
