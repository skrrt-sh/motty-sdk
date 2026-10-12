import type { Json, Options } from '@mottyjs/core/host';
import type { Leaving } from '../wire/fieldless.ts';
import { type Dict, dict, given, isDict } from '../wire/json.ts';
import { invalid } from '../wire/refusals.ts';

type Reasoning = NonNullable<Options['reasoning']>;

function effortOf(raw: Json | undefined): Reasoning['effort'] {
  switch (raw) {
    case undefined:
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return raw;
    default:
      return invalid('output_config.effort is not a known effort');
  }
}

// Beside the neutral reasoning: the form this caller said it in, which only
// this family reads and may be dropped, a thinking mode with no neutral
// form, and whether the caller asked to see reasoning, which progress follows.
export function reasoningOf(
  thinking: Json | undefined,
  rawEffort: Json | undefined,
): { reasoning?: Reasoning; kept: Dict; verbatim: Dict; shown: boolean } {
  const effort = effortOf(rawEffort);
  const leveled = effort === undefined ? {} : { effort };
  // An effort is no order to think here, so that it came alone is kept.
  const steered = effort === undefined ? {} : { output_config: { effort } };
  if (thinking === undefined || thinking === null) {
    return {
      ...(effort === undefined ? {} : { reasoning: leveled }),
      kept: steered,
      verbatim: {},
      shown: false,
    };
  }
  if (!isDict(thinking)) invalid('thinking must be an object');
  const { type, budget_tokens: budget, display, ...rest } = thinking;
  const exclude = display === 'omitted';
  const shape = given({ ...rest, display: exclude ? undefined : display });
  const seen = { ...leveled, ...(exclude ? { exclude } : {}) };
  switch (type) {
    case 'disabled':
      // Effort still steers a model that does not think; the neutral
      // effort can only say that it does not. Only some models can be told
      // not to think, so that this caller told one is kept beside it.
      return {
        reasoning: { effort: 'none' },
        kept: { thinking: { type }, ...steered },
        verbatim: {},
        shown: false,
      };
    case 'enabled':
      if (typeof budget !== 'number') {
        invalid('thinking.budget_tokens must be a number');
      }
      return {
        reasoning: { ...seen, budgetTokens: budget },
        kept: { thinking: { type, ...shape } },
        verbatim: {},
        shown: !exclude,
      };
    case 'adaptive':
      return {
        reasoning: seen,
        kept: { thinking: { type, ...shape } },
        verbatim: {},
        shown: !exclude,
      };
    default:
      if (typeof type !== 'string') invalid('thinking.type must be a string');
      return {
        ...(effort === undefined ? {} : { reasoning: leveled }),
        kept: steered,
        verbatim: { thinking },
        shown: false,
      };
  }
}

function effortTo(effort: Reasoning['effort']): string | undefined {
  return effort === 'none' || effort === 'minimal' ? 'low' : effort;
}

// A request that says an effort, a budget or a mute is sent the same with
// any connection, so the connection's own fields for reasoning are not sent.
export function unsaid(reasoning: Reasoning | undefined, defaults: Dict): Dict {
  const { effort, budgetTokens, exclude } = reasoning ?? {};
  if (effort === undefined && budgetTokens === undefined && exclude !== true) {
    return defaults;
  }
  const { thinking: _, output_config: config, ...rest } = defaults;
  const { effort: __, ...steer } = dict(config);
  return Object.keys(steer).length === 0
    ? rest
    : { ...rest, output_config: steer };
}

// Thinking in this API's own words is sent as said. Neutral words are
// translated: a budget is manual thinking, an effort adaptive, shown unless
// muted, and an order not to reason the lowest effort, which every model takes.
// A model that thinks only on a budget is sent the effort with no thinking.
export function reasoningTo(
  left: Leaving,
  reasoning: Reasoning | undefined,
  kept: Json | undefined,
  steer: Json | undefined,
  said?: Json,
  adaptive = true,
): { thinking?: Dict; effort?: string } {
  const { effort: level, budgetTokens, exclude } = reasoning ?? {};
  const { type, display, ...rest } = dict(kept);
  const { type: stated } = dict(said);
  const off =
    level === 'none' && (said === undefined ? type : stated) === 'disabled';
  const effort = off ? undefined : effortTo(level);
  const leveled = effort === undefined ? {} : { effort };
  left.without('reasoning.none', level === 'none' && !off);
  left.without('reasoning.minimal', level === 'minimal');
  if (said !== undefined) {
    left.without('reasoning.hint', kept);
    left.without('reasoning.own', budgetTokens);
    left.without('reasoning.own', exclude);
    return leveled;
  }
  if (off) return { thinking: { type: 'disabled' } };
  const { effort: alone } = dict(steer);
  const own = type !== undefined || alone !== undefined;
  const shape = given({
    ...rest,
    display:
      exclude === true
        ? 'omitted'
        : (display ?? (own ? undefined : 'summarized')),
  });
  if (budgetTokens !== undefined) {
    return {
      thinking: { type: 'enabled', budget_tokens: budgetTokens, ...shape },
      ...leveled,
    };
  }
  if (
    reasoning !== undefined &&
    level !== 'none' &&
    (type === 'adaptive' || (!own && effort !== undefined))
  ) {
    if (adaptive)
      return { thinking: { type: 'adaptive', ...shape }, ...leveled };
    left.without('reasoning.adaptive', true);
    return leveled;
  }
  left.without('reasoning.hint', kept);
  return leveled;
}
