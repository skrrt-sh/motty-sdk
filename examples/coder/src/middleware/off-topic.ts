import { answer, motty, type ChatRequest } from "@mottyjs/core";
import { noul } from "@mottyjs/decision";
import { jev } from "../models";
import { tuning } from "../settings";

const ABOUT_SOFTWARE = "Is this a request about software or a codebase?";
const REPLY = "I only answer questions about software and codebases.";

// Later turns ("yes, do that") mean nothing without the thread, so only its opening is judged
const openingOf = ({ messages }: ChatRequest) =>
  messages.some((message) => message.role === "assistant")
    ? undefined
    : messages.findLast((message) => message.role === "user")?.text;

async function isOnTopic(opening: string, onTopicProbability: number): Promise<boolean> {
  try {
    const { software } = await jev.decide(opening, {
      software: noul({ instructions: ABOUT_SOFTWARE }),
    });
    return software.noul >= onTopicProbability;
  } catch {
    return true;
  }
}

// An agent shows an error as a failure of its own, so the refusal is an ordinary reply
export const offTopic = motty({ name: "off-topic" })
  .use(tuning)
  .beforeHandle(async ({ request, settings }) => {
    const opening = openingOf(request);
    if (opening && !(await isOnTopic(opening, settings.offTopic.onTopicProbability))) {
      return answer(REPLY);
    }
    return undefined;
  });
