import { think, type Message } from "@mottyjs/core";
import type { Triage } from "../../middleware/triage";

const ESCALATED =
  "This case was escalated. Name the clause that applies, what the customer is owed and by when.";

// After the system messages and not before: the cached policy must stay the prompt's first bytes
export function briefed(messages: readonly Message[], brief: string): Message[] {
  const first = messages.findIndex((message) => message.role !== "system");
  const at = first === -1 ? messages.length : first;
  return [...messages.slice(0, at), { role: "system", text: brief }, ...messages.slice(at)];
}

export function escalatedBrief(messages: Message[], { category, urgent }: Triage): Message[] {
  think(`Escalated: ${category}${urgent ? ", urgent" : ""}. Checking it against the policy`);
  return briefed(messages, ESCALATED);
}
