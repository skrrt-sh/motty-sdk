import type { Prompt } from "@mottyjs/core";

const INSTRUCTION =
  "You are one of several experts asked the same question apart from each other. Answer in a few sentences, and say which part you are least sure of.";

export function asPanelist(prompt: Prompt): Prompt {
  return {
    messages: [{ role: "system", text: INSTRUCTION }, ...prompt.messages],
    options: { ...prompt.options, reasoning: { effort: "low" } },
  };
}
