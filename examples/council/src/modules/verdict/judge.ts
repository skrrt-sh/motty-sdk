import { think, type Prompt } from "@mottyjs/core";
import { z } from "zod";
import { judge } from "../../models";
import type { Tuning } from "../../settings";
import { presented } from "../panel/present";

const INSTRUCTION =
  "Compare the panel's answers to the question above. They agree when they reach the same conclusion, whatever the wording. List every point on which two of them contradict each other.";

const Verdict = z.object({
  agreed: z.boolean(),
  disputed: z.array(z.string()),
});

export async function judged(
  prompt: Prompt,
  opinions: readonly string[],
  limits: Tuning["timeouts"],
) {
  const reply = await judge(limits).complete({
    messages: [
      ...prompt.messages,
      { role: "user", text: `${INSTRUCTION}\n\n${presented(opinions)}` },
    ],
    output: Verdict,
    options: {
      provider: {
        // A neutral order not to reason reaches Anthropic as low effort; this is Sonnet's own off
        anthropic: { thinking: { type: "between_tools" } },
        // Nothing to add for the stand-in: the empty entry lets the map go to either OpenAI API
        openai: {},
      },
    },
  });
  const verdict = await reply.json();
  think(
    verdict.agreed
      ? "The panel agrees"
      : `The panel disagrees on: ${verdict.disputed.join("; ")}`,
  );
  return verdict;
}
