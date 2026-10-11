import { settings, type Settings } from "@mottyjs/settings";
import { z } from "zod";

const probability = z.number().min(0).max(1);
const positiveInteger = z.number().int().min(1);

export const tuning = settings({
  compaction: z.object({
    longThreadMessages: positiveInteger.default(80),
    keptMessages: positiveInteger.default(12),
  }),
  offTopic: z.object({
    onTopicProbability: probability.default(0.1),
  }),
  tiers: z.object({
    quickQuestionChars: z.number().int().min(0).default(400),
    deepProbability: probability.default(0.35),
    rememberedSeconds: positiveInteger.default(24 * 60 * 60),
  }),
  structured: z.object({
    smallProbability: probability.default(0.7),
  }),
  deep: z.object({
    firstChunkMs: positiveInteger.default(20_000),
  }),
});

export type Tuning = Settings<typeof tuning>;
