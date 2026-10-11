import type { Message, Prompt } from "@mottyjs/core";
import { summariser } from "../../models";

const INSTRUCTION =
  "Summarise this support conversation: what was asked, what was established, what is still open.";

const holdsToolResult = ({ parts }: Message) =>
  parts?.some((part) => part.type === "tool_result") ?? false;

// A tail that starts at the customer's own words never separates a tool result from its call
const tailStart = (messages: readonly Message[], keptMessages: number) =>
  messages.findLastIndex(
    (message, index) =>
      message.role === "user" &&
      !holdsToolResult(message) &&
      index <= messages.length - keptMessages,
  );

export async function compacted(prompt: Prompt, keptMessages: number): Promise<Prompt> {
  const { messages } = prompt;
  const first = messages.findIndex((message) => message.role !== "system");
  const start = tailStart(messages, keptMessages);
  if (first === -1 || start <= first) return prompt;

  const summary = await summariser.complete({
    messages: [{ role: "system", text: INSTRUCTION }, ...messages.slice(first, start)],
  });
  return {
    ...prompt,
    // The system messages stay first and unchanged, so the cached policy is still read from cache
    messages: [
      ...messages.slice(0, first),
      { role: "system", text: `Earlier in this conversation:\n${await summary.text()}` },
      ...messages.slice(start),
    ],
  };
}
