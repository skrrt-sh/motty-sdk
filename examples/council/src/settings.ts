import { settings, type Settings } from "@mottyjs/settings";
import { z } from "zod";

const milliseconds = z.number().int().min(1);
const dollars = z.number().min(0);

export const tuning = settings({
  panel: z.object({
    seats: z.number().int().min(2).max(3).default(3),
    rounds: z.number().int().min(1).max(2).default(2),
  }),
  timeouts: z.object({
    first: milliseconds.default(20_000),
    stall: milliseconds.default(15_000),
  }),
  spend: z.object({
    requestUsd: dollars.default(0.05),
    dailyUsd: dollars.default(2),
  }),
});

export type Tuning = Settings<typeof tuning>;
