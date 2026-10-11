import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { jwt } from "@mottyjs/adapters/jwt";
import { openai } from "@mottyjs/adapters/openai";
import { openrouter } from "@mottyjs/adapters/openrouter";
import { redis } from "@mottyjs/adapters/redis";
import { haiku, nano, sonnet } from "./models";
import council from "./motty";

// The host's own example figures in USD per million tokens, not a price list the SDK ships.
// OpenRouter reports what each call cost, so its models have no rate here
const usdPerMillionTokens = new Map([
  [haiku.name, { input: 1, output: 5 }],
  [sonnet.name, { input: 3, output: 15 }],
  [nano.name, { input: 0.05, output: 0.4 }],
]);

export default serve(
  council,
  ({ OPENAI_KEY, ANTHROPIC_KEY, OPENROUTER_KEY, REDIS_URL, JWKS_URL }) => ({
    models: [
      openai({ key: OPENAI_KEY }),
      anthropic({ key: ANTHROPIC_KEY }),
      openrouter({
        key: OPENROUTER_KEY,
        // OpenRouter lists the app that made a request by these two
        headers: { "HTTP-Referer": "https://acme.example/council", "X-Title": "council" },
      }),
    ],
    storage: redis({ address: REDIS_URL }),
    auth: jwt({ jwksAddress: JWKS_URL }),
    // Two rounds of three seats with their races and fallbacks, a verdict and a merge
    limits: { duration: 180_000, calls: 24, afterResponse: 10_000 },
    // Nothing returned for a model with no rate, so the cost its upstream reported stands
    price: (model, { input = 0, output = 0 }) => {
      const rate = usdPerMillionTokens.get(model);
      return rate && (input * rate.input + output * rate.output) / 1_000_000;
    },
    report: (record) => console.log(JSON.stringify(record)),
  }),
);
