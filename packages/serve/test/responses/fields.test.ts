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

test('a field named as the prototype is kept as a field like any other', () => {
  const rest = without(
    JSON.parse('{"type":"x","__proto__":{"x":1},"more":1}'),
    ['type'],
  );

  expect(JSON.stringify(rest)).toBe('{"__proto__":{"x":1},"more":1}');
  expect(Object.getPrototypeOf(rest)).toBe(Object.prototype);
});
