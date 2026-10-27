import { expect, test } from 'bun:test';
import { fallback, model, motty, timeout } from '@mottyjs/core';
import { fake, on, run } from '../src/index.ts';

const small = model('acme/small');
const large = model('acme/large');

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
