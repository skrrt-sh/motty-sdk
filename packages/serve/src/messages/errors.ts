import type { ErrorFacts, KnownCode } from '@mottyjs/core/host';
import type { Codec } from '../codec.ts';
import { errorStatus } from '../wire/error-status.ts';
import { type Dict, dict, given, parsed, text } from '../wire/json.ts';
import { retryAfter } from '../wire/retry-after.ts';
import {
  type Clean,
  type Cut,
  cleaned,
  detailed,
  loose,
  stated,
  upstreamFailure,
  raised as worded,
} from '../wire/upstream-failure.ts';
import { family } from './family.ts';

// What a model call can end in has one name, whatever status it has: a
// spent quota is this API's billing error. Any other is told by status.
function typeTo({ code, status = 500 }: ErrorFacts): string {
  switch (code) {
    case 'unauthenticated':
      return 'authentication_error';
    case 'forbidden':
      return 'permission_error';
    case 'unknown_model':
      return 'not_found_error';
    case 'rate_limited':
      return 'rate_limit_error';
    case 'quota_exceeded':
      return 'billing_error';
    case 'overloaded':
      return 'overloaded_error';
    case 'timed_out':
      return 'timeout_error';
    case 'context_too_long':
    case 'blocked':
      return 'invalid_request_error';
    case 'unsupported':
    case 'invalid_request':
      return status === 413 ? 'request_too_large' : 'invalid_request_error';
    case 'upstream_refused':
    case 'upstream_failed':
      return 'api_error';
    default:
      if (status === 413) return 'request_too_large';
      return status < 500 ? 'invalid_request_error' : 'api_error';
  }
}

// Also what ends a stream that failed after it began.
export function problem(facts: ErrorFacts): Dict {
  const { message } = facts;
  return { type: 'error', error: { type: typeTo(facts), message } };
}

// A spent balance and an overload have statuses of this API's own, which
// its clients read: the kind's usual ones are the OpenAI APIs' numbers.
function statusTo(facts: ErrorFacts): number {
  switch (facts.code) {
    case 'quota_exceeded':
      return 402;
    case 'overloaded':
      return 529;
    default:
      return errorStatus(facts);
  }
}

export function error(
  facts: ErrorFacts,
  id?: string,
): ReturnType<Codec['error']> {
  return {
    status: statusTo(facts),
    body: { ...problem(facts), ...given({ request_id: id }) },
  };
}

// A balance or a limit that is spent is told under three names, two of them
// shared with failures that mean something else.
const spent = /^You have reached your specified|credit balance is too low/i;

function named(
  type: string | undefined,
  message: string,
  limit: string | undefined,
): KnownCode | undefined {
  switch (type) {
    case 'overloaded_error':
      return 'overloaded';
    case 'rate_limit_error':
      return limit === 'enforced_spend_limit_reached'
        ? 'quota_exceeded'
        : 'rate_limited';
    case 'billing_error':
      return 'quota_exceeded';
    // The host's own key was turned down: the caller's is not at fault.
    case 'authentication_error':
    case 'permission_error':
      return 'upstream_refused';
    // An unknown model is named; an address this API does not have is not.
    case 'not_found_error':
      return message.startsWith('model:') ? 'unknown_model' : 'upstream_failed';
    case 'timeout_error':
      return 'timed_out';
    // Too many bytes, turned down before any model counted a token.
    case 'request_too_large':
    case 'invalid_request_error':
      if (spent.test(message)) return 'quota_exceeded';
      return /prompt is too long|context window|too many tokens/i.test(message)
        ? 'context_too_long'
        : 'invalid_request';
    case 'api_error':
      return 'upstream_failed';
    default:
      return undefined;
  }
}

// Runs of hex digits joined by dashes, sixteen characters or more and as
// long as it goes on: an id cut by a count would be left in part.
const id = '(?=[0-9a-f-]{16})[0-9a-f]{1,4096}(?:-[0-9a-f]{1,4096}){0,64}';

// A rate limit names the organisation whose limit it is, beside the model.
// The second reads the label alone, should the words around it change.
export const cuts: readonly Cut[] = [
  { pattern: new RegExp(`\\(org: ${id}, `, 'gi'), replacement: '(' },
  { pattern: new RegExp(`\\borg: ${id}`, 'gi'), replacement: '', bare: true },
];

// The failure is named from what was said as it came: what is cut for the
// host may break the words it is named by.
function failed(
  body: Dict,
  clean?: Clean,
  status?: number,
  headers?: Headers,
): ErrorFacts {
  const { error, request_id: request, metadata: beside } = body;
  const raised = worded(error);
  const { type, message, metadata, details } = raised;
  const { error_code: limit } = dict(details);
  const code = named(text(type), text(message) ?? '', text(limit));
  const said = text(message);
  const detail = cleaned(detailed(said, metadata, beside), clean);
  const outside = said === undefined && detail === undefined ? loose(body) : {};
  const { message: outer } = outside;
  return upstreamFailure(
    {
      code,
      message: cleaned(said ?? text(outer), clean),
      ...given({ detail }),
      record: {
        [family]: {
          ...given({ status }),
          // A router puts what it adds in the error or beside it.
          ...stated(
            { ...given({ request_id: request, metadata: beside }), ...raised },
            clean,
          ),
          ...stated(outside, clean),
        },
      },
      // A wrong address is the host's setup, and wrong on every try.
      ...(type === 'not_found_error' && code === 'upstream_failed'
        ? { retryable: false }
        : {}),
      error: raised,
      ...(headers === undefined ? {} : { headers }),
    },
    status,
    headers === undefined ? undefined : retryAfter(headers),
    undefined,
    cuts,
  );
}

export function failure(
  status: number,
  headers: Headers,
  body: string,
  clean?: Clean,
): ErrorFacts {
  return failed(dict(parsed(body)), clean, status, headers);
}

// A failure told inside a stream has no status: only its own name tells it.
export function streamFailure(event: Dict, clean?: Clean): ErrorFacts {
  return failed(event, clean);
}
