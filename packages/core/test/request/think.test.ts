import { expect, test } from 'bun:test';
import { RateLimited } from '../../src/data/errors.ts';
import type { Chunk } from '../../src/data/event.ts';
import { answer } from '../../src/request/answer.ts';
import { current, enter } from '../../src/request/context.ts';
import { model } from '../../src/request/model.ts';
import { progress, think } from '../../src/request/think.ts';
import { stubHost } from '../stub-host.ts';

test('a line of text is one piece of progress', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();

    expect(think('Answering with the deep tier')).toBeUndefined();

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'Answering with the deep tier' },
    });
    close();
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });
});

test('several lines go out in the order they were offered', async () => {
  const seen = await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    think('Reading the request');
    think('Choosing a tier');
    think('Answering with the deep tier');

    const seen = [];
    for await (const delta of pieces) {
      seen.push(delta);
      if (seen.length === 3) close();
    }
    return seen;
  });

  expect(seen).toEqual([
    { piece: 0, text: 'Reading the request' },
    { piece: 1, text: 'Choosing a tier' },
    { piece: 2, text: 'Answering with the deep tier' },
  ]);
});

test('a forwarded answer is one piece made of its text chunks only', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'reasoning', text: 'The lock order differs' },
      { type: 'text', text: '1. Find ' },
      { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
      { type: 'citation', url: 'https://example.com' },
      { type: 'text', text: 'the lock order' },
      {
        type: 'finish',
        reason: 'stop',
        usage: { input: 3, output: 4, cached: 0, reasoning: 2 },
      },
    ],
  });

  const seen = await enter(host, async () => {
    const { pieces, close } = progress(current());
    think('Answering with the deep tier');
    think(await model('acme/small').complete({ messages: [] }));
    think('Following the plan');

    const seen = [];
    for await (const delta of pieces) {
      seen.push(delta);
      if (seen.length === 4) close();
    }
    return seen;
  });

  expect(seen).toEqual([
    { piece: 0, text: 'Answering with the deep tier' },
    { piece: 1, text: '1. Find ' },
    { piece: 1, text: 'the lock order' },
    { piece: 2, text: 'Following the plan' },
  ]);
});

test("a live answer's text arrives before the answer finishes", async () => {
  await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* arriving(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'one ' };
      await gate.promise;
      yield { type: 'text', text: 'two' };
    }
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();

    think(answer(arriving()));

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'one ' },
    });
    gate.resolve();
    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'two' },
    });
    close();
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });
});

test('a piece offered after a live answer waits for it to finish', async () => {
  await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* arriving(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'one ' };
      await gate.promise;
      yield { type: 'text', text: 'two' };
    }
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();

    think(answer(arriving()));
    think(answer('A second answer, whole'));
    think('Following the plan');

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'one ' },
    });
    let settled = false;
    const next = reader.next().finally(() => {
      settled = true;
    });
    await Bun.sleep(1);
    expect(settled).toBe(false);
    gate.resolve();

    expect(await next).toEqual({
      done: false,
      value: { piece: 0, text: 'two' },
    });
    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 1, text: 'A second answer, whole' },
    });
    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 2, text: 'Following the plan' },
    });
    close();
  });
});

test('pieces offered before progress is first read are kept', async () => {
  const seen = await enter(stubHost(), async () => {
    think('Reading the request');
    think(answer('1. Find the lock order'));
    await Bun.sleep(1);

    const { pieces, close } = progress(current());
    think('Following the plan');
    const seen = [];
    for await (const delta of pieces) {
      seen.push(delta);
      if (seen.length === 3) close();
    }
    return seen;
  });

  expect(seen).toEqual([
    { piece: 0, text: 'Reading the request' },
    { piece: 1, text: '1. Find the lock order' },
    { piece: 2, text: 'Following the plan' },
  ]);
});

test('closing cuts a live answer where it is, sends the line behind it and leaves the answer readable', async () => {
  await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* arriving(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'one ' };
      await gate.promise;
      yield { type: 'text', text: 'two' };
    }
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const plan = answer(arriving());

    think(plan);
    think('Following the plan');

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'one ' },
    });
    const next = reader.next();
    close();
    expect(await next).toEqual({
      done: false,
      value: { piece: 1, text: 'Following the plan' },
    });
    expect(await reader.next()).toEqual({ done: true, value: undefined });

    gate.resolve();
    expect(await plan.text()).toBe('one two');
    expect(await Array.fromAsync(plan.chunks())).toEqual([
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
    ]);
    expect(await plan.finish()).toBe('stop');
  });
});

