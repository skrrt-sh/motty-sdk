import { expect, test } from 'bun:test';
import { retryAfter, shouldRetry } from '../../src/wire/retry-after.ts';

test('the wait is read in milliseconds from seconds', () => {
  expect(retryAfter(new Headers({ 'retry-after': '20' }))).toBe(20_000);
  expect(retryAfter(new Headers({ 'retry-after': '0.5' }))).toBe(500);
  expect(retryAfter(new Headers({ 'retry-after': '0' }))).toBe(0);
});

test('the header in milliseconds outranks the one in seconds', () => {
  expect(
    retryAfter(new Headers({ 'retry-after-ms': '1500', 'retry-after': '20' })),
  ).toBe(1500);
  expect(retryAfter(new Headers({ 'retry-after-ms': '1500.4' }))).toBe(1500);
  expect(
    retryAfter(new Headers({ 'retry-after-ms': 'soon', 'retry-after': '20' })),
  ).toBe(20_000);
});

test('a wait given as a date is counted from now, and never negative', () => {
  const later = new Date(Date.now() + 60_000).toUTCString();
  const wait = retryAfter(new Headers({ 'retry-after': later }));

  expect(wait).toBeGreaterThan(55_000);
  expect(wait).toBeLessThanOrEqual(60_000);
  expect(
    retryAfter(new Headers({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' })),
  ).toBe(0);
  expect(retryAfter(new Headers({ 'retry-after-ms': '-5' }))).toBe(0);
});

test('no header, an empty one and one that cannot be read give no wait', () => {
  expect(retryAfter(new Headers())).toBeUndefined();
  expect(retryAfter(new Headers({ 'retry-after': '' }))).toBeUndefined();
  expect(retryAfter(new Headers({ 'retry-after': ' ' }))).toBeUndefined();
  expect(retryAfter(new Headers({ 'retry-after': 'soon' }))).toBeUndefined();
});

test('the upstream`s word on another try is read as a yes or a no', () => {
  expect(shouldRetry(new Headers({ 'x-should-retry': 'true' }))).toBe(true);
  expect(shouldRetry(new Headers({ 'x-should-retry': 'false' }))).toBe(false);
  expect(shouldRetry(new Headers({ 'x-should-retry': ' False ' }))).toBe(false);
});

test('a header that is absent or says neither says nothing of another try', () => {
  expect(shouldRetry(new Headers())).toBeUndefined();
  expect(shouldRetry(new Headers({ 'x-should-retry': '' }))).toBeUndefined();
  expect(shouldRetry(new Headers({ 'x-should-retry': '1' }))).toBeUndefined();
});
