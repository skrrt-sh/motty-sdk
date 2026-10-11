import { fallback, race, retry, type Answer, type Prompt } from "@mottyjs/core";
import { gpt, haiku, mini, sonnet } from "../../models";

export function quick(prompt: Prompt): Promise<Answer> {
  return race(mini, haiku).complete(prompt);
}

export function standard(prompt: Prompt): Promise<Answer> {
  return fallback(retry(sonnet, 2), gpt).complete(prompt);
}
