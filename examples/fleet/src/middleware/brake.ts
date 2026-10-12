import { motty } from "@mottyjs/core";
import { store } from "@mottyjs/store";
import { tuning } from "../settings";
import { spent } from "./ledger";
import { seat } from "./seat";

export const stopped = async (seat: string) =>
  (await store.get<boolean>(`stopped:${seat}`)) ?? false;

// A subagent past the budget is not cut off: the small model closes its work from what the
// subagent has read so far, and that goes back to the lead as its report. The tools stay
// declared and forbidden, since Anthropic refuses a history of tool calls that declares none
export const brake = motty({ name: "brake" })
  .use(tuning)
  .use(seat)
  .beforeHandle(async ({ family, seat, settings, prompt }) => {
    if (family === undefined || seat === "lead") return;
    if ((await spent()) < settings.fleet.budget) return;
    await store.set(`stopped:${seat}`, true);
    const { tools = [] } = prompt;
    return family.small.complete({
      messages: [
        ...prompt.messages,
        {
          role: "user",
          text: "The budget for this work is spent. Call no tool. Report in two sentences what you found so far and say that you were stopped early.",
        },
      ],
      tools,
      // A choice with no tools to choose from is refused as well
      options: tools.length > 0 ? { toolChoice: "none" } : {},
    });
  });
