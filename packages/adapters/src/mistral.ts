import type { Json, ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { parsed } from './json.ts';
import { mistralTakes } from './takes.ts';

// Mistral tells a refused key and a rate limit by type, and a model it does
// not know by code. Its 503 is an overload under whatever type it comes.
const failures: FailureReader = (status, _headers, { type, code }) => {
  if (code === 'unknown_model') return { code: 'unknown_model' };
  if (status === 503) return { code: 'overloaded' };
  switch (type) {
    case 'authentication_error':
      return { code: 'upstream_refused' };
    case 'rate_limit_error':
      return { code: 'rate_limited' };
    default:
      return undefined;
  }
};

// Reasoning comes as a chunk of the content and goes back as one, an effort
// has six levels and no budget, the output limit has the older name, and an
// answer the model's own length ended has Mistral's word, and one an error
// ended is a failed call.
const codec = chatCompletionsIn({
  name: 'mistral',
  chunked: true,
  efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  limit: 'max_tokens',
  endings: { model_length: 'length' },
  broken: ['error'],
  failures,
});

// The request is closed to a field Mistral does not list: usage comes
// unasked, the seed has a name of its own, and an end user has no field.
function closed(encoded: ReturnType<typeof codec.encode>) {
  const { body, leftOut } = encoded;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return encoded;
  }
  const { stream_options: _, seed, user, ...listed } = body;
  return {
    ...encoded,
    body: { ...listed, ...(seed === undefined ? {} : { random_seed: seed }) },
    leftOut:
      user === undefined
        ? leftOut
        : [
            ...leftOut,
            { setting: 'user', detail: 'Mistral has no field for an end user' },
          ],
  };
}

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

export function mistral(
  options: {
    key: string | undefined;
    address?: string;
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
      encode: (...said) => closed(codec.encode(...said)),
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
