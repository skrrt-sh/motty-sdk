import type { Usage } from "@mottyjs/core";

// The host's own example figures in USD per million tokens, not a price list the SDK ships
const rates = new Map([
  ["anthropic/claude-opus-5-5", { input: 4, cached: 0.2, cacheWrite: 5, output: 20 }],
  ["anthropic/claude-haiku-5-5", { input: 0.1, cached: 0.01, cacheWrite: 0.125, output: 0.5 }],
  ["openai/gpt-6.1-sol", { input: 2, cached: 0.2, cacheWrite: 2, output: 16 }],
  ["openai/gpt-6-luna", { input: 0.1, cached: 0.01, cacheWrite: 0.1, output: 0.8 }],
]);

// The input count includes the tokens read from a cache and written to one
export function price(
  model: string,
  { input = 0, output = 0, cached = 0, cacheWrite = 0 }: Readonly<Usage>,
): number | undefined {
  const rate = rates.get(model);
  return (
    rate &&
    ((input - cached - cacheWrite) * rate.input +
      cached * rate.cached +
      cacheWrite * rate.cacheWrite +
      output * rate.output) /
      1_000_000
  );
}
