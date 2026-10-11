import { motty, MottyError } from "@mottyjs/core";

export class EmptyPrompt extends MottyError.define("empty_prompt", 400) {}

export const emptyPrompt = motty({ name: "empty-prompt" }).beforeHandle(({ request }) => {
  if (request.messages.length === 0) throw new EmptyPrompt("The request has no messages");
});
