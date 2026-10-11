import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { jwt } from "@mottyjs/adapters/jwt";
import { openai } from "@mottyjs/adapters/openai";
import { redis } from "@mottyjs/adapters/redis";
import { typesafe } from "@mottyjs/adapters/typesafe";
import coder from "./motty";

export default serve(coder, ({ OPENAI_KEY, ANTHROPIC_KEY, TYPESAFE_KEY, REDIS_URL, JWKS_URL }) => ({
  models: [
    openai({ key: OPENAI_KEY }),
    anthropic({ key: ANTHROPIC_KEY }),
    typesafe({ key: TYPESAFE_KEY }),
  ],
  storage: redis({ address: REDIS_URL }),
  auth: jwt({ jwksAddress: JWKS_URL }),
  limits: { durationMs: 120_000, calls: 10, afterResponseMs: 30_000 },
  report: (record) => console.log(JSON.stringify(record)),
}));
