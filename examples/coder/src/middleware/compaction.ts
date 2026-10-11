import { motty, type Message } from "@mottyjs/core";
import { z } from "zod";
import { mini } from "../models";
import { tuning } from "../settings";

const INSTRUCTION = "Summarise this coding session, with the files touched and the decisions made.";

const Summary = z.object({
  summary: z.string(),
  files: z.array(z.string()),
  decisions: z.array(z.string()),
});

// A tail that starts at a user message never separates a tool result from its call
const tailStart = (messages: Message[], keptMessages: number) =>
  messages.findLastIndex(
    (message, index) => message.role === "user" && index <= messages.length - keptMessages,
  );

export const compaction = motty({ name: "compaction" })
  .use(tuning)
  .beforeHandle(async ({ prompt, settings }) => {
    const { messages } = prompt;
    const { longThreadMessages, keptMessages } = settings.compaction;
    if (messages.length <= longThreadMessages) return;

    const system = messages[0]?.role === "system" ? [messages[0]] : [];
    const start = tailStart(messages, keptMessages);
    if (start <= system.length) return;

    const reply = await mini.complete({
      messages: [{ role: "system", text: INSTRUCTION }, ...messages.slice(system.length, start)],
      output: Summary,
    });
    const { summary, files, decisions } = await reply.json();
    const earlier = [
      `Earlier in this session:\n${summary}`,
      `Files: ${files.join(", ")}`,
      `Decisions: ${decisions.join("; ")}`,
    ];

    prompt.messages = [
      ...system,
      { role: "system", text: earlier.join("\n") },
      ...messages.slice(start),
    ];
  });
