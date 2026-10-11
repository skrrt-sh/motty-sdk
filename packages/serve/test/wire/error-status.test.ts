import { expect, test } from 'bun:test';
import { errorStatus } from '../../src/wire/error-status.ts';

test('an error status answers as it is', () => {
  expect(errorStatus({ code: 'aborted', status: 499, message: 'x' })).toBe(499);
  expect(errorStatus({ code: 'overloaded', status: 529, message: 'x' })).toBe(
    529,
  );
});

test('facts with no status answer with the status of their kind', () => {
  expect(errorStatus({ code: 'rate_limited', message: 'x' })).toBe(429);
  expect(errorStatus({ code: 'quota_exceeded', message: 'x' })).toBe(429);
  expect(errorStatus({ code: 'overloaded', message: 'x' })).toBe(503);
  expect(errorStatus({ code: 'unknown_model', message: 'x' })).toBe(404);
  expect(errorStatus({ code: 'upstream_refused', message: 'x' })).toBe(502);
  expect(errorStatus({ code: 'timed_out', message: 'x' })).toBe(504);
  expect(errorStatus({ code: 'empty_prompt', message: 'x' })).toBe(500);
});

test('facts with a status that is no error answer 500', () => {
  expect(errorStatus({ code: 'internal', message: 'x' })).toBe(500);
  expect(errorStatus({ code: 'odd', status: 200, message: 'x' })).toBe(500);
  expect(errorStatus({ code: 'odd', status: 600, message: 'x' })).toBe(500);
  expect(errorStatus({ code: 'odd', status: Number.NaN, message: 'x' })).toBe(
    500,
  );
});
