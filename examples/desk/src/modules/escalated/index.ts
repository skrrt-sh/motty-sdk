import { motty } from "@mottyjs/core";
import { triage } from "../../middleware/triage";
import { senior } from "../../models";
import { escalatedBrief } from "./brief";

export const escalated = motty({ name: "escalated" })
  .use(triage)
  .beforeHandle(({ prompt, triage }) => {
    prompt.messages = escalatedBrief(prompt.messages, triage);
    // The caller's own word on reasoning stays, so one who muted it is still shown none
    prompt.options = {
      ...prompt.options,
      reasoning: { ...prompt.options?.reasoning, effort: "high" },
    };
  })
  .handle(({ prompt, settings, remembered }) =>
    senior(settings.models, remembered?.family).complete(prompt),
  );
