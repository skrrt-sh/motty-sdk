import { expect, test } from 'bun:test';
import { isEffort } from '../../src/wire/effort.ts';

test.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
  '%s is an effort',
  (effort) => {
    expect(isEffort(effort)).toBe(true);
  },
);

test.each([undefined, null, '', 'extreme', 3])('%p is no effort', (value) => {
  expect(isEffort(value)).toBe(false);
});
