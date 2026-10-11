import { settings, type Settings } from "@mottyjs/settings";
import { z } from "zod";

const probability = z.number().min(0).max(1);
const positiveInteger = z.number().int().min(1);

export const tuning = settings({
  triage: z.object({
    abuseProbability: probability.default(0.85),
    disputeProbability: probability.default(0.35),
    urgentProbability: probability.default(0.5),
  }),
  models: z.object({
    frontline: z.enum(["nano", "haiku"]).default("nano"),
    senior: z.enum(["sonnet", "oss"]).default("sonnet"),
    reader: z.enum(["gemini", "haiku"]).default("gemini"),
    firstChunkMs: positiveInteger.default(15_000),
    silentMs: positiveInteger.default(30_000),
  }),
  conversation: z.object({
    rememberedSeconds: positiveInteger.default(3 * 24 * 60 * 60),
    keptMessages: positiveInteger.default(8),
  }),
});

export type Tuning = Settings<typeof tuning>;
