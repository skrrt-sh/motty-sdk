import { answer, motty, said } from "@mottyjs/core";

const GREETING = /^(hi|hello|hey|good (morning|afternoon|evening))[\s!.,]*$/i;
const REPLY = "Hello. Ask me something hard and I will put it to the council.";

// A greeting has nothing to disagree on, so it is answered before any model is paid for
export const greeting = motty({ name: "greeting" }).beforeHandle(({ request }) => {
  const last = said(request.messages.findLast((message) => message.role === "user"));
  return GREETING.test(last.trim()) ? answer(REPLY) : undefined;
});
