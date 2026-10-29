import { expect, test } from 'bun:test';
import { error, errorBody } from '../../src/wire/openai-error.ts';

test('facts are answered with their status and their message', () => {
  expect(
    error({
      code: 'invalid_request',
      status: 400,
      message: 'The body needs a model',
    }),
  ).toEqual({
    status: 400,
    body: {
      error: {
        message: 'The body needs a model',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_request',
      },
    },
  });
});

test.each([
  ['rate_limited', 'rate_limit_error', 'rate_limit_exceeded'],
  ['context_too_long', 'invalid_request_error', 'context_length_exceeded'],
])('%s is written as the type %s and the code %s', (kind, type, code) => {
  expect(errorBody({ code: kind, message: 'm' })).toMatchObject({
    error: { type, code },
  });
});

test('the type of what a model call can end in never follows the status', () => {
  const typed = (code: string, status: number) =>
    errorBody({ code, status, message: 'm' });

  expect(typed('context_too_long', 403)).toMatchObject({
    error: { type: 'invalid_request_error' },
  });
  expect(typed('unsupported', 404)).toMatchObject({
    error: { type: 'invalid_request_error' },
  });
  expect(typed('rate_limited', 503)).toMatchObject({
    error: { type: 'rate_limit_error' },
  });
  expect(typed('upstream_failed', 400)).toMatchObject({
    error: { type: 'server_error' },
  });
});

test('a kind no model call ends in is typed by its status, as it was', () => {
  const kind = (code: string, status: number) =>
    error({ code, status, message: 'm' }).body;

  expect(kind('unauthenticated', 401)).toMatchObject({
    error: { type: 'authentication_error', code: 'invalid_api_key' },
  });
  expect(kind('forbidden', 403)).toMatchObject({
    error: { type: 'permission_error', code: 'forbidden' },
  });
  expect(kind('unknown_route', 404)).toMatchObject({
    error: { type: 'not_found_error', code: 'unknown_route' },
  });
  expect(kind('aborted', 499)).toMatchObject({
    error: { type: 'invalid_request_error', code: 'aborted' },
  });
  expect(kind('limit_reached', 400)).toMatchObject({
    error: { type: 'invalid_request_error', code: 'limit_reached' },
  });
  expect(kind('empty_prompt', 422)).toMatchObject({
    error: { type: 'invalid_request_error', code: 'empty_prompt' },
  });
});
