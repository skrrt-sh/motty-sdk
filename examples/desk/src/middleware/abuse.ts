import { answer, motty } from "@mottyjs/core";
import { triage } from "./triage";

const REPLY = "I can't help while the conversation is like this. Tell me what went wrong.";

// No chat model reads the message, so abuse costs nothing and none is drawn into answering in kind
export const abuse = motty({ name: "abuse" })
  .use(triage)
  .beforeHandle(({ triage }) => (triage.abusive ? answer(REPLY) : undefined));
