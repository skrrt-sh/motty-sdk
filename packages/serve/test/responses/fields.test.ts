import { expect, test } from 'bun:test';
import { field, without } from '../../src/responses/fields.ts';

test('a field of what is not an object reads as absent', () => {
  expect(field([1], 'a')).toBeUndefined();
  expect(field({ a: null }, 'a')).toBeNull();
});

test('known fields are left out and the rest kept', () => {
  expect(without({ type: 'x', id: 'i', more: 1 }, ['type', 'id'])).toEqual({
    more: 1,
  });
});
