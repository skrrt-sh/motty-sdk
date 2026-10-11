import { expect, test } from 'bun:test';
import { fallback, model, motty, TimedOut, timeout } from '@mottyjs/core';
import { fake, on, run } from '../src/index.ts';

const small = model('acme/small');
const large = model('acme/large');

test('a reply whose first chunk is late ends as TimedOut', async () => {
  const waiting = motty({ name: 'waiting' }).handle(({ prompt }) =>
    timeout(small, 10).complete(prompt),
  );

  const asked = run(
    waiting,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, async () => {
            await Bun.sleep(60);
            return 'late reply';
          }),
        ),
      ],
    },
  );

  await expect(asked).rejects.toEqual(
    new TimedOut('No first chunk pulled within 10 ms'),
  );
});

test('a fallback moves on from a late reply, whose call is recorded as aborted', async () => {
  const falling = motty({ name: 'falling' }).handle(({ prompt }) =>
    fallback(timeout(small, 10), large).complete(prompt),
  );

  const { answer: reply, calls } = await run(
    falling,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, async () => {
            await Bun.sleep(60);
            return 'late reply';
          }),
          on(large, 'fallback reply'),
        ),
      ],
    },
  );

  expect(await reply.text()).toBe('fallback reply');
  expect(calls.map(({ model, code }) => [model, code])).toEqual([
    ['acme/small', 'aborted'],
    ['acme/large', undefined],
  ]);
});

test('a reply that comes within the time limit is the answer', async () => {
  const waiting = motty({ name: 'waiting' }).handle(({ prompt }) =>
    timeout(small, 500).complete(prompt),
  );

  const { answer: reply } = await run(
    waiting,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, async () => {
            await Bun.sleep(5);
            return 'slow reply';
          }),
        ),
      ],
    },
  );

  expect(await reply.text()).toBe('slow reply');
});

test('chunks whose first comes after the first limit end as TimedOut', async () => {
  const waiting = motty({ name: 'waiting' }).handle(({ prompt }) =>
    timeout(small, { first: 10, stall: 500 }).complete(prompt),
  );

  const asked = run(
    waiting,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, async function* () {
            await Bun.sleep(60);
            yield { type: 'text', text: 'late reply' };
          }),
        ),
      ],
    },
  );

  await expect(asked).rejects.toEqual(
    new TimedOut('No first chunk pulled within 10 ms'),
  );
});

test('a stream that stalls between chunks ends with the error in the stream', async () => {
  const seen: string[] = [];
  const streaming = motty({ name: 'streaming' }).handle(({ prompt }) =>
    timeout(small, { first: 500, stall: 10 }).complete(prompt),
  );

  const asked = run(
    streaming,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, async function* () {
            yield { type: 'text', text: 'Half' };
            seen.push('the first chunk was read');
            await Bun.sleep(60);
            yield { type: 'text', text: ' an answer' };
          }),
        ),
      ],
    },
  );

  await expect(asked).rejects.toEqual(
    new TimedOut('The stream stalled: no event in 10 ms'),
  );
  expect(seen).toEqual(['the first chunk was read']);
});

test('chunks that each come within the stall limit are the whole answer', async () => {
  const streaming = motty({ name: 'streaming' }).handle(({ prompt }) =>
    timeout(small, { first: 500, stall: 500 }).complete(prompt),
  );

  const { answer: reply } = await run(
    streaming,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, async function* () {
            yield { type: 'text', text: 'Half' };
            await Bun.sleep(5);
            yield { type: 'text', text: ' an answer' };
          }),
        ),
      ],
    },
  );

  expect(await reply.text()).toBe('Half an answer');
});

test('the stop signal a late reply was given fires at the time limit', async () => {
  const stopped = Promise.withResolvers<boolean>();
  const falling = motty({ name: 'falling' }).handle(({ prompt }) =>
    fallback(timeout(small, 10), large).complete(prompt),
  );

  await run(
    falling,
    { text: 'hi' },
    {
      models: [
        fake(
          on(small, async (_prompt, signal) => {
            await new Promise((resolve) =>
              signal.addEventListener('abort', resolve),
            );
            stopped.resolve(signal.aborted);
            return 'late reply';
          }),
          on(large, 'fallback reply'),
        ),
      ],
    },
  );

  expect(await stopped.promise).toBe(true);
});
