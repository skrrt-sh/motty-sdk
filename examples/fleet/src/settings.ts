import { settings } from "@mottyjs/settings";
import { z } from "zod";

export const tuning = settings({
  fleet: z.object({
    // "asked" answers a subagent with the model its agent asked for, "small" with the small one
    scouts: z.enum(["asked", "small"]).default("small"),
    // What every caller of this URL may spend together, in the host's own unit
    budget: z.number().min(0).default(1),
  }),
});
