import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { jwt } from "@mottyjs/adapters/jwt";
import { openai } from "@mottyjs/adapters/openai";
import { openrouter } from "@mottyjs/adapters/openrouter";
import { redis } from "@mottyjs/adapters/redis";
import council from "./motty";
import { price } from "./price";

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
    storage: redis({ url: REDIS_URL }),
    auth: jwt({ jwks: JWKS_URL }),
    // Two rounds of three seats with their races and fallbacks, a verdict and a merge
    limits: { duration: 180_000, calls: 24, afterResponse: 10_000 },
    price,
    report: ({ settings, ...record }) => console.log(JSON.stringify(record)),
  }),
);
