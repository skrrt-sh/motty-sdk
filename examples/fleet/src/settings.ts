import { settings } from "@mottyjs/settings";
import { z } from "zod";

// What one session, a lead and its subagents, may spend together in USD
const budget = z.number().min(0).default(1);

export const tuning = settings({
  fleet: z.object({
    // "asked" answers a subagent with the model its agent asked for, "small" with the small one
    scouts: z.enum(["asked", "small"]).default("small"),
    budget,
  }),
});

// A budget that is no amount would be refused on every request, so no host starts with one
export function budgetFrom(text = "") {
  const read = budget.safeParse(text.trim() === "" ? undefined : Number(text));
  if (read.success) return read.data;
  throw new Error(`The fleet host was given BUDGET=${text}, which is no amount in USD of 0 or more`);
}
