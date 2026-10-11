import { expect, test } from 'bun:test';
import type { EventStream } from '../../src/contract.ts';
import { Aborted, RateLimited, TimedOut } from '../../src/data/errors.ts';
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

test('a reader started before the first chunk follows the whole answer', async () => {
  const gate = Promise.withResolvers<void>();
  const reply = buffered(
    heldAt(
      stream([
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
        { type: 'finish', reason: 'stop', usage: { input: 1, output: 2 } },
      ]),
      'text',
      gate.promise,
    ),
  );
  const first = reply.chunks()[Symbol.asyncIterator]().next();

  expect(await pending(first)).toBe(true);
  const early = Array.fromAsync(reply.chunks());
  gate.resolve();

  expect(await first).toEqual({
    done: false,
    value: { type: 'text', text: 'one ' },
  });
  expect(await early).toEqual([
    { type: 'text', text: 'one ' },
    { type: 'text', text: 'two' },
  ]);
});

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

test('a slow reader of a fast source misses nothing', async () => {
  const reply = buffered(
    stream([
      { type: 'text', text: 'one ' },
      { type: 'reasoning', text: 'two ' },
      { type: 'text', text: 'three' },
      { type: 'finish', reason: 'stop', usage: { input: 1, output: 3 } },
    ]),
  );
  const fast = Array.fromAsync(reply.chunks());

  const seen: Chunk[] = [];
  for await (const chunk of reply.chunks()) {
    await Bun.sleep(1);
    seen.push(chunk);
  }

  expect(await reply.finish()).toBe('stop');
  expect(seen).toEqual([
    { type: 'text', text: 'one ' },
    { type: 'reasoning', text: 'two ' },
    { type: 'text', text: 'three' },
  ]);
  expect(await fast).toEqual(seen);
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

test('one chunks() iterable read a second time yields nothing', async () => {
  const reply = answer('Hello');
  const once = reply.chunks();

  expect(await Array.fromAsync(once)).toEqual([
    { type: 'text', text: 'Hello' },
  ]);
  expect(await Array.fromAsync(once)).toEqual([]);
  expect(await Array.fromAsync(reply.chunks())).toEqual([
    { type: 'text', text: 'Hello' },
  ]);
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

test('the error the host gave as the reason of its stop is the one a waiting reader of chunks ends with', async () => {
  const canned = answer(
    (async function* (): AsyncIterable<Chunk> {
      await new Promise(() => {});
    })(),
  );
  const stop = new AbortController();
  const reason = new TimedOut('The host gave the request two minutes');

  const thrown = await enter(
    stubHost({}, { signal: stop.signal }),
    async () => {
      const waiting = Array.fromAsync(canned.chunks()).catch(
        (caught: unknown) => caught,
      );
      stop.abort(reason);
      return waiting;
    },
  );

  expect(thrown).toBe(reason);
}, 1_000);

test('reads asked for at once are answered in order, each with its own chunk', async () => {
  const gate = Promise.withResolvers<void>();
  const reply = answer(
    (async function* (): AsyncIterable<Chunk> {
      await gate.promise;
      yield { type: 'text', text: 'One' };
      yield { type: 'text', text: 'Two' };
    })(),
  );

  const reader = reply.chunks()[Symbol.asyncIterator]();
  const reads = [reader.next(), reader.next(), reader.next()];
  gate.resolve();

  expect(await Promise.all(reads)).toEqual([
    { done: false, value: { type: 'text', text: 'One' } },
    { done: false, value: { type: 'text', text: 'Two' } },
    { done: true, value: undefined },
  ]);
});
