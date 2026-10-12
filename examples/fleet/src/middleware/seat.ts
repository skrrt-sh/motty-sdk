import { motty } from "@mottyjs/core";
import { anthropic, openai } from "../models";

// Codex gives a subagent a thread of its own inside the lead's session. Claude Code names a
// subagent in a header the lead does not send. A caller with neither is no agent
export const seat = motty({ name: "seat" }).derive(({ request: { headers } }) => {
  const thread = headers.get("thread-id");
  if (thread !== null) {
    const session = headers.get("session-id") ?? "";
    return { agent: { family: openai, session, seat: thread === session ? "lead" : thread } };
  }
  const session = headers.get("x-claude-code-session-id");
  if (session === null) return { agent: undefined };
  const seat = headers.get("x-claude-code-agent-id") ?? "lead";
  return { agent: { family: anthropic, session, seat } };
});
