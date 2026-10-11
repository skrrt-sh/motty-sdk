import { describe, expect, test } from 'bun:test';
import { model, motty } from '@mottyjs/core';
import { run } from '@mottyjs/test';
import { fireworks } from '../src/fireworks.ts';

// Real calls that cost money: the file is not a `.test.ts`, so it runs only
// when named, and without a key nothing in it runs.
const { FIREWORKS_KEY: key } = Bun.env;

describe.skipIf(key === undefined || key === '')('against Fireworks', () => {
  test('reasoning comes as reasoning and none of it in the text, with its usage', async () => {
    const { answer, calls } = await run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('fireworks/accounts/fireworks/models/glm-5p2').complete(prompt),
      ),
      {
        text: 'What is 17 * 23? Think briefly, then answer in one short sentence.',
        options: { maxTokens: 1500, reasoning: { effort: 'high' } },
      },
      { models: [fireworks({ key })] },
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

  test('an order not to reason is taken, and the answer has no reasoning', async () => {
    const { answer, calls } = await run(
      motty({ name: 'relay' }).handle(({ prompt }) =>
        model('fireworks/accounts/fireworks/models/glm-5p2').complete(prompt),
      ),
      {
        text: 'What is 17 * 23? Answer with the number alone.',
        options: { maxTokens: 60, topK: 40, reasoning: { effort: 'none' } },
      },
      { models: [fireworks({ key })] },
    );
    const chunks = await Array.fromAsync(answer.chunks());

    expect(chunks.some((chunk) => chunk.type === 'reasoning')).toBe(false);
    expect(await answer.text()).toContain('391');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('code');
  });
});
