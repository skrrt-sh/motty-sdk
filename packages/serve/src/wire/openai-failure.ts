import type { ErrorFacts, KnownCode } from '@mottyjs/core/host';
import { type Dict, dict, given, parsed, text } from './json.ts';
import { retryAfter } from './retry-after.ts';
import {
  type Clean,
  type Cut,
  cleaned,
  detailed,
  type FailureReader,
  loose,
  raised,
  stated,
  upstreamFailure,
} from './upstream-failure.ts';

function named(upstream: string | undefined): KnownCode | undefined {
  switch (upstream) {
    case undefined:
      return undefined;
    case 'context_length_exceeded':
      return 'context_too_long';
    case 'content_filter':
      return 'blocked';
    case 'model_not_found':
      return 'unknown_model';
    case 'insufficient_quota':
    case 'billing_hard_limit_reached':
      return 'quota_exceeded';
    case 'rate_limit_exceeded':
    case 'slow_down':
      return 'rate_limited';
    case 'server_is_overloaded':
      return 'overloaded';
    // The key, its organisation, its project and where it may be used from
    // are all the host's to set right.
    case 'invalid_api_key':
    case 'account_deactivated':
    case 'mismatched_organization':
    case 'invalid_project':
    case 'unsupported_country_region_territory':
      return 'upstream_refused';
    case 'unsupported_value':
    case 'unsupported_parameter':
    case 'unknown_parameter':
      return 'unsupported';
    case 'server_error':
      return 'upstream_failed';
    case 'invalid_prompt':
      return 'invalid_request';
    default:
      return upstream.endsWith('policy') ||
        upstream.endsWith('policy_violation')
        ? 'blocked'
        : undefined;
  }
}

const refused =
  /^(?:Model incompatible|Unrecognized) request arguments? supplied: [\w.-]{1,99}(?:, [\w.-]{1,99}){0,99}$/;

// Each of the two APIs refuses an option a model does not take with no code
// and a 400: one in these words with the option it was given for, the other
// with no option named, in a sentence that is nothing but the refusal.
function worded(
  { code, param, message }: Dict,
  status: number | undefined,
): KnownCode | undefined {
  if (status !== 400 || (code ?? null) !== null) return undefined;
  const said = text(message) ?? '';
  return (
    text(param) === undefined
      ? refused.test(said)
      : /^Unsupported (?:parameter|value)\b/.test(said)
  )
    ? 'unsupported'
    : undefined;
}

// Both OpenAI APIs tell a failure in one shape, in a body and in a stream;
// each keeps the record under its own key. Words a body holds outside that
// shape are the message where the error has none.
export function failed(
  key: string,
  error: Dict,
  byProvider?: FailureReader,
  cuts?: readonly Cut[],
  clean?: Clean,
  status?: number,
  headers?: Headers,
  beside: Dict = {},
): ErrorFacts {
  const { code, type, message, metadata } = error;
  const said = text(message);
  const detail = cleaned(detailed(said, metadata), clean);
  const outside = said === undefined && detail === undefined ? beside : {};
  const { message: outer } = outside;
  return upstreamFailure(
    {
      // Named from what was said as it came: a cut may break a code.
      code: named(text(code)) ?? worded(error, status) ?? named(text(type)),
      message: cleaned(said ?? text(outer), clean),
      ...given({ detail }),
      record: {
        [key]: {
          ...given({ status }),
          ...stated(error, clean),
          ...stated(outside, clean),
        },
      },
      error,
      ...(headers === undefined ? {} : { headers }),
    },
    status,
    headers === undefined ? undefined : retryAfter(headers),
    byProvider,
    cuts,
  );
}

// A provider may tell a failure with no error object: it says what error
// such a body holds, and a body it reads none in is read as any other.
export function failure(
  key: string,
  status: number,
  headers: Headers,
  body: string,
  byProvider?: FailureReader,
  cuts?: readonly Cut[],
  clean?: Clean,
  envelope?: (body: Dict) => Dict | undefined,
): ErrorFacts {
  const told = dict(parsed(body));
  // One of the two APIs puts what a router adds beside the error, not in it.
  const { error, metadata } = told;
  const held = (error ?? null) === null ? envelope?.(told) : undefined;
  return failed(
    key,
    held ?? { ...given({ metadata }), ...raised(error) },
    byProvider,
    cuts,
    clean,
    status,
    headers,
    held === undefined ? loose(told) : {},
  );
}
