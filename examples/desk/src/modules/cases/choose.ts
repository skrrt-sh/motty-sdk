import type { ChatRequest, Message, Part } from "@mottyjs/core";
import type { Triage } from "../../middleware/triage";

function mediaIn(parts: readonly Part[]): Part["type"][] {
  return parts.flatMap((part) => {
    if (part.type === "image" || part.type === "file" || part.type === "audio") return [part.type];
    return part.type === "tool_result" && part.parts ? mediaIn(part.parts) : [];
  });
}

// Every turn sends the whole conversation again, so an earlier turn's picture is still to be read
export function mediaKinds(messages: readonly Message[]): Set<Part["type"]> {
  return new Set(messages.flatMap((message) => mediaIn(message.parts ?? [])));
}

export function pathOf(
  request: ChatRequest,
  { category, urgent }: Triage,
): "attachment" | "escalated" | "standard" {
  // A model that cannot see the attachment has nothing to answer about, so media outranks urgency
  if (mediaKinds(request.messages).size > 0) return "attachment";
  return category === "dispute" || urgent ? "escalated" : "standard";
}
