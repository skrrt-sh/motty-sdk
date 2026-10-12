import { expect, test } from 'bun:test';
import { field, isCustom } from '../../src/responses/fields.ts';

test('a field of what is not an object reads as absent', () => {
  expect(field([1], 'a')).toBeUndefined();
  expect(field({ a: null }, 'a')).toBeNull();
});

test('a call is custom by the type of its item, and by nothing else', () => {
  expect(isCustom({ type: 'custom_tool_call' })).toBe(true);
  expect(isCustom({ type: 'function_call', name: 'custom_tool_call' })).toBe(
    false,
  );
  expect(isCustom({})).toBe(false);
});
