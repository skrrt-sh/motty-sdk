import type { Usage } from "@mottyjs/core";
import { anthropic, familyOf, openai } from "./models";

// The host's own example figures in USD per million tokens, not a price list the SDK ships
const opus = { input: 4, cached: 0.2, cacheWrite: 5, output: 20 };
const sol = { input: 2, cached: 0.2, cacheWrite: 2, output: 16 };
const rates = new Map([
  [anthropic.lead.name, opus],
  [anthropic.small.name, { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 }],
  [openai.lead.name, sol],
  [openai.small.name, { input: 0.1, cached: 0.01, cacheWrite: 0.1, output: 0.8 }],
]);

// The input count includes the tokens read from a cache and written to one
export function price(
  model: string,
  { input = 0, output = 0, cached = 0, cacheWrite = 0 }: Readonly<Usage>,
): number {
  // An agent may name any model of its family, and one with no rate here must not be free
  const rate = rates.get(model) ?? (familyOf(model) === "openai" ? sol : opus);
  return (
    ((input - cached - cacheWrite) * rate.input +
      cached * rate.cached +
      cacheWrite * rate.cacheWrite +
      output * rate.output) /
    1_000_000
  );
}
