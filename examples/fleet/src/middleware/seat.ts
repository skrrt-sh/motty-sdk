import { motty } from "@mottyjs/core";
import { anthropic, openai } from "../models";

// Codex gives a subagent a thread of its own inside the lead's session. Claude Code names a
// subagent in a header the lead does not send. A caller with neither is no agent and has no family
export const seat = motty({ name: "seat" }).derive(({ request: { headers } }) => {
  const thread = headers.get("thread-id");
  if (thread !== null) {
    return { family: openai, seat: thread === headers.get("session-id") ? "lead" : thread };
  }
  return {
    family: headers.has("x-claude-code-session-id") ? anthropic : undefined,
    seat: headers.get("x-claude-code-agent-id") ?? "lead",
  };
});
