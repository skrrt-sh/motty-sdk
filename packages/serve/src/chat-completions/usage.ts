import type { Usage } from '@mottyjs/core/host';
import { type Dict, dict, given, number } from '../wire/json.ts';

// A count the upstream did not report stays absent, never a zero.
function optional(name: keyof Usage, count: number | undefined): Usage {
  return count === undefined ? {} : { [name]: count };
}

// The cost is no field of this API: a router adds it, and a caller is sent
// it under the same name.
export function usageRead(raw: Dict, flat?: boolean): Usage {
  const {
    cost,
    prompt_tokens: input,
    completion_tokens: output,
    prompt_tokens_details: prompt,
    completion_tokens_details: completion,
    cached_tokens: outer,
  } = raw;
  const { cached_tokens: inner, cache_write_tokens: written } = dict(prompt);
  // The details outrank a count a model sends beside them.
  const cached = inner ?? (flat === true ? outer : undefined);
  const { reasoning_tokens: reasoning } = dict(completion);
  return {
    ...optional('input', number(input)),
    ...optional('output', number(output)),
    ...optional('cached', number(cached)),
    ...optional('cacheWrite', number(written)),
    ...optional('reasoning', number(reasoning)),
    ...optional('cost', number(cost)),
  };
}

// The three totals are required on this wire, so a count nobody reported is
// written as zero; a breakdown is written only when it was reported.
export function usageWritten(usage: Usage): Dict {
  const { input = 0, output = 0, cached, cacheWrite, reasoning, cost } = usage;
  const prompt = given({
    cached_tokens: cached,
    cache_write_tokens: cacheWrite,
  });
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...given({ cost }),
    ...(Object.keys(prompt).length === 0
      ? {}
      : { prompt_tokens_details: prompt }),
    ...(reasoning === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: reasoning } }),
  };
}

// The field itself is optional on this wire, so usage of which no upstream
// reported any count is left out instead of written as zeros.
export function usageField(usage: Usage | undefined): { usage?: Dict } {
  return usage === undefined || Object.keys(usage).length === 0
    ? {}
    : { usage: usageWritten(usage) };
}
