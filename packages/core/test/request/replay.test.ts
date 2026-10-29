import { expect, test } from 'bun:test';
import type { EventStream } from '../../src/contract.ts';
import { Aborted, RateLimited } from '../../src/data/errors.ts';
import type { Chunk, StreamEvent } from '../../src/data/event.ts';
import { answer, buffered } from '../../src/request/answer.ts';
import { enter } from '../../src/request/context.ts';
import { stubHost } from '../stub-host.ts';

function stream(events: StreamEvent[]): EventStream {
  const host = stubHost({ 'acme/small': events });
  return host.models('acme/small', { messages: [] }, host.signal);
}

async function* heldAt(
  events: EventStream,
  type: StreamEvent['type'],
  gate: Promise<void>,
): EventStream {
  for await (const event of events) {
    if (event.type === type) await gate;
    yield event;
  }
}

function pending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => false,
      () => false,
    ),
    Bun.sleep(1).then(() => true),
  ]);
}

test('concurrent readers of a stream still arriving see everything', async () => {
  const gate = Promise.withResolvers<void>();
  async function* held(events: EventStream): EventStream {
    for await (const event of events) {
      if (event.type === 'text' && event.text === 'two ') await gate.promise;
      yield event;
    }
  }

  const reply = buffered(
    held(
      stream([
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two ' },
        { type: 'text', text: 'three' },
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 3 } },
      ]),
    ),
  );
  const early = Array.fromAsync(reply.chunks());
  const whole = reply.text();
  const live = reply.chunks()[Symbol.asyncIterator]();
  expect(await live.next()).toEqual({
    done: false,
    value: { type: 'text', text: 'one ' },
  });
  const late = Array.fromAsync(reply.chunks());
  gate.resolve();

  expect(await early).toEqual([
    { type: 'text', text: 'one ' },
    { type: 'text', text: 'two ' },
    { type: 'text', text: 'three' },
  ]);
  expect(await late).toEqual(await early);
  expect(await live.next()).toEqual({
    done: false,
    value: { type: 'text', text: 'two ' },
  });
  expect(await whole).toBe('one two three');
  expect(await Array.fromAsync(reply.chunks())).toEqual(await early);
});

test('a reader that stops early leaves the answer whole for the others', async () => {
  const gate = Promise.withResolvers<void>();
  const reply = buffered(
    heldAt(
      stream([
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
      ]),
      'finish',
      gate.promise,
    ),
  );
  const other = Array.fromAsync(reply.chunks());

  const seen: Chunk[] = [];
  for await (const chunk of reply.chunks()) {
    seen.push(chunk);
    break;
  }
  gate.resolve();

  expect(seen).toEqual([{ type: 'text', text: 'one ' }]);
  expect(await other).toEqual([
    { type: 'text', text: 'one ' },
    { type: 'text', text: 'two' },
  ]);
  expect(await reply.text()).toBe('one two');
  expect((await Array.fromAsync(reply.chunks())).length).toBe(2);
});

test('a reader waiting when the failure arrives gets it after the chunks', async () => {
  const gate = Promise.withResolvers<void>();
  const reply = buffered(
    heldAt(
      stream([
        { type: 'text', text: 'Partial' },
        {
          type: 'error',
          error: { code: 'rate_limited', status: 429, message: 'Slow down' },
        },
      ]),
      'error',
      gate.promise,
    ),
  );
  const live = reply.chunks()[Symbol.asyncIterator]();
  const usage = reply.usage().catch((raised: unknown) => raised);

  expect(await live.next()).toEqual({
    done: false,
    value: { type: 'text', text: 'Partial' },
  });
  const next = live.next();
  expect(await pending(next)).toBe(true);
  gate.resolve();

  await expect(next).rejects.toBeInstanceOf(RateLimited);
  expect(await usage).toBeInstanceOf(RateLimited);
});

test('a reader of chunks waits under the signal in force for it: one in a request that is stopped ends with Aborted, and the answer goes on for the others', async () => {
  const more = Promise.withResolvers<void>();
  let closed = 0;
  const canned = answer({
    [Symbol.asyncIterator]: () => {
      const chunks = ['Half', ' done'].values();
      return {
        next: async () => {
          const { value } = chunks.next();
          if (value === ' done') await more.promise;
          return value === undefined
            ? { done: true, value: undefined }
            : { done: false, value: { type: 'text', text: value } as const };
        },
        return: async () => {
          closed += 1;
          return { done: true, value: undefined };
        },
      };
    },
  });
  const stop = new AbortController();

  const stopped = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      const reader = canned.chunks()[Symbol.asyncIterator]();
      const first = await reader.next();
      const waiting = reader.next().catch((thrown: unknown) => thrown);
      stop.abort();
      return [first, await waiting];
    },
  );
  more.resolve();

  expect(stopped).toEqual([
    { done: false, value: { type: 'text', text: 'Half' } },
    expect.any(Aborted),
  ]);
  expect(await Array.fromAsync(canned.chunks())).toEqual([
    { type: 'text', text: 'Half' },
    { type: 'text', text: ' done' },
  ]);
  expect(closed).toBe(0);
}, 1_000);

test('a reader of chunks stopped while it waited on no read ends with Aborted at its next wait', async () => {
  const first = Promise.withResolvers<void>();
  const canned = answer(
    (async function* (): AsyncIterable<Chunk> {
      await first.promise;
      yield { type: 'text', text: 'Half' };
      await new Promise(() => {});
    })(),
  );
  const stop = new AbortController();

  const stopped = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      const reader = canned.chunks()[Symbol.asyncIterator]();
      const read = reader.next();
      await Bun.sleep(1);
      first.resolve();
      await read;
      stop.abort();
      await Bun.sleep(1);
      return reader.next().catch((thrown: unknown) => thrown);
    },
  );

  expect(stopped).toBeInstanceOf(Aborted);
}, 1_000);
