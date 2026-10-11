import { fallback, retry, type Answer, type Prompt } from "@mottyjs/core";
import { gpt, mini, sonnet } from "../../models";

// Reading the reply here throws on one that was cut off, before any of it reaches the caller
export async function small(prompt: Prompt): Promise<Answer> {
  const reply = await mini.complete(prompt);
  await reply.json();
  return reply;
}

export function strong(prompt: Prompt): Promise<Answer> {
  return fallback(retry(sonnet, 2), gpt).complete(prompt);
}
