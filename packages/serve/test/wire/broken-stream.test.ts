import { expect, test } from 'bun:test';
import { cutShort, unreadable } from '../../src/wire/broken-stream.ts';

test('an unreadable frame and an early close may be retried, and are told apart by message', () => {
  expect(unreadable()).toEqual({
    code: 'upstream_failed',
    message: 'The upstream sent an event that cannot be read',
    retryable: true,
    upstream: true,
  });
  expect(cutShort()).toEqual({
    code: 'upstream_failed',
    message: 'The upstream closed the stream before it finished',
    retryable: true,
    upstream: true,
  });
});
