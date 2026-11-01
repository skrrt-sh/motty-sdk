import type { Json, ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { minimaxTakes } from './takes.ts';

// The status may come as a number written as text.
function numbered(code: Json | undefined): Json | undefined {
  return typeof code === 'string' && code.trim() !== '' ? Number(code) : code;
}

const failures: FailureReader = (_status, _headers, { status_code: code }) => {
  switch (numbered(code)) {
    case 1001:
    case 2066:
      return { code: 'timed_out' };
    case 1002:
    case 1041:
    case 2045:
    case 2046:
    case 2047:
      return { code: 'rate_limited' };
    case 1004:
    case 2049:
      return { code: 'upstream_refused' };
    case 1008:
    case 2053:
    case 2056:
    case 2067:
      return { code: 'quota_exceeded' };
    case 1013:
      return { code: 'upstream_failed' };
    case 1026:
    case 1027:
      return { code: 'blocked' };
    case 1039:
      return { code: 'context_too_long' };
    case 2013:
      return { code: 'invalid_request' };
    case 2022:
    case 2069:
      return { code: 'unknown_model' };
    case 2064:
      return { code: 'overloaded' };
    default:
      return undefined;
  }
};

/**
 * Connects to MiniMax over Chat Completions. It asks for JSON with no schema
 * and states no effort, since no word for one is taken by every model.
 */
export function minimax(
  options: {
    /** The API key. A missing or blank one throws when the adapter is made. */
    key: string | undefined;
    /**
     * The base address of the API. The default is `https://api.minimax.io/v1`.
     */
    address?: string;
    /**
     * The first word of a model name, as in `minimax/some-model`, taken off
     * before the call. The default is `minimax`.
     */
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.minimax.io/v1',
    prefix = 'minimax',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // Reasoning comes inside the text unless asked apart, and the request
    // has no word that every model takes for an effort or for none. JSON
    // comes by no schema.
    codec: chatCompletionsIn({
      name: 'minimax',
      tagged: true,
      efforts: [],
      output: 'json_object',
      failures,
      // MiniMax numbers a failure in a status of its own that is not zero,
      // with no error object: inside a reply that began well, and in a body
      // sent under a status that tells none.
      envelope: ({ base_resp: base }) => {
        if (typeof base !== 'object' || base === null || Array.isArray(base)) {
          return undefined;
        }
        const { status_code: held, status_msg: message } = base;
        const code = numbered(held);
        if (typeof code !== 'number' || code === 0 || Number.isNaN(code)) {
          return undefined;
        }
        return message === undefined ? base : { ...base, message };
      },
    }),
    prefix,
    address,
    key,
    takes: minimaxTakes,
    ...connection,
  });
}