test('think after the stage closed does nothing', async () => {
  const seen = await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    think('Before the answer');
    close();

    expect(() => think('After the answer started')).not.toThrow();
    expect(() => think(answer('A late plan'))).not.toThrow();
    return Array.fromAsync(pieces);
  });

  expect(seen).toEqual([{ piece: 0, text: 'Before the answer' }]);
});

test('think outside a request does nothing', async () => {
  expect(() => think('Loading')).not.toThrow();
  expect(() => think(answer('A plan nobody asked for'))).not.toThrow();

  const seen = await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    close();
    return Array.fromAsync(pieces);
  });

  expect(seen).toEqual([]);
});

test('a forwarded answer that fails ends its piece quietly', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'text', text: 'Partial' },
      {
        type: 'error',
        error: { code: 'rate_limited', status: 429, message: 'Slow down' },
      },
    ],
  });

  await enter(host, async () => {
    const { pieces, close } = progress(current());
    const plan = await model('acme/small').complete({ messages: [] });
    think(plan);
    think('Answering without a plan');

    const seen = [];
    for await (const delta of pieces) {
      seen.push(delta);
      if (seen.length === 2) close();
    }

    expect(seen).toEqual([
      { piece: 0, text: 'Partial' },
      { piece: 1, text: 'Answering without a plan' },
    ]);
    await expect(plan.text()).rejects.toBeInstanceOf(RateLimited);
  });
});

test('an answer dropped by closing fails later without a sound', async () => {
  await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* broken(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'Partial' };
      await gate.promise;
      throw new RangeError('The socket closed');
    }
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const plan = answer(broken());

    think(plan);
    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'Partial' },
    });
    const next = reader.next();
    close();
    expect(await next).toEqual({ done: true, value: undefined });
    gate.resolve();
    await Bun.sleep(1);

    await expect(plan.text()).rejects.toBeInstanceOf(Error);
  });
});

test('concurrent requests keep their progress apart', async () => {
  const [first, second] = await Promise.all(
    ['first', 'second'].map((name) =>
      enter(stubHost(), async () => {
        const { pieces, close } = progress(current());
        think(`Reading the ${name} request`);
        await Bun.sleep(1);
        think(answer(`A plan for the ${name} request`));

        const seen = [];
        for await (const delta of pieces) {
          seen.push(delta);
          if (seen.length === 2) close();
        }
        return seen;
      }),
    ),
  );

  expect(first).toEqual([
    { piece: 0, text: 'Reading the first request' },
    { piece: 1, text: 'A plan for the first request' },
  ]);
  expect(second).toEqual([
    { piece: 0, text: 'Reading the second request' },
    { piece: 1, text: 'A plan for the second request' },
  ]);
});

test('a read waiting on an empty stage gets the next line offered', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const waiting = pieces[Symbol.asyncIterator]().next();

    think('Reading the request');

    expect(await waiting).toEqual({
      done: false,
      value: { piece: 0, text: 'Reading the request' },
    });
    close();
  });
});

test('a read waiting on an empty stage gets an offered answer live', async () => {
  await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* arriving(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'one ' };
      await gate.promise;
      yield { type: 'text', text: 'two' };
    }
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const waiting = reader.next();

    think(answer(arriving()));

    expect(await waiting).toEqual({
      done: false,
      value: { piece: 0, text: 'one ' },
    });
    gate.resolve();
    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'two' },
    });
    close();
  });
});

test('reads asked at once are answered in the order they were asked', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const asked = [reader.next(), reader.next(), reader.next(), reader.next()];

    think('Reading the request');
    think(answer('1. Find the lock order'));
    think('Following the plan');
    await Bun.sleep(1);
    close();

    expect(await Promise.all(asked)).toEqual([
      { done: false, value: { piece: 0, text: 'Reading the request' } },
      { done: false, value: { piece: 1, text: '1. Find the lock order' } },
      { done: false, value: { piece: 2, text: 'Following the plan' } },
      { done: true, value: undefined },
    ]);
  });
});

test('a forwarded answer with no text takes its piece number and sends nothing', async () => {
  const host = stubHost({
    'acme/small': [
      { type: 'reasoning', text: 'The lock order differs' },
      { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls', usage: { input: 3, output: 4 } },
    ],
  });

  const seen = await enter(host, async () => {
    const { pieces, close } = progress(current());
    think('Looking it up');
    think(await model('acme/small').complete({ messages: [] }));
    think('Following the plan');

    const seen = [];
    for await (const delta of pieces) {
      seen.push(delta);
      if (seen.length === 2) close();
    }
    return seen;
  });

  expect(seen).toEqual([
    { piece: 0, text: 'Looking it up' },
    { piece: 2, text: 'Following the plan' },
  ]);
});

test('a forwarded answer that fails before any text ends its piece quietly', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const plan = answer({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new RangeError('The socket closed');
        },
      }),
    });

    think(plan);
    think('Answering without a plan');

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 1, text: 'Answering without a plan' },
    });
    close();
    await expect(plan.text()).rejects.toBeInstanceOf(Error);
  });
});

