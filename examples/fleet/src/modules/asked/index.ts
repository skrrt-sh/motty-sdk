import { motty } from "@mottyjs/core";
import { seat } from "../../middleware/seat";
import { modelFor } from "./choose";

export const asked = motty({ name: "asked" })
  .use(seat)
  .handle(({ agent, request, prompt }) => {
    // Answering for a family the caller is not of would send it options that family refuses
    if (agent === undefined) throw new Error("The asked model got a caller that is no agent");
    return modelFor(agent.family.lead, request.model).complete(prompt);
  });
