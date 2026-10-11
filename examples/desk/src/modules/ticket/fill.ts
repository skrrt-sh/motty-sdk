import { InvalidOutput, think, type Answer, type Model, type Prompt } from "@mottyjs/core";
import { z } from "zod";
import { clerk, secondClerk } from "../../models";

const INSTRUCTION =
  "File this conversation as one support ticket. Use null for what the customer did not say.";

// Every key is required and nullable, the one form every upstream's strict mode takes
export const Ticket = z.object({
  category: z.enum(["dispute", "billing", "technical", "account", "other"]),
  urgency: z.enum(["low", "normal", "high"]),
  summary: z.string(),
  orderNumber: z.string().nullable(),
  wants: z.string().nullable(),
});

async function filledBy(clerk: Model, { messages, options }: Prompt): Promise<Answer> {
  const { toolChoice, parallelToolCalls, ...kept } = options ?? {};
  const reply = await clerk.complete({
    messages: [...messages, { role: "user", text: INSTRUCTION }],
    options: kept,
    output: { schema: Ticket, name: "ticket", strict: true },
  });
  // Read here, so a ticket the schema refuses is filed again before the caller has a byte of it
  await reply.json();
  return reply;
}

export async function filed(prompt: Prompt): Promise<Answer> {
  think("Filing a ticket");
  try {
    return await filledBy(clerk, prompt);
  } catch (thrown) {
    if (!(thrown instanceof InvalidOutput)) throw thrown;
    return filledBy(secondClerk, prompt);
  }
}