test('closing ends a read waiting on an empty stage', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const waiting = pieces[Symbol.asyncIterator]().next();

    close();

    expect(await waiting).toEqual({ done: true, value: undefined });
  });
});

test('closing between two reads of a live answer ends the next read', async () => {
  await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* arriving(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'one ' };
      await gate.promise;
      yield { type: 'text', text: 'two' };
    }
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const plan = answer(arriving());

    think(plan);
    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'one ' },
    });
    close();

    expect(await reader.next()).toEqual({ done: true, value: undefined });
    gate.resolve();
    expect(await plan.text()).toBe('one two');
  });
});

test('closing sends every line nobody read yet and each forwarded answer that has arrived, whole and in order', async () => {
  const seen = await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const plan = answer('1. Find the lock order');
    await plan.text();
    think('Reading the request');
    think(plan);
    think('Choosing a tier');
    close();
    return Array.fromAsync(pieces);
  });

  expect(seen).toEqual([
    { piece: 0, text: 'Reading the request' },
    { piece: 1, text: '1. Find the lock order' },
    { piece: 2, text: 'Choosing a tier' },
  ]);
});

test.each([
  ['at once', 0],
  ['a moment later', 5],
])(
  'two forwarded answers that had both arrived go out whole when the stage is closed %s',
  async (_name, pause) => {
    const seen = await enter(stubHost(), async () => {
      async function* first(): AsyncIterable<Chunk> {
        yield { type: 'text', text: 'A1 ' };
        yield { type: 'text', text: 'A2 ' };
      }
      async function* second(): AsyncIterable<Chunk> {
        yield { type: 'text', text: 'B1 ' };
        yield { type: 'text', text: 'B2 ' };
      }
      const { pieces, close } = progress(current());
      const reading = Array.fromAsync(pieces);
      const plans = [answer(first()), answer(second())];
      await Promise.all(plans.map((plan) => plan.text()));
      for (const plan of plans) think(plan);
      // The result must not change with how long the reader had.
      if (pause > 0) await Bun.sleep(pause);
      close();
      return reading;
    });

    expect(seen.map((delta) => delta.text).join('')).toBe('A1 A2 B1 B2 ');
    expect(seen.map((delta) => delta.piece)).toEqual([0, 0, 1, 1]);
  },
);

test('what had arrived of a forwarded answer when the stage closed goes out though nobody had read yet, and the rest is dropped', async () => {
  const seen = await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* arriving(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'one ' };
      yield { type: 'text', text: 'two ' };
      await gate.promise;
      yield { type: 'text', text: 'three' };
    }
    const { pieces, close } = progress(current());
    const plan = answer(arriving());
    think(plan);
    think('Following the plan');
    await Bun.sleep(1);
    close();
    gate.resolve();
    await plan.text();
    return Array.fromAsync(pieces);
  });

  expect(seen).toEqual([
    { piece: 0, text: 'one ' },
    { piece: 0, text: 'two ' },
    { piece: 1, text: 'Following the plan' },
  ]);
});

test('closing twice is the same as closing once', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    think('Reading the request');

    close();
    expect(() => close()).not.toThrow();

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'Reading the request' },
    });
    expect(await reader.next()).toEqual({ done: true, value: undefined });
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });
});

test('a reader that starts after the stage closed ends at once', async () => {
  const seen = await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    close();
    return Array.fromAsync(pieces);
  });

  expect(seen).toEqual([]);
});

test('a reader that stops before reading closes the stage', async () => {
  await enter(stubHost(), async () => {
    const { pieces } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    think('Reading the request');

    expect(await reader.return?.()).toEqual({ done: true, value: undefined });

    think('Choosing a tier');
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });
});

test('a reader that stops between pieces closes the stage', async () => {
  const seen = await enter(stubHost(), async () => {
    const { pieces } = progress(current());
    think('Reading the request');
    think('Choosing a tier');

    const seen = [];
    for await (const delta of pieces) {
      seen.push(delta);
      break;
    }
    think('Answering with the deep tier');
    return [...seen, ...(await Array.fromAsync(pieces))];
  });

  expect(seen).toEqual([{ piece: 0, text: 'Reading the request' }]);
});

