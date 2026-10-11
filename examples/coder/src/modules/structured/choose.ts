import type { ChatRequest } from "@mottyjs/core";
import { noul } from "@mottyjs/decision";
import { jev } from "../../models";
import type { Tuning } from "../../settings";

const SMALL_ENOUGH = "Can a small model fill this JSON from the conversation without reasoning?";

export async function sizeOf(
  request: ChatRequest,
  { smallProbability }: Tuning["structured"],
): Promise<"small" | "strong"> {
  const question = request.messages.findLast((message) => message.role === "user")?.text;
  try {
    const { small } = await jev.decide(
      { schema: request.output, question },
      { small: noul({ instructions: SMALL_ENOUGH }) },
    );
    return small.noul >= smallProbability ? "small" : "strong";
  } catch {
    return "strong";
  }
}
