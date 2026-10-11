import type { ErrorFacts } from '@mottyjs/core/host';
import type { Codec } from '../codec.ts';
import { errorStatus } from './error-status.ts';
import type { Dict } from './json.ts';

// A client of these APIs acts on their own codes: it compacts a prompt that
// is too long and waits out a rate limit. Any other code goes as it is.
export function wireCode(code: string): string {
  switch (code) {
    case 'rate_limited':
      return 'rate_limit_exceeded';
    case 'quota_exceeded':
      return 'insufficient_quota';
    case 'overloaded':
      return 'server_is_overloaded';
    case 'context_too_long':
      return 'context_length_exceeded';
    case 'blocked':
      return 'content_policy_violation';
    case 'unknown_model':
      return 'model_not_found';
    case 'unauthenticated':
      return 'invalid_api_key';
    default:
      return code;
  }
}

// What a model call can end in has one type, whatever status it has: these
// APIs tell an unknown model as a bad request. Any other is told by status.
function kind(code: string, status: number): string {
  switch (code) {
    case 'rate_limited':
      return 'rate_limit_error';
    case 'quota_exceeded':
      return 'insufficient_quota';
    case 'overloaded':
      return 'service_unavailable_error';
    case 'context_too_long':
    case 'blocked':
    case 'unsupported':
    case 'invalid_request':
    case 'unknown_model':
      return 'invalid_request_error';
    case 'upstream_refused':
    case 'upstream_failed':
    case 'timed_out':
      return 'server_error';
    default:
      if (status === 401) return 'authentication_error';
      if (status === 403) return 'permission_error';
      if (status === 404) return 'not_found_error';
      return status >= 500 ? 'server_error' : 'invalid_request_error';
  }
}

export function errorBody(facts: ErrorFacts): Dict {
  const { code, message } = facts;
  return {
    error: {
      message,
      type: kind(code, errorStatus(facts)),
      param: null,
      code: wireCode(code),
    },
  };
}

export function error(facts: ErrorFacts): ReturnType<Codec['error']> {
  return { status: errorStatus(facts), body: errorBody(facts) };
}
