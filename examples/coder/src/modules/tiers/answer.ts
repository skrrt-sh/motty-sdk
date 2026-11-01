import { fallback, race, retry, type Answer, type Prompt } from "@mottyjs/core";
import { haiku, luna, sol, sonnet } from "../../models";

export function quick(prompt: Prompt): Promise<Answer> {
  return race(luna, haiku).complete(prompt);
}

export function standard(prompt: Prompt): Promise<Answer> {
  return fallback(retry(sonnet, 2), sol).complete(prompt);
}
