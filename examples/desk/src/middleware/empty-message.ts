import { answer, motty, type ChatRequest } from "@mottyjs/core";

const REPLY = "I did not get a message. Tell me what happened and I will help.";

function isBlank(message: ChatRequest["messages"][number] | undefined): boolean {
  if (message === undefined) return true;
  if (message.parts === undefined) return message.text.trim() === "";
  return message.parts.every((part) => part.type === "text" && part.text.trim() === "");
}

// A customer who sent nothing is asked again in words; an error would read as the desk being broken
export const emptyMessage = motty({ name: "empty-message" }).beforeHandle(({ request }) =>
  isBlank(request.messages.at(-1)) ? answer(REPLY) : undefined,
);
