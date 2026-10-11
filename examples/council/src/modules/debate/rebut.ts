import type { Prompt } from "@mottyjs/core";
import { presented } from "../panel/present";

const INSTRUCTION =
  "The panel disagreed on the question above. Read every answer below, then give your final answer in a few sentences: keep a position only where you can defend it.";

export function inRebuttal(
  prompt: Prompt,
  opinions: readonly string[],
  disputed: readonly string[],
): Prompt {
  const brief = [INSTRUCTION, presented(opinions), `In dispute:\n${disputed.join("\n")}`];
  return {
    messages: [...prompt.messages, { role: "user", text: brief.join("\n\n") }],
    options: { ...prompt.options, reasoning: { effort: "low" } },
  };
}
