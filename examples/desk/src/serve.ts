import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { jwt } from "@mottyjs/adapters/jwt";
import { openai } from "@mottyjs/adapters/openai";
import { openrouter } from "@mottyjs/adapters/openrouter";
import { redis } from "@mottyjs/adapters/redis";
import { typesafe } from "@mottyjs/adapters/typesafe";
import desk from "./motty";

export default serve(
  desk,
  ({ OPENAI_KEY, ANTHROPIC_KEY, OPENROUTER_KEY, TYPESAFE_KEY, REDIS_URL, JWKS_URL }) => ({
    models: [
      openai({ key: OPENAI_KEY }),
      anthropic({ key: ANTHROPIC_KEY }),
      // A customer's message goes through a router only to providers that keep none of it
      openrouter({
        key: OPENROUTER_KEY,
        headers: { "x-title": "Lumen support desk" },
        body: { provider: { data_collection: "deny" } },
      }),
      typesafe({ key: TYPESAFE_KEY }),
    ],
    storage: redis({ url: REDIS_URL }),
    auth: jwt({ jwks: JWKS_URL }),
    // The worst request triages, tries both strong models, reroutes, compacts and tries again
    limits: { duration: 90_000, calls: 12, afterResponse: 10_000 },
    settings: {
      triage: { abuseProbability: 0.9 },
      conversation: { rememberedSeconds: 7 * 24 * 60 * 60 },
    },
    report: (record) => console.log(JSON.stringify(record)),
  }),
);
