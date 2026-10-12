import { motty } from "@mottyjs/core";
import { seat } from "../../middleware/seat";
import { modelFor } from "./choose";

export const asked = motty({ name: "asked" })
  .use(seat)
  .handle(({ family, request, prompt }) => {
    // Answering for a family the caller is not of would send it options that family refuses
    if (family === undefined) throw new Error("The asked model got a caller that is no agent");
    return modelFor(family.lead, request.model).complete(prompt);
  });
