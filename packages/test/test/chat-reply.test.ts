import { expect, test } from 'bun:test';
import { model, Overloaded } from '@mottyjs/core';
import { fake, on } from '../src/index.ts';

const small = model('acme/small');

test('text is one text chunk and a finish', async () => {
  const models = fake(on(small, 'quick reply'));

  const events = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.any([]),
    ),
  );

  expect(events).toEqual([
    { type: 'text', text: 'quick reply' },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('chunks are sent as they are, then a finish', async () => {
  const models = fake(
    on(small, [
      { type: 'reasoning', text: 'The lock order differs' },
      { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
      { type: 'text', text: 'deep reply' },
    ]),
  );

  const events = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.any([]),
    ),
  );

  expect(events).toEqual([
    { type: 'reasoning', text: 'The lock order differs' },
    { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
    { type: 'text', text: 'deep reply' },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('chunks that end with a finish state the finish reason and the usage', async () => {
  const models = fake(
    on(small, [
      { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
      { type: 'finish', reason: 'tool_calls', usage: { input: 7, output: 3 } },
    ]),
  );

  const events = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.any([]),
    ),
  );

  expect(events).toEqual([
    { type: 'tool_call', id: 'call_1', name: 'search', arguments: '{}' },
    { type: 'finish', reason: 'tool_calls', usage: { input: 7, output: 3 } },
  ]);
});

test('a JSON value is sent as its text', async () => {
  const models = fake(on(small, { files: ['parser.ts'] }));

  const events = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.any([]),
    ),
  );

  expect(events).toEqual([
    { type: 'text', text: '{"files":["parser.ts"]}' },
    { type: 'finish', reason: 'stop' },
  ]);
});

test('an SDK error is sent as its facts', async () => {
  const models = fake(on(small, new Overloaded('busy', { retryAfter: 200 })));

  const events = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.any([]),
    ),
  );

  expect(events).toEqual([
    {
      type: 'error',
      error: {
        code: 'overloaded',
        status: 503,
        message: 'busy',
        retryable: true,
        retryAfter: 200,
      },
    },
  ]);
});

test('a function is asked with the prompt and replies in any other way', async () => {
  const models = fake(
    on(small, (prompt) => `${prompt.messages.length} messages`),
    on(small, (prompt) => ({ last: prompt.messages.at(-1)?.text ?? '' })),
  );

  const counted = await Array.fromAsync(
    models.call(
      'acme/small',
      {
        messages: [
          { role: 'system', text: 'Be brief' },
          { role: 'user', text: 'hi' },
        ],
      },
      AbortSignal.any([]),
    ),
  );
  const echoed = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.any([]),
    ),
  );

  expect(counted[0]).toEqual({ type: 'text', text: '2 messages' });
  expect(echoed[0]).toEqual({ type: 'text', text: '{"last":"hi"}' });
});

test("a function is given the call's stop signal", async () => {
  const given: AbortSignal[] = [];
  const stop = new AbortController();
  const models = fake(
    on(small, (_prompt, signal) => {
      given.push(signal);
      return 'quick reply';
    }),
  );

  await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      stop.signal,
    ),
  );

  expect(given).toEqual([stop.signal]);
});

test('an async sequence is sent chunk by chunk as it comes, then a finish', async () => {
  const order: string[] = [];
  const models = fake(
    on(small, async function* () {
      yield { type: 'text', text: 'Half' };
      order.push('the script went on');
      await Bun.sleep(5);
      yield { type: 'text', text: ' an answer' };
    }),
  );

  const events = [];
  for await (const event of models.call(
    'acme/small',
    { messages: [{ role: 'user', text: 'hi' }] },
    AbortSignal.any([]),
  )) {
    order.push(event.type);
    events.push(event);
  }

  expect(events).toEqual([
    { type: 'text', text: 'Half' },
    { type: 'text', text: ' an answer' },
    { type: 'finish', reason: 'stop' },
  ]);
  expect(order).toEqual(['text', 'the script went on', 'text', 'finish']);
});

test('an async sequence that gives a finish ends with it', async () => {
  const models = fake(
    on(small, async function* () {
      yield { type: 'text', text: 'Cut' };
      yield {
        type: 'finish',
        reason: 'length',
        usage: { input: 7, output: 3 },
      };
      yield { type: 'text', text: ' never sent' };
    }),
  );

  const events = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.any([]),
    ),
  );

  expect(events).toEqual([
    { type: 'text', text: 'Cut' },
    { type: 'finish', reason: 'length', usage: { input: 7, output: 3 } },
  ]);
});

test('a function still waiting when its call is stopped ends the stream with no event', async () => {
  const stop = new AbortController();
  const models = fake(on(small, () => new Promise<string>(() => {})));

  const reading = Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      stop.signal,
    ),
  );
  stop.abort();

  expect(await reading).toEqual([]);
});

test('an async sequence stalled when its call is stopped ends after what it had sent', async () => {
  const stop = new AbortController();
  const models = fake(
    on(small, async function* () {
      yield { type: 'text', text: 'Half' };
      await new Promise(() => {});
      yield { type: 'text', text: ' an answer' };
    }),
  );

  const events = [];
  for await (const event of models.call(
    'acme/small',
    { messages: [{ role: 'user', text: 'hi' }] },
    stop.signal,
  )) {
    events.push(event);
    stop.abort();
  }

  expect(events).toEqual([{ type: 'text', text: 'Half' }]);
});

test('an async sequence is closed when its call is stopped', async () => {
  const closed = Promise.withResolvers<string>();
  const stop = new AbortController();
  const models = fake(
    on(small, async function* (_prompt, signal) {
      try {
        yield { type: 'text', text: 'Half' };
        await new Promise((resolve) =>
          signal.addEventListener('abort', resolve),
        );
        yield { type: 'text', text: ' an answer' };
      } finally {
        closed.resolve('closed');
      }
    }),
  );

  const events = models
    .call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      stop.signal,
    )
    [Symbol.asyncIterator]();
  await events.next();
  const rest = events.next();
  stop.abort();

  expect(await rest).toEqual({ done: true, value: undefined });
  expect(await closed.promise).toBe('closed');
});

test('a function is not asked by a call that was stopped before it began', async () => {
  const asked: string[] = [];
  const models = fake(
    on(small, () => {
      asked.push('asked');
      return 'quick reply';
    }),
  );

  const events = await Array.fromAsync(
    models.call(
      'acme/small',
      { messages: [{ role: 'user', text: 'hi' }] },
      AbortSignal.abort(),
    ),
  );

  expect(events).toEqual([]);
  expect(asked).toEqual([]);
});

test('a chat reply of another type is refused by the compiler', () => {
  // @ts-expect-error a bare number is neither text nor a JSON object
  on(small, 5);
  // @ts-expect-error an error that is not an SDK error has no facts to send
  on(small, new Error('busy'));
  // @ts-expect-error a list holds chunks, not text
  on(small, ['quick reply']);
  // @ts-expect-error a chunk is of a known kind
  on(small, [{ type: 'thought', text: 'hm' }]);
  // @ts-expect-error a finish is the last of a list, never in its middle
  on(small, [
    { type: 'finish', reason: 'length' },
    { type: 'text', text: '' },
  ]);
  // @ts-expect-error a function gives a reply, never nothing
  on(small, () => undefined);
  // @ts-expect-error an async function gives a reply too
  on(small, async () => undefined);
  // @ts-expect-error an async sequence holds chunks, not text
  on(small, async function* () {
    yield 'quick reply';
  });
  expect(() =>
    // @ts-expect-error a model is given, not its name
    on('acme/small', 'quick reply'),
  ).toThrow();
});
