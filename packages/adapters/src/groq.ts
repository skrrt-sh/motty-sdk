import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { groqCuts } from './cuts.ts';

// A tier out of capacity has a status and a type of its own, and a request
// too large is told as 413 under a rate limit's code.
const failures: FailureReader = (status, _headers, { type }) => {
  if (status === 498 || type === 'capacity_exceeded') {
    return { code: 'overloaded' };
  }
  return status === 413 ? { code: 'invalid_request' } : undefined;
};

/** Connects to Groq over Chat Completions. */
export function groq(
  options: {
    /** The API key. A missing or blank one throws when the adapter is made. */
    key: string | undefined;
    /**
     * The base address of the API. The default is
     * `https://api.groq.com/openai/v1`.
     */
    address?: string;
    /**
     * The first word of a model name, as in `groq/some-model`, taken off before
     * the call. The default is `groq`.
     */
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.groq.com/openai/v1',
    prefix = 'groq',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // Reasoning comes between think tags unless a format is asked for, and
    // some models refuse to be asked. The ones that send it in a field of
    // its own are read too.
    codec: chatCompletionsIn({
      name: 'groq',
      tagged: true,
      failures,
      cuts: groqCuts,
    }),
    prefix,
    address,
    key,
    ...connection,
  });
}
