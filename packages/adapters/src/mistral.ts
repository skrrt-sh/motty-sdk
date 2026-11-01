import type { Json, ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { mistralFields } from './fields.ts';
import { parsed } from './json.ts';
import { mistralTakes } from './takes.ts';

// Mistral tells a refused key and a rate limit by type, and a model it does
// not know by code. Its 503 is an overload under whatever type it comes.
const failures: FailureReader = (status, _headers, { type, code }) => {
  if (code === 'unknown_model') return { code: 'unknownModel' };
  if (status === 503) return { code: 'overloaded' };
  switch (type) {
    case 'authentication_error':
      return { code: 'upstreamRefused' };
    case 'rate_limit_error':
      return { code: 'rateLimited' };
    default:
      return undefined;
  }
};

// Reasoning comes as a chunk of the content and goes back as one, an effort
// has six levels and no budget, and an answer the model's own length ended has
// Mistral's word, and one an error ended is a failed call.
const codec = chatCompletionsIn({
  name: 'mistral',
  chunked: true,
  efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  fields: mistralFields,
  endings: { model_length: 'length' },
  broken: ['error'],
  failures,
});

// The failure is at the top of the body, with no error object around it.
function raised(body: string): string {
  let told: Json;
  try {
    told = parsed(body);
  } catch {
    return body;
  }
  if (typeof told !== 'object' || told === null || Array.isArray(told)) {
    return body;
  }
  const { object } = told;
  return object === 'error' ? JSON.stringify({ error: told }) : body;
}

/** Connects to Mistral over Chat Completions. */
export function mistral(
  options: {
    /** The API key. A missing or blank one throws when the adapter is made. */
    key: string | undefined;
    /**
     * The base address of the API. The default is `https://api.mistral.ai/v1`.
     */
    address?: string;
    /**
     * The first word of a model name, as in `mistral/some-model`, taken off
     * before the call. The default is `mistral`.
     */
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.mistral.ai/v1',
    prefix = 'mistral',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    codec: {
      ...codec,
      failure: (status, headers, body, clean) =>
        codec.failure(status, headers, raised(body), clean),
    },
    prefix,
    address,
    key,
    takes: mistralTakes,
    ...connection,
  });
}
