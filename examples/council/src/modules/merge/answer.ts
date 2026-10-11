import type { Answer, Prompt } from "@mottyjs/core";
import { chair } from "../../models";
import type { Tuning } from "../../settings";
import { presented } from "../panel/present";

const INSTRUCTION =
  "Answer the question above for the person who asked it, from the panel's answers below. Where they differ, decide which is right and say why in a sentence. Do not mention the panel.";

export function merged(
  prompt: Prompt,
  opinions: readonly string[],
  limits: Tuning["timeouts"],
): Promise<Answer> {
  return chair(limits).complete({
    messages: [
      ...prompt.messages,
      { role: "user", text: `${INSTRUCTION}\n\n${presented(opinions)}` },
    ],
    options: { ...prompt.options, reasoning: { effort: "high" } },
  });
}
