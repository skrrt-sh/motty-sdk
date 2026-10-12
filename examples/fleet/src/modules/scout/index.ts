import { motty } from "@mottyjs/core";
import { seat } from "../../middleware/seat";

export const scout = motty({ name: "scout" })
  .use(seat)
  .handle(({ family, prompt }) => {
    // Answering for a family the caller is not of would send it options that family refuses
    if (family === undefined) throw new Error("The scout seat got a caller that is no agent");
    return family.small.complete(prompt);
  });
