import { think, type Message, type Prompt } from "@mottyjs/core";
import { sonnet } from "../../models";

const INSTRUCTION = "Outline the approach in a few short steps. Call no tools and change nothing.";

// The caller reads the plan as reasoning while the stronger model has not started
export async function withPlan(prompt: Prompt): Promise<Message[]> {
  try {
    const plan = await sonnet.complete({
      ...prompt,
      messages: [...prompt.messages, { role: "user", text: INSTRUCTION }],
    });
    think(plan);
    return [...prompt.messages, { role: "user", text: `Follow this plan:\n${await plan.text()}` }];
  } catch {
    return [...prompt.messages];
  }
}
