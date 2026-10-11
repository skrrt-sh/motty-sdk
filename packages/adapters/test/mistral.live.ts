import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import { run } from '@mottyjs/test';
import { mistral } from '../src/mistral.ts';

// Real calls that cost money: the file is not a `.test.ts`, so it runs only
// when named, and without a key nothing in it runs.
const { MISTRAL_KEY: key } = Bun.env;

describe.skipIf(key === undefined || key === '')('against Mistral', () => {
  test('thinking that comes as chunks of the content is read as reasoning and none of it as text, with its usage', async () => {
    const { answer, calls } = await run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('mistral/mistral-medium-3-5').complete(prompt),
      ),
      {
        text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
        options: { maxTokens: 1500, reasoning: { effort: 'high' } },
      },
      { models: [mistral({ key })] },
    );
    const chunks = await Array.fromAsync(answer.chunks());
    const thought = chunks
      .map((chunk) => (chunk.type === 'reasoning' ? chunk.text : ''))
      .join('');

    expect(thought).toMatch(/\S/);
    expect(thought).not.toMatch(/<\/?think/);
    expect(await answer.text()).toContain('391');
    expect(await answer.text()).not.toMatch(/<\/?think/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBeGreaterThan(0);
    expect(calls[0]?.output).toBeGreaterThan(0);
    expect(calls[0]).not.toHaveProperty('code');
  });

  test('an order not to reason, a seed and an output limit are all taken, and the answer has no reasoning', async () => {
    const { answer, calls } = await run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('mistral/mistral-small-latest').complete(prompt),
      ),
      {
        text: 'What is 17 * 23? Answer with the number alone.',
        options: {
          maxTokens: 60,
          seed: 7,
          user: 'live',
          reasoning: { effort: 'none' },
        },
      },
      { models: [mistral({ key })] },
    );
    const chunks = await Array.fromAsync(answer.chunks());

    expect(chunks.some((chunk) => chunk.type === 'reasoning')).toBe(false);
    expect(await answer.text()).toContain('391');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('code');
  });
});
