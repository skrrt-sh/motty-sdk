import { expect, test } from 'bun:test';
import { error, errorBody, wireCode } from '../../src/wire/openai-error.ts';

test('facts are answered with their status and their message', () => {
  expect(
    error({
      code: 'invalidRequest',
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
  ['rateLimited', 'rate_limit_error', 'rate_limit_exceeded'],
  ['contextTooLong', 'invalid_request_error', 'context_length_exceeded'],
])('%s is written as the type %s and the code %s', (kind, type, code) => {
  expect(errorBody({ code: kind, message: 'm' })).toMatchObject({
    error: { type, code },
  });
});

test.each([
  ['internal', 'internal'],
  ['rateLimited', 'rate_limit_exceeded'],
  ['quotaExceeded', 'insufficient_quota'],
  ['overloaded', 'server_is_overloaded'],
  ['contextTooLong', 'context_length_exceeded'],
  ['blocked', 'content_policy_violation'],
  ['unsupported', 'unsupported'],
  ['forbidden', 'forbidden'],
  ['invalidRequest', 'invalid_request'],
  ['upstreamFailed', 'upstream_failed'],
  ['upstreamRefused', 'upstream_refused'],
  ['unknownModel', 'model_not_found'],
  ['timedOut', 'timed_out'],
  ['aborted', 'aborted'],
  ['unauthenticated', 'invalid_api_key'],
  ['invalidOutput', 'invalid_output'],
  ['limitReached', 'limit_reached'],
  ['routeLoop', 'route_loop'],
  ['unknownRoute', 'unknown_route'],
])('the code %s goes out on the wire as %s', (code, written) => {
  expect(wireCode(code)).toBe(written);
});

test.each(['spent', 'my_code', 'myCode', 'constructor', 'rate_limited'])(
  'the code %s, which is an author`s own, goes as it was written',
  (code) => {
    expect(wireCode(code)).toBe(code);
  },
);

test('the type of what a model call can end in never follows the status', () => {
  const typed = (code: string, status: number) =>
    errorBody({ code, status, message: 'm' });

  expect(typed('contextTooLong', 403)).toMatchObject({
    error: { type: 'invalid_request_error' },
  });
  expect(typed('unsupported', 404)).toMatchObject({
    error: { type: 'invalid_request_error' },
  });
  expect(typed('rateLimited', 503)).toMatchObject({
    error: { type: 'rate_limit_error' },
  });
  expect(typed('upstreamFailed', 400)).toMatchObject({
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
  expect(kind('unknownRoute', 404)).toMatchObject({
    error: { type: 'not_found_error', code: 'unknown_route' },
  });
  expect(kind('aborted', 499)).toMatchObject({
    error: { type: 'invalid_request_error', code: 'aborted' },
  });
  expect(kind('limitReached', 400)).toMatchObject({
    error: { type: 'invalid_request_error', code: 'limit_reached' },
  });
  expect(kind('empty_prompt', 422)).toMatchObject({
    error: { type: 'invalid_request_error', code: 'empty_prompt' },
  });
});
