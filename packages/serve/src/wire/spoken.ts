import type { Json, Options } from '@mottyjs/core/host';
import { type Dict, isDict, put } from './json.ts';

function isText(value: Json): value is string {
  return typeof value === 'string';
}

function isFlag(value: Json): value is boolean {
  return typeof value === 'boolean';
}

const unsaid = { options: {}, odd: {} };

// What the two OpenAI APIs say in their own names of what an option holds, so
// one statement has one home and every upstream reads it from there. A value the
// option cannot hold, as a null, stays `odd`, to be sent as it was said.
export function spoken(said: Dict): { options: Options; odd: Dict } {
  if (Object.keys(said).length === 0) return unsaid;
  const odd: Dict = {};
  function held<Value extends Json>(
    name: string,
    fits: (value: Json) => value is Value,
  ): Value | undefined {
    const value = said[name];
    if (value === undefined || fits(value)) return value;
    put(odd, name, value);
    return undefined;
  }
  const options: Options = {};
  const metadata = held('metadata', isDict);
  const store = held('store', isFlag);
  const serviceTier = held('service_tier', isText);
  const safetyIdentifier = held('safety_identifier', isText);
  const cacheKey = held('prompt_cache_key', isText);
  const cacheOptions = held('prompt_cache_options', isDict);
  const cacheRetention = held('prompt_cache_retention', isText);
  const prediction = held('prediction', isDict);
  const verbosity = held('verbosity', isText);
  if (metadata !== undefined) options.metadata = metadata;
  if (store !== undefined) options.store = store;
  if (serviceTier !== undefined) options.serviceTier = serviceTier;
  if (safetyIdentifier !== undefined)
    options.safetyIdentifier = safetyIdentifier;
  if (cacheKey !== undefined) options.cacheKey = cacheKey;
  if (cacheOptions !== undefined) options.cacheOptions = cacheOptions;
  if (cacheRetention !== undefined) options.cacheRetention = cacheRetention;
  if (prediction !== undefined) options.prediction = prediction;
  if (verbosity !== undefined) options.verbosity = verbosity;
  return { options, odd };
}
