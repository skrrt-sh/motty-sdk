import { expect, test } from 'bun:test';
import { isEffort, nearest } from '../../src/wire/effort.ts';

test.each(['none', 'max'])('%s is an effort', (effort) => {
  expect(isEffort(effort)).toBe(true);
});

test.each([undefined, 'extreme'])('%p is no effort', (value) => {
  expect(isEffort(value)).toBe(false);
});

test('a level is kept where it is known or nothing limits it', () => {
  expect(nearest(undefined, 'max')).toBe('max');
  expect(nearest(['low', 'high'], 'high')).toBe('high');
  expect(nearest(['none', 'low'], 'none')).toBe('none');
});

test('a level with no word goes as the nearest there is, on either side', () => {
  expect(nearest(['low', 'high'], 'minimal')).toBe('low');
  expect(nearest(['low', 'medium', 'high'], 'max')).toBe('high');
  expect(nearest(['minimal', 'xhigh'], 'high')).toBe('xhigh');
});

test('of two equally near the higher is taken, in whatever order they are listed', () => {
  expect(nearest(['low', 'high'], 'medium')).toBe('high');
  expect(nearest(['high', 'low'], 'medium')).toBe('high');
});

test('an order not to reason with no word goes as the lowest level', () => {
  expect(nearest(['high', 'low', 'medium'], 'none')).toBe('low');
});

test('not reasoning is no level for a request to fall to', () => {
  expect(nearest(['none', 'high'], 'minimal')).toBe('high');
  expect(nearest(['none'], 'low')).toBeUndefined();
  expect(nearest([], 'low')).toBeUndefined();
});
