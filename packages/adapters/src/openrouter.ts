import type { Json, ModelAdapter } from '@mottyjs/core/host';
import { chatCompletionsIn } from '@mottyjs/serve';
import type { Takes } from '@mottyjs/serve/codec';
import type { FailureReader } from '@mottyjs/serve/upstream-failure';
import { type Connection, chat } from './chat.ts';
import { openrouterCuts } from './cuts.ts';
import { anthropicTakes, openaiTakes } from './takes.ts';

// A router drops what a model does not take and says nothing, so each model
// is held to its own provider's rule, by the prefix of its name. The router
// takes a wider temperature, and turns an effort into a budget for Claude.
const takes: Takes = (model, reasons) => {
  // Open weights, sound and pictures carry OpenAI's name and none of its
  // API's rule: other providers serve them, and they sample.
  if (/^openai\/gpt-(?:oss|audio|5-image)/.test(model)) return undefined;
  if (model.startsWith('openai/')) {
    return openaiTakes(model.slice('openai/'.length), reasons);
  }
  if (!model.startsWith('anthropic/')) return undefined;
  const taken = anthropicTakes(model.slice('anthropic/'.length), reasons);
  if (taken === undefined) return undefined;
  return {
    ...taken,
    temperature:
      typeof taken.temperature === 'object' ? [0, 2] : taken.temperature,
    effort: true,
  };
};

function fields(value: Json | undefined): { [name: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : {};
}

// A router tells its own failures and every provider's under a few
// statuses, and says which one it was beside the error. In a stream the
// status is a number in the error.
const failures: FailureReader = (status, _headers, error) => {
  const { code, message, metadata, error_type: outer } = error;
  const { limit_source: source, reason, reasons, patterns } = fields(metadata);
  const { error_type: kind = outer } = fields(metadata);
  const sent = status ?? (typeof code === 'number' ? code : undefined);
  const said = typeof message === 'string' ? message : '';
  if (sent === 402 && reason === 'in_flight_budget_exhausted') {
    return { code: 'rate_limited', retryable: true };
  }
  if (
    sent === 402 &&
    (source === 'openrouter_credits' || source === 'openrouter_key_limit')
  ) {
    return { code: 'quota_exceeded' };
  }
  if (sent === 403 && (reasons !== undefined || patterns !== undefined)) {
    return { code: 'blocked' };
  }
  switch (kind) {
    case 'content_policy_violation':
    case 'refusal':
      return { code: 'blocked' };
    case 'context_length_exceeded':
    case 'token_limit_exceeded':
    case 'max_tokens_exceeded':
      return { code: 'context_too_long' };
    case 'not_found':
      return { code: 'unknown_model' };
    case 'provider_overloaded':
      return { code: 'overloaded' };
    case 'provider_unavailable':
      return { code: 'upstream_failed' };
    case 'timeout':
      return { code: 'timed_out' };
  }
  // A wrong address names no model, and no retry mends it.
  if (sent === 404 && said === 'Not Found') {
    return { code: 'upstream_failed', retryable: false };
  }
  // The model is known here: what the host allows shut out every provider
  // of it, or what the request asks did.
  if (sent === 404 && said.startsWith('No endpoints found matching your')) {
    return { code: 'upstream_refused' };
  }
  if (sent === 404 && said.startsWith('No endpoints found that can handle')) {
    return { code: 'unsupported' };
  }
  if (sent !== 400) return undefined;
  if (said.includes('maximum context length is')) {
    return { code: 'context_too_long' };
  }
  if (said.includes('is not a valid model ID')) {
    return { code: 'unknown_model' };
  }
  return said.startsWith('Reasoning is mandatory for this endpoint')
    ? { code: 'unsupported' }
    : undefined;
};

export function openrouter(
  options: {
    key: string | undefined;
    address?: string;
    prefix?: string;
  } & Connection,
): ModelAdapter {
  const {
    key,
    address = 'https://openrouter.ai/api/v1',
    prefix = 'openrouter',
    ...connection
  } = options;
  if (key === undefined || key.trim() === '') {
    throw new Error(`The ${prefix} adapter was given no key`);
  }
  return chat({
    // Reasoning is one object in a request, and comes back as text beside
    // the details a model goes on from, which an assistant turn returns.
    // A file may be of any type or an address, sound of any format, a video
    // has a part of its own, and a tool may answer with any of them. A
    // picture a model made comes, and goes back, in a field of its own.
    // The betas of a Claude model are named in a header of the router's.
    codec: chatCompletionsIn({
      name: 'openrouter',
      thought: 'reasoning',
      details: true,
      asks: 'reasoning',
      files: 'any',
      sound: 'any',
      video: true,
      shown: true,
      images: true,
      native: true,
      topK: true,
      breakpoints: 'cache_control',
      carried: ['x-anthropic-beta'],
      failures,
      cuts: openrouterCuts,
    }),
    prefix,
    address,
    key,
    takes,
    ...connection,
  });
}