test('a reader that stops mid-answer ends its waiting read and leaves the answer readable', async () => {
  await enter(stubHost(), async () => {
    const gate = Promise.withResolvers<void>();
    async function* arriving(): AsyncIterable<Chunk> {
      yield { type: 'text', text: 'one ' };
      await gate.promise;
      yield { type: 'text', text: 'two' };
    }
    const { pieces } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const plan = answer(arriving());

    think(plan);
    await reader.next();
    const waiting = reader.next();
    await reader.return?.();

    expect(await waiting).toEqual({ done: true, value: undefined });
    gate.resolve();
    expect(await plan.text()).toBe('one two');
  });
});

test('a long forwarded answer sends every text chunk in order', async () => {
  const seen = await enter(stubHost(), async () => {
    async function* long(): AsyncIterable<Chunk> {
      for (let sent = 0; sent < 2_000; sent += 1) {
        yield { type: 'text', text: `${sent}` };
      }
    }
    const { pieces, close } = progress(current());
    think(answer(long()));
    think('Following the plan');

    const seen = [];
    for await (const delta of pieces) {
      seen.push(delta);
      if (delta.piece === 1) close();
    }
    return seen;
  });

  expect(seen).toHaveLength(2_001);
  expect(seen[1_999]).toEqual({ piece: 0, text: '1999' });
  expect(seen[2_000]).toEqual({ piece: 1, text: 'Following the plan' });
});

test('an empty line offers nothing and takes no piece number', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();

    expect(think('')).toBeUndefined();
    think('Reading the request');
    think('');
    think('Choosing a tier');

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'Reading the request' },
    });
    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 1, text: 'Choosing a tier' },
    });
    close();
  });
}, 1_000);

test.each([
  ['null', JSON.parse('null')],
  ['undefined', JSON.parse('{}').progress],
  ['a number', JSON.parse('5')],
  ['true', JSON.parse('true')],
  ['an empty object', JSON.parse('{}')],
  ['an object whose chunks is no function', JSON.parse('{"chunks":"text"}')],
  [
    'a look-alike of an answer, with a chunks() of its own',
    {
      ...answer('The plan'),
      chunks: () => {
        throw new RangeError('Not readable');
      },
    },
  ],
])(
  'think given %s offers nothing, throws nothing and takes no piece number',
  async (_name, offered) => {
    await enter(stubHost(), async () => {
      const { pieces, close } = progress(current());
      const reader = pieces[Symbol.asyncIterator]();

      think('Reading the request');
      expect(think(offered)).toBeUndefined();
      think('Choosing a tier');

      expect([await reader.next(), await reader.next()]).toEqual([
        { done: false, value: { piece: 0, text: 'Reading the request' } },
        { done: false, value: { piece: 1, text: 'Choosing a tier' } },
      ]);
      close();
    });
  },
  1_000,
);

test('nothing offered after the stage closed is kept', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const plan = answer('Too late');
    await plan.text();
    close();

    think('Too late');
    think(plan);

    const reader = pieces[Symbol.asyncIterator]();
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });
}, 1_000);

test('reads asked ahead are answered in order across a live answer, a line and a whole answer', async () => {
  await enter(stubHost(), async () => {
    async function* slow(): AsyncIterable<Chunk> {
      for (const text of ['1', '2', '3']) {
        await Bun.sleep(1);
        yield { type: 'text', text };
      }
    }
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const asked = [reader.next()];

    think(answer(slow()));
    asked.push(reader.next(), reader.next());
    think('Following the plan');
    think(answer('A second answer, whole'));
    asked.push(reader.next(), reader.next());

    expect(await Promise.all(asked)).toEqual([
      { done: false, value: { piece: 0, text: '1' } },
      { done: false, value: { piece: 0, text: '2' } },
      { done: false, value: { piece: 0, text: '3' } },
      { done: false, value: { piece: 1, text: 'Following the plan' } },
      { done: false, value: { piece: 2, text: 'A second answer, whole' } },
    ]);
    close();
  });
}, 1_000);

test('forwarding an answer reads it through no reader of its own, so the author sees every chunk still', async () => {
  await enter(stubHost(), async () => {
    const { pieces, close } = progress(current());
    const reader = pieces[Symbol.asyncIterator]();
    const plan = answer('The plan');

    think(plan);

    expect(await reader.next()).toEqual({
      done: false,
      value: { piece: 0, text: 'The plan' },
    });
    expect(await Array.fromAsync(plan.chunks())).toEqual([
      { type: 'text', text: 'The plan' },
    ]);
    close();
  });
}, 1_000);
