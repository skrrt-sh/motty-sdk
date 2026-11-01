import type { ErrorFacts, KnownCode } from '@mottyjs/core/host';
import type { Codec } from '../codec.ts';
import { errorStatus } from './error-status.ts';
import type { Dict } from './json.ts';

// What each code is called on the wire of these APIs. A client acts on their own
// words: it compacts a prompt that is too long and waits out a rate limit. Where
// they have no word of their own, a caller reads the one it always read.
const written: { readonly [Code in KnownCode]: string } = {
  internal: 'internal',
  rateLimited: 'rate_limit_exceeded',
  quotaExceeded: 'insufficient_quota',
  overloaded: 'server_is_overloaded',
  contextTooLong: 'context_length_exceeded',
  blocked: 'content_policy_violation',
  unsupported: 'unsupported',
  forbidden: 'forbidden',
  invalidRequest: 'invalid_request',
  upstreamFailed: 'upstream_failed',
  upstreamRefused: 'upstream_refused',
  unknownModel: 'model_not_found',
  timedOut: 'timed_out',
  aborted: 'aborted',
  unauthenticated: 'invalid_api_key',
  invalidOutput: 'invalid_output',
  limitReached: 'limit_reached',
  routeLoop: 'route_loop',
  unknownRoute: 'unknown_route',
};

function isKnown(code: string): code is KnownCode {
  return Object.hasOwn(written, code);
}

// An author's own code goes as the author wrote it.
export function wireCode(code: string): string {
  return isKnown(code) ? written[code] : code;
}

// What a model call can end in has one type, whatever status it has: these
// APIs tell an unknown model as a bad request. Any other is told by status.
function kind(code: string, status: number): string {
  switch (code) {
    case 'rateLimited':
      return 'rate_limit_error';
    case 'quotaExceeded':
      return 'insufficient_quota';
    case 'overloaded':
      return 'service_unavailable_error';
    case 'contextTooLong':
    case 'blocked':
    case 'unsupported':
    case 'invalidRequest':
    case 'unknownModel':
      return 'invalid_request_error';
    case 'upstreamRefused':
    case 'upstreamFailed':
    case 'timedOut':
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
