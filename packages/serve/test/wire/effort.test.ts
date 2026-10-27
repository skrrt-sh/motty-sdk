import { expect, test } from 'bun:test';
import { isEffort } from '../../src/wire/effort.ts';

test.each(['none', 'max'])('%s is an effort', (effort) => {
  expect(isEffort(effort)).toBe(true);
});

test.each([undefined, 'extreme'])('%p is no effort', (value) => {
  expect(isEffort(value)).toBe(false);
});
