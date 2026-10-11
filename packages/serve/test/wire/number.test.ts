import { expect, test } from 'bun:test';
import { InvalidRequest } from '@mottyjs/core';
import { numberOf } from '../../src/wire/number.ts';

test('a number is read, and one not given is none', () => {
  expect(numberOf(0, 'seed')).toBe(0);
  expect(numberOf(0.7, 'temperature')).toBe(0.7);
  expect(numberOf(undefined, 'seed')).toBeUndefined();
  expect(numberOf(null, 'seed')).toBeUndefined();
});

test('what is not a number is refused by its field`s name', () => {
  expect(() => numberOf('7', 'seed')).toThrow(InvalidRequest);
  expect(() => numberOf(true, 'top_p')).toThrow('top_p must be a number');
});
