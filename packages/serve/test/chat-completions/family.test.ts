import { expect, test } from 'bun:test';
import { encode } from '../../src/chat-completions/encode.ts';
import {
  addressed,
  elsewhere,
  hinted,
  marked,
  own,
} from '../../src/chat-completions/family.ts';
import { dict } from '../../src/wire/json.ts';

test('this wire reads and writes under its own key alone', () => {
  expect(marked({ logprobs: true })).toEqual({
    provider: { 'openai.chat': { logprobs: true } },
  });
  expect(hinted({ 'openai.chat': { detail: 'low' } })).toEqual({
    detail: 'low',
  });
  expect(hinted({ 'openai.responses': { detail: 'low' } })).toEqual({});
  expect(() => own({ 'openai.responses': {} }, 'an option')).toThrow(
    'Chat Completions cannot carry an option of openai.responses',
  );
});

test('the provider`s key is read too, and held to the fields this API has', () => {
  expect(
    addressed({
      provider: { openai: { store: true }, 'openai.chat': { n: 2 } },
    }).provider,
  ).toEqual({ store: true, n: 2 });
  expect(() =>
    addressed({ provider: { openai: { truncation: 'auto' } } }),
  ).toThrow(
    'Chat Completions cannot carry truncation, which another API of openai has',
  );
});

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
