import { fallback, motty, timeout } from "@mottyjs/core";
import { gpt, opus } from "../../models";
import { tuning } from "../../settings";
import { withPlan } from "./plan";

export const deep = motty({ name: "deep" })
  .use(tuning)
  .beforeHandle(async ({ prompt }) => {
    prompt.messages = await withPlan(prompt);
    prompt.options = { ...prompt.options, reasoning: { effort: "high" } };
  })
  .handle(({ prompt, settings }) =>
    fallback(timeout(opus, settings.deep.firstChunk), gpt).complete(prompt),
  );
