import type { Json, Options } from '@mottyjs/core/host';
import type { Taken } from '../codec.ts';
import type { Leaving } from './fieldless.ts';
import { type Dict, given } from './json.ts';

// What a request says of reasoning, read from the effort it is sent with:
// an order not to reason, an effort or a budget, or nothing.
export function reasons(
  effort: Json | undefined,
  budget?: Json,
): boolean | undefined {
  if (effort === 'none') return false;
  return effort !== undefined || budget !== undefined ? true : undefined;
}

// An effort the model does not take is left out before it is translated, so
// nothing an encoder would add for it is sent either.
export function effortless(
  left: Leaving,
  taken: Taken | undefined,
  reasoning: Options['reasoning'],
): Options['reasoning'] {
  if (taken?.effort !== false || reasoning?.effort === undefined) {
    return reasoning;
  }
  left.without('reasoning.model', reasoning.effort);
  const { effort: _, ...rest } = reasoning;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

// A connection's sampling field is replaced by the request's option of the
// same meaning, whether or not the model then takes the request's.
export function unsampled(defaults: Dict, options: Options): Dict {
  const { temperature, topP, topK, presencePenalty, frequencyPenalty } =
    options;
  const stated = given({
    temperature,
    top_p: topP,
    top_k: topK,
    presence_penalty: presencePenalty,
    frequency_penalty: frequencyPenalty,
  });
  return Object.fromEntries(
    Object.entries(defaults).filter(([name]) => !Object.hasOwn(stated, name)),
  );
}

// What the author said in the API's own words is sent as said, so the
// neutral option beside it is not.
function free(
  left: Leaving,
  said: Json | undefined,
  value: number | undefined,
): number | undefined {
  if (said === undefined) return value;
  left.without('sampling.own', value);
  return undefined;
}

// A value is never rescaled: one means the model's own distribution on every
// API. The one value a model allows asks for nothing, so it is not sent.
function ranged(
  left: Leaving,
  option: 'temperature' | 'topP',
  value: number | undefined,
  takes: Taken['temperature'] | undefined,
): number | undefined {
  if (value === undefined || takes === undefined) return value;
  if (typeof takes !== 'object') {
    left.without(`${option}.model`, value === takes ? undefined : value);
    return undefined;
  }
  const [least, most] = takes;
  const nearest = Math.min(Math.max(value, least), most);
  left.without(`${option}.range`, nearest === value ? undefined : value);
  return nearest;
}

function kept(
  left: Leaving,
  option: 'topK' | 'presencePenalty' | 'frequencyPenalty',
  value: number | undefined,
  taken: Taken | undefined,
): number | undefined {
  if (taken?.[option] !== false) return value;
  left.without(`${option}.model`, value);
  return undefined;
}

// The sampling fields to write, under the one name all three APIs give
// each. An encoder passes only what its API has a field for.
export function sampling(
  left: Leaving,
  taken: Taken | undefined,
  wanted: {
    [Option in
      | 'temperature'
      | 'topP'
      | 'topK'
      | 'presencePenalty'
      | 'frequencyPenalty']?: Options[Option] | undefined;
  },
  said: Dict,
): Dict {
  const {
    temperature: heat,
    top_p: nucleus,
    top_k: pool,
    presence_penalty: presence,
    frequency_penalty: frequency,
  } = said;
  // Where the two may not go together, one said in the API's own words
  // stands, and the neutral other is left out beside it.
  const apart = taken?.together === false;
  const warm = free(left, heat, wanted.temperature);
  const lone = apart && nucleus !== undefined;
  left.without('temperature.topP', lone ? warm : undefined);
  const temperature = lone
    ? undefined
    : ranged(left, 'temperature', warm, taken?.temperature);
  const alone = apart && (temperature !== undefined || heat !== undefined);
  const top = free(left, nucleus, wanted.topP);
  left.without('topP.temperature', alone ? top : undefined);
  return given({
    temperature,
    top_p: alone ? undefined : ranged(left, 'topP', top, taken?.topP),
    top_k: kept(left, 'topK', free(left, pool, wanted.topK), taken),
    presence_penalty: kept(
      left,
      'presencePenalty',
      free(left, presence, wanted.presencePenalty),
      taken,
    ),
    frequency_penalty: kept(
      left,
      'frequencyPenalty',
      free(left, frequency, wanted.frequencyPenalty),
      taken,
    ),
  });
}
