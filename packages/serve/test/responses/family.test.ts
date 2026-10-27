import { expect, test } from 'bun:test';
import { elsewhere as chatRefuses } from '../../src/chat-completions/family.ts';
import { encode } from '../../src/responses/encode.ts';
import { elsewhere } from '../../src/responses/family.ts';
import { dict } from '../../src/wire/json.ts';

test('no field this API writes itself is one it refuses as another API`s, and none is refused by both', () => {
  const { body } = encode('gpt-5', {
    messages: [
      { role: 'system', text: 'Be brief.' },
      { role: 'user', text: 'Hi' },
    ],
    tools: [{ type: 'function', name: 'weather', input: {} }],
    output: { schema: {} },
    options: {
      temperature: 0.2,
      topP: 0.9,
      presencePenalty: 0.5,
      frequencyPenalty: 0.5,
      maxTokens: 256,
      user: 'ann',
      parallelToolCalls: false,
      toolChoice: 'auto',
      reasoning: { effort: 'low' },
    },
  });

  expect(Object.keys(dict(body)).filter((name) => elsewhere.has(name))).toEqual(
    [],
  );
  expect([...elsewhere].filter((name) => chatRefuses.has(name))).toEqual([]);
});
