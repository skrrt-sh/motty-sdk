import type { Codec } from '../codec.ts';
import { error } from '../wire/openai-error.ts';
import { failure } from '../wire/openai-failure.ts';
import { decode } from './decode.ts';
import { type Dialect, plain } from './dialect.ts';
import { encode } from './encode.ts';
import { events } from './events.ts';

/**
 * Makes the Chat Completions codec of one provider. A caller is always read and
 * answered the same way, and the dialect says only what differs going to and
 * coming from that upstream.
 */
export function chatCompletionsIn(dialect: Dialect): Codec {
  return {
    paths: ['/v1/chat/completions'],
    credentials: ['authorization', 'api-key'],
    requestId: 'x-request-id',
    decode,
    error,
    encode: (model, prompt, defaults, takes) =>
      encode(model, prompt, dialect, defaults, takes),
    events: (messages, clean) => events(messages, dialect, clean),
    failure: (status, headers, body, clean) =>
      failure(
        dialect.name,
        status,
        headers,
        body,
        dialect.failures,
        dialect.cuts,
        clean,
        dialect.envelope,
      ),
  };
}

/** The Chat Completions codec with no provider's additions. */
export const chatCompletions = chatCompletionsIn(plain);
