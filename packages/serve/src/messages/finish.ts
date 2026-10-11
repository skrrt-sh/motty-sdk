import type { Finish, FinishReason, Json, Usage } from '@mottyjs/core/host';
import { type Dict, dict, given, number } from '../wire/json.ts';

export function reasonOf(stop: Json | undefined): FinishReason {
  switch (stop) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'pause_turn':
      return 'pause';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}

// An upstream of this family said more than the neutral reason holds, so
// its own word is written back while it still means what the finish says.
export function stopOf({ reason, rawReason }: Finish): string {
  if (reason !== 'other' && reasonOf(rawReason) === reason) {
    return rawReason ?? 'end_turn';
  }
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'pause':
      return 'pause_turn';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

// The counts and the ending both arrive in several events; a later null
// says nothing new, so only a value replaces what is held.
export function merged(held: Dict, more: Dict): Dict {
  const all = { ...held };
  for (const [name, value] of Object.entries(more)) {
    if (value !== null) all[name] = value;
  }
  return all;
}

// This wire counts cached and cache-writing tokens beside the input, the
// neutral usage inside it.
export function countsOf(wire: Dict): Usage {
  const {
    input_tokens: fresh,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: written,
    output_tokens_details: details,
    cost,
  } = wire;
  const cached = number(read);
  const cacheWrite = number(written);
  const { thinking_tokens: thought } = dict(details);
  const reasoning = number(thought);
  const usage: Usage = {};
  if (typeof fresh === 'number') {
    usage.input = fresh + (cached ?? 0) + (cacheWrite ?? 0);
  }
  if (typeof output === 'number') usage.output = output;
  if (cached !== undefined) usage.cached = cached;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  if (reasoning !== undefined) usage.reasoning = reasoning;
  // No field of this API: a router adds it, and a caller is sent it as named.
  if (typeof cost === 'number') usage.cost = cost;
  return usage;
}

export function countsTo(usage: Usage | undefined): Dict {
  const { input = 0, output = 0, cached, cacheWrite, reasoning } = usage ?? {};
  const { cost } = usage ?? {};
  return given({
    input_tokens: Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)),
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cached,
    output_tokens: output,
    output_tokens_details:
      reasoning === undefined ? undefined : { thinking_tokens: reasoning },
    cost,
  });
}
