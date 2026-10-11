import { motty, type ChatRequest } from "@mottyjs/core";
import { store } from "@mottyjs/store";
import { z } from "zod";

// Another release may have written the entry, so it is read through a schema, not trusted by type
const Case = z.object({
  category: z.enum(["dispute", "billing", "technical", "account", "other"]),
  urgent: z.boolean(),
  family: z.string(),
});

export type Case = z.infer<typeof Case>;

function caseKey(request: ChatRequest): string | undefined {
  const conversation = request.headers.get("x-conversation-id");
  return conversation ? `case:${conversation}` : undefined;
}

async function rememberedCase(request: ChatRequest): Promise<Case | undefined> {
  const key = caseKey(request);
  return key ? Case.safeParse(await store.get(key)).data : undefined;
}

export async function remember(request: ChatRequest, held: Case, rememberedMs: number): Promise<void> {
  const key = caseKey(request);
  if (key) await store.set(key, held, { ttlMs: rememberedMs });
}

export const conversation = motty({ name: "conversation" }).derive(async ({ request }) => ({
  remembered: await rememberedCase(request),
}));
