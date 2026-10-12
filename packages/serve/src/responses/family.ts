import type { ProviderData } from '@mottyjs/core/host';
import { apis } from '../wire/fieldless.ts';
import { copied, type Dict, isDict } from '../wire/json.ts';
import { providerData } from '../wire/provider-data.ts';

export const family = 'openai.responses';

export const api = apis.responses;

// What only Chat Completions has, by OpenAI's reference. The two penalties
// are not here: a router's Responses API takes them, and they are written.
export const elsewhere: ReadonlySet<string> = new Set([
  'audio',
  'function_call',
  'functions',
  'logit_bias',
  'logprobs',
  'max_completion_tokens',
  'max_tokens',
  'messages',
  'modalities',
  'n',
  'prediction',
  'reasoning_effort',
  'response_format',
  'seed',
  'stop',
  'verbosity',
  'web_search_options',
]);

export const { hinted, own, mine, addressed, marked, noted } = providerData(
  family,
  api,
  'openai',
  elsewhere,
);

export function carried(
  holder: { provider?: ProviderData; hints?: ProviderData },
  what: string,
): Dict {
  return { ...hinted(holder.hints), ...own(holder.provider, what) };
}

// What an item of this API held, when this API is the one that wrote it.
export function held(data: ProviderData | undefined): Dict | undefined {
  const fields = data?.[family];
  if (fields === undefined) return undefined;
  const item = copied(fields);
  return isDict(item) ? item : undefined;
}
