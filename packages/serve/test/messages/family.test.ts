import { expect, test } from 'bun:test';
import { hinted, marked, noted, own } from '../../src/messages/family.ts';

test('this wire reads and writes under its own key alone', () => {
  expect(marked({ a: 1 })).toEqual({ provider: { anthropic: { a: 1 } } });
  expect(noted({ a: 1 })).toEqual({ hints: { anthropic: { a: 1 } } });
  expect(hinted({ anthropic: { service_tier: 'auto' } })).toEqual({
    service_tier: 'auto',
  });
  expect(hinted({ 'openai.chat': { store: true } })).toEqual({});
  expect(() => own({ 'openai.chat': { logprobs: true } }, 'options')).toThrow(
    'Anthropic Messages cannot carry options of openai.chat',
  );
});
