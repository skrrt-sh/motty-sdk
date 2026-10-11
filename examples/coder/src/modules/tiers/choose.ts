import { think, type ChatRequest } from "@mottyjs/core";
import { choice } from "@mottyjs/decision";
import { store } from "@mottyjs/store";
import { jev } from "../../models";
import type { Tuning } from "../../settings";

const TIERS = ["quick", "standard", "deep"] as const;
type Tier = (typeof TIERS)[number];
type TierSettings = Tuning["tiers"];

const REASONING_NEEDED = "How much reasoning does this coding request need?";

export async function previousTier(request: ChatRequest): Promise<Tier | undefined> {
  const key = tierKey(request);
  return key ? store.get<Tier>(key) : undefined;
}

// Moving to a cheaper model mid-conversation throws away the provider's prompt cache
export async function tierOf(
  request: ChatRequest,
  settings: TierSettings,
  previous?: Tier,
): Promise<Tier> {
  const picked = obviousTier(request, settings) ?? (await classify(request, settings));
  const tier = strongest(picked, previous);
  think(`Answering with the ${tier} tier`);
  return tier;
}

export async function remember(
  request: ChatRequest,
  tier: Tier,
  { remembered }: TierSettings,
): Promise<void> {
  const key = tierKey(request);
  if (key) await store.set(key, tier, { ttl: remembered });
}

function tierKey(request: ChatRequest): string | undefined {
  const conversation = request.headers.get("x-conversation-id");
  return conversation ? `tier:${conversation}` : undefined;
}

function questionOf({ messages }: ChatRequest): string {
  return messages.findLast((message) => message.role === "user")?.text ?? "";
}

function obviousTier(
  request: ChatRequest,
  { quickQuestionChars }: TierSettings,
): Tier | undefined {
  if (request.model.endsWith(":fast")) return "quick";
  if (request.model.endsWith(":max")) return "deep";
  if (request.tools.length === 0 && questionOf(request).length < quickQuestionChars) return "quick";
  return undefined;
}

async function classify(request: ChatRequest, { deepProbability }: TierSettings): Promise<Tier> {
  try {
    const { tier } = await jev.decide(questionOf(request), {
      tier: choice({
        instructions: REASONING_NEEDED,
        criteria: {
          quick: "A short question that a small model answers without reasoning",
          standard: "An ordinary coding request that needs no plan and no high reasoning effort",
          deep: "A hard request that needs a plan first and high reasoning effort",
        },
      }),
    });
    // A weak answer to a hard request costs more than a strong answer to an easy one
    return tier.probabilities.deep >= deepProbability ? "deep" : tier.choice;
  } catch {
    return "standard";
  }
}

function strongest(picked: Tier, previous?: Tier): Tier {
  return previous && TIERS.indexOf(previous) > TIERS.indexOf(picked) ? previous : picked;
}
