import type { Codec } from '../codec.ts';
import { error } from '../wire/openai-error.ts';
import { failure } from '../wire/openai-failure.ts';
import type { Cut, FailureReader } from '../wire/upstream-failure.ts';
import { decode } from './decode.ts';
import { encode } from './encode.ts';
import { events } from './events.ts';
import { family } from './family.ts';

/**
 * Makes the Responses codec of one upstream. `breakpoints` writes a cache
 * breakpoint on input content, which most of OpenAI's own models refuse, and
 * `byProvider` names the provider's own failures first.
 */
export function responsesIn(
  upstream: { breakpoints?: true | 'cache_control'; cuts?: readonly Cut[] },
  byProvider?: FailureReader,
): Codec {
  return {
    paths: ['/v1/responses'],
    credentials: ['authorization', 'api-key'],
    requestId: 'x-request-id',
    decode,
    error,
    encode: (model, prompt, defaults, takes) =>
      encode(model, prompt, defaults, upstream.breakpoints, takes),
    events: (messages, clean) =>
      events(messages, byProvider, upstream.cuts, clean),
    failure: (status, headers, body, clean) =>
      failure(family, status, headers, body, byProvider, upstream.cuts, clean),
  };
}

/** The Responses codec as OpenAI's own API speaks it. */
export const responses = responsesIn({});
