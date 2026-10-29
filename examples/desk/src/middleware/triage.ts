import { motty, said, think, type ChatRequest } from "@mottyjs/core";
import { choice, noul, score } from "@mottyjs/decision";
import { jev } from "../models";
import { tuning, type Tuning } from "../settings";
import { conversation, type Case } from "./conversation";

export type Triage = Pick<Case, "category" | "urgent"> & { abusive: boolean };

async function triaged(
  request: ChatRequest,
  { abuseProbability, disputeProbability, urgentProbability }: Tuning["triage"],
  remembered?: Case,
): Promise<Triage> {
  // Without a new judgement the case stays as it was: a guess neither refuses nor escalates
  const asBefore: Triage = {
    category: remembered?.category ?? "other",
    urgent: remembered?.urgent ?? false,
    abusive: false,
  };
  // A tool result is the agent's turn, so after one the customer has said nothing new to judge
  const last = request.messages.at(-1);
  const text = last?.role === "user" ? said(last) : "";
  if (text === "") return asBefore;

  think("Reading your message");
  try {
    const { abuse, category, urgency } = await jev.decide(text, {
      abuse: noul({
        instructions: "Is this message abuse of the support staff: threats, slurs or harassment?",
        criteria: { false: "An angry or rude customer with a real complaint" },
      }),
      category: choice({
        instructions: "What is this support message about?",
        criteria: {
          dispute: "A charge the customer contests, a refund demanded, a chargeback threatened",
          billing: "An invoice, a plan, a price or a payment method, with nothing contested",
          technical: "The product does not work as the customer expects",
          account: "Signing in, access, or the customer's personal data",
          other: null,
        },
      }),
      urgency: score({
        instructions: "How urgent is this for the customer?",
        criteria: [
          "No time pressure",
          "Wants an answer today",
          "Cannot use the product until this is solved",
          "Is losing money or data while waiting",
        ],
      }),
    });
    const { probabilities: level } = urgency;
    return {
      // A dispute answered by a small model costs more than a plain question answered by a strong
      category: category.probabilities.dispute >= disputeProbability ? "dispute" : category.choice,
      urgent: (level["2"] ?? 0) + (level["3"] ?? 0) >= urgentProbability,
      abusive: abuse.noul >= abuseProbability,
    };
  } catch {
    return asBefore;
  }
}

export const triage = motty({ name: "triage" })
  .use(tuning)
  .use(conversation)
  .derive(async ({ request, settings, remembered }) => ({
    triage: await triaged(request, settings.triage, remembered),
  }));
