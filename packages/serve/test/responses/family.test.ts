import { expect, test } from 'bun:test';
import { Unsupported } from '@mottyjs/core';
import { elsewhere as chatRefuses } from '../../src/chat-completions/family.ts';
import { encode } from '../../src/responses/encode.ts';
import { carried, elsewhere, held } from '../../src/responses/family.ts';
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

test("another wire's hint is dropped and its own is kept under", () => {
  expect(
    carried(
      {
        hints: {
          anthropic: { a: 1 },
          'openai.responses': { detail: 'low', b: 1 },
        },
        provider: { 'openai.responses': { b: 2 } },
      },
      'a part',
    ),
  ).toEqual({ detail: 'low', b: 2 });
  expect(() => carried({ provider: { gemini: { a: 1 } } }, 'a part')).toThrow(
    Unsupported,
  );
});

test('an item is read back only from under this API’s own key', () => {
  expect(
    held({ 'openai.responses': { type: 'reasoning', id: 'rs_1' } }),
  ).toEqual({ type: 'reasoning', id: 'rs_1' });
  expect(held({ openai: { type: 'reasoning' } })).toBeUndefined();
  expect(held({ 'openai.responses': 'rs_1' })).toBeUndefined();
  expect(held(undefined)).toBeUndefined();
});
