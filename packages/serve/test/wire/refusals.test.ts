import { expect, test } from 'bun:test';
import { a } from '../../src/wire/refusals.ts';

test.each([
  ['image', 'an image'],
  ['text', 'a text'],
  ['toolCall', 'a tool_call'],
  ['toolResult', 'a tool_result'],
])('a refusal names a part of the kind %s as %s', (kind, said) => {
  expect(a(kind)).toBe(said);
});
