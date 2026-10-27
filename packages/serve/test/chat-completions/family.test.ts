import { expect, test } from 'bun:test';
import { encode } from '../../src/chat-completions/encode.ts';
import { elsewhere } from '../../src/chat-completions/family.ts';
import { dict } from '../../src/wire/json.ts';

test('no field this API writes itself is one it refuses as another API`s', () => {
  const { body } = encode(
    'gpt-x',
    {
      messages: [{ role: 'user', text: 'Hi' }],
      tools: [{ type: 'function', name: 'weather', input: {} }],
      output: { schema: {} },
      options: {
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        seed: 7,
        presencePenalty: 0.5,
        frequencyPenalty: 0.5,
        maxTokens: 256,
        stop: ['END'],
        user: 'ann',
        parallelToolCalls: false,
        toolChoice: 'auto',
        reasoning: { effort: 'low', budgetTokens: 1024 },
      },
    },
    { name: 'a router', topK: true, asks: 'reasoning' },
  );

  expect(Object.keys(dict(body)).filter((name) => elsewhere.has(name))).toEqual(
    [],
  );
  expect(Object.keys(dict(body))).toContain('reasoning');
});
