import type { ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { moonshotCuts } from './cuts.ts';
import { moonshotTakes } from './takes.ts';

const long =
  /token length too long|exceeds the model specification|exceeded model token limit/i;

// Kimi tells a failure by its type, and a prompt too long only in words.
const failures: FailureReader = (_status, _headers, { type, message }) => {
  switch (type) {
    case 'exceeded_current_quota_error':
      return { code: 'quota_exceeded' };
    case 'engine_overloaded_error':
      return { code: 'overloaded' };
    case 'rate_limit_reached_error':
      return { code: 'rate_limited' };
    case 'content_filter':
      return { code: 'blocked' };
    case 'resource_not_found_error':
      return { code: 'unknown_model' };
    case 'permission_denied_error':
    case 'invalid_authentication_error':
    case 'incorrect_api_key_error':
      return { code: 'upstream_refused' };
    default:
      return typeof message === 'string' && long.test(message)
        ? { code: 'context_too_long' }
        : undefined;
  }
};

const kimi: Parameters<typeof chatCompletionsIn>[0] = {
  name: 'moonshot',
  thought: 'reasoning_content',
  failures,
  cuts: moonshotCuts,
};

// Kimi's models ask for reasoning in different words, and each refuses the
// other's: the newest always reasons at one of three efforts, K2 has a
// switch and no effort, and a coding or an older model has neither. Only
// the newest keeps its cache an hour when asked, for the whole request.
const leveled = chatCompletionsIn({
  ...kimi,
  efforts: ['low', 'high', 'max'],
  lifetime: 'prompt_cache_options',
});
const switched = chatCompletionsIn({ ...kimi, asks: 'thinking', efforts: [] });
const wordless = chatCompletionsIn({ ...kimi, efforts: [] });

// A model named after this was written is asked as the newest one is.
function spoken(model: string) {
  if (model.startsWith('moonshot-v1')) return wordless;
  if (!model.startsWith('kimi-k2')) return leveled;
  return model.includes('-code') ? wordless : switched;
}

export function moonshot(
  options: {
    key: string | undefined;
    address?: string;
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://api.moonshot.ai/v1',
    prefix = 'moonshot',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // A reply is read the same whichever model wrote it.
    codec: {
      ...leveled,
      encode: (model, ...rest) => spoken(model).encode(model, ...rest),
    },
    prefix,
    address,
    key,
    takes: moonshotTakes,
    ...connection,
  });
}
