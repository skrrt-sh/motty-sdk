import { expect, test } from 'bun:test';
import { errorStatus } from '../../src/wire/error-status.ts';

test('an error status answers as it is', () => {
  expect(errorStatus({ code: 'aborted', status: 499, message: 'x' })).toBe(499);
  expect(errorStatus({ code: 'overloaded', status: 529, message: 'x' })).toBe(
    529,
  );
});

test('facts with a status that is no error answer 500', () => {
  expect(errorStatus({ code: 'internal', message: 'x' })).toBe(500);
  expect(errorStatus({ code: 'odd', status: 200, message: 'x' })).toBe(500);
  expect(errorStatus({ code: 'odd', status: 600, message: 'x' })).toBe(500);
  expect(errorStatus({ code: 'odd', status: Number.NaN, message: 'x' })).toBe(
    500,
  );
});
