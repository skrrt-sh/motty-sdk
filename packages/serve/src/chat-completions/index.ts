import type { Codec } from '../codec.ts';
import { error } from '../wire/openai-error.ts';
import { failure } from '../wire/openai-failure.ts';
import { decode } from './decode.ts';
import { type Dialect, plain } from './dialect.ts';
import { encode } from './encode.ts';
import { events } from './events.ts';
import { formless } from './formless.ts';

// One codec per dialect: a caller is always read and answered the same
// way, and only what goes to and comes from an upstream differs. A provider
// names its own failures first, in a response that failed and in a stream.
export function chatCompletionsIn(dialect: Dialect): Codec {
  return {
    paths: ['/v1/chat/completions'],
    credentials: ['authorization', 'api-key'],
    decode,
    error,
    encode: (model, prompt, defaults, takes) =>
      encode(model, prompt, dialect, defaults, takes),
    formless,
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

export const chatCompletions = chatCompletionsIn(plain);
