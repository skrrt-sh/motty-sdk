import type { Finish, FinishReason, Json, Usage } from '@mottyjs/core/host';
import { type Dict, dict, given, number, without } from '../wire/json.ts';

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
  return {
    ...held,
    ...Object.fromEntries(
      Object.entries(more).filter(([, value]) => value !== null),
    ),
  };
}

// One reading names each count, so none is both counted and kept apart.
// What the upstream said beside them is no count the neutral usage holds.
function counted(wire: Dict): { usage: Usage; rest: Dict } {
  const {
    input_tokens: fresh,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: written,
    output_tokens_details: details,
    cost,
    ...rest
  } = wire;
  const cached = number(read);
  const cacheWrite = number(written);
  const { thinking_tokens: thought, ...more } = dict(details);
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
  return {
    usage,
    rest:
      Object.keys(more).length === 0
        ? rest
        : { ...rest, output_tokens_details: more },
  };
}

// This wire counts cached and cache-writing tokens beside the input, the
// neutral usage inside it.
export function countsOf(wire: Dict): Usage {
  return counted(wire).usage;
}

// What the upstream reported beside the counts read here is no count the
// neutral usage holds, so it is kept apart and written back as it came.
export function uncounted(wire: Dict): Dict {
  return counted(wire).rest;
}

// Of a usage carried from the upstream only what is no count is written:
// the counts are the neutral usage's, which a motty may have changed.
export function countsTo(usage: Usage | undefined, carried: Dict = {}): Dict {
  const { input = 0, output = 0, cached, cacheWrite, reasoning } = usage ?? {};
  const { cost } = usage ?? {};
  const { output_tokens_details: more, ...rest } = uncounted(carried);
  const details = given({ ...dict(more), thinking_tokens: reasoning });
  return {
    ...rest,
    ...given({
      input_tokens: Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)),
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cached,
      output_tokens: output,
      output_tokens_details:
        Object.keys(details).length === 0 ? undefined : details,
      cost,
    }),
  };
}

export function besides(event: Dict): Dict {
  return without(event, ['type', 'delta', 'usage']);
}

// An ending says more of its message and never the message's own fields, so
// one named among what it carries is not written.
export function unowned(fields: Dict): Dict {
  return without(fields, ['id', 'type', 'role', 'model', 'content']);
}
