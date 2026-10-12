import { motty } from "@mottyjs/core";
import { seat } from "../../middleware/seat";

export const scout = motty({ name: "scout" })
  .use(seat)
  .handle(({ agent, prompt }) => {
    // Answering for a family the caller is not of would send it options that family refuses
    if (agent === undefined) throw new Error("The scout seat got a caller that is no agent");
    return agent.family.small.complete(prompt);
  });
