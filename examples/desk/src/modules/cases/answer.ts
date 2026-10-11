import {
  ContextTooLong,
  think,
  Unsupported,
  type Answer,
  type Model,
  type Prompt,
} from "@mottyjs/core";
import { briefed } from "../escalated/brief";
import { mediaKinds } from "./choose";
import { compacted } from "./compact";

// Told to answer from the policy only, a reader says it cannot see what the policy does not mention
const ATTACHED =
  "The customer attached a picture or a document. Say what it shows, then apply the policy.";

// Tools and the tool choice are the caller's agent's: the prompt goes upstream whole, none is run
export async function answered(
  prompt: Prompt,
  frontline: Model,
  keptMessages: number,
): Promise<Answer> {
  try {
    return await frontline.complete(prompt);
  } catch (thrown) {
    if (!(thrown instanceof ContextTooLong)) throw thrown;
    think("This conversation is long: summarising its earlier part");
    return frontline.complete(await compacted(prompt, keptMessages));
  }
}

export async function read(prompt: Prompt, reader: Model): Promise<Answer> {
  // A voice message leaves no text to quote in a dispute, so it is refused in words to act on
  if (mediaKinds(prompt.messages).has("audio")) {
    throw new Unsupported("The desk reads pictures and documents. Send a voice message as text.");
  }
  think("Reading the attachment");
  return reader.complete({ ...prompt, messages: briefed(prompt.messages, ATTACHED) });
}
