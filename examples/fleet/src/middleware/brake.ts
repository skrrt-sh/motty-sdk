import { motty } from "@mottyjs/core";
import { tuning } from "../settings";
import { spent, stop } from "./ledger";
import { seat } from "./seat";

// A subagent past the budget is not cut off. The small model closes its work from what the
// subagent has read so far, and that goes back to the lead as its report
export const brake = motty({ name: "brake" })
  .use(tuning)
  .use(seat)
  .beforeHandle(async ({ agent, settings, prompt }) => {
    if (agent === undefined || agent.seat === "lead") return;
    const { family, session, seat } = agent;
    if ((await spent(session)) < settings.fleet.budget) return;
    await stop(session, seat);
    const { tools = [], options = {} } = prompt;
    return family.small.complete({
      ...prompt,
      messages: [
        ...prompt.messages,
        {
          role: "user",
          text: "The budget for this work is spent. Call no tool. Report in two sentences what you found so far and say that you were stopped early.",
        },
      ],
      // Anthropic refuses a history of tool calls that declares no tools, so they stay declared
      // and forbidden. A choice with no tools to choose from is refused as well
      options: tools.length > 0 ? { ...options, toolChoice: "none" } : options,
    });
  });
