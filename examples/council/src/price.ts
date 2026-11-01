import type { Usage } from "@mottyjs/core";
import { haiku, luna, sonnet } from "./models";

// The host's own example figures in USD per million tokens, not a price list the SDK ships.
// OpenRouter reports what each call cost, so its models have no rate here.
// They assume 5-minute cache writes and prompts under the higher tier: Haiku over 100k tokens, Luna over 272k
const usdPerMillionTokens = new Map([
  [haiku.name, { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 }],
  [sonnet.name, { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10 }],
  [luna.name, { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 }],
]);

// The input count includes the tokens read from a cache and written to one.
// Nothing returned for a model with no rate, so the cost its upstream reported stands
export function price(
  model: string,
  { input = 0, output = 0, cached = 0, cacheWrite = 0 }: Readonly<Usage>,
): number | undefined {
  const rate = usdPerMillionTokens.get(model);
  return (
    rate &&
    ((input - cached - cacheWrite) * rate.input +
      cached * rate.cached +
      cacheWrite * rate.cacheWrite +
      output * rate.output) /
      1_000_000
  );
}
