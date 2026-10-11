import { motty, Overloaded, RateLimited, reroute, TimedOut } from "@mottyjs/core";
import { abuse } from "../../middleware/abuse";
import { remember } from "../../middleware/conversation";
import { familyOf, frontline, reader } from "../../models";
import { escalated } from "../escalated";
import { answered, read } from "./answer";
import { pathOf } from "./choose";

export const cases = motty({ name: "cases" })
  .use(abuse)
  .route(({ request, triage }) => pathOf(request, triage), {
    attachment: ({ prompt, settings, remembered }) =>
      read(prompt, reader(settings.models, remembered?.family)),
    // Busy strong models are no reason to fail a case the frontline can answer; any other
    // failure would fail there too
    escalated: escalated.catch((thrown) =>
      thrown instanceof RateLimited || thrown instanceof Overloaded || thrown instanceof TimedOut
        ? reroute("standard")
        : undefined,
    ),
    standard: ({ prompt, settings, remembered }) =>
      answered(
        prompt,
        frontline(settings.models, remembered?.family),
        settings.conversation.keptMessages,
      ),
  })
  // After the route, which a message the abuse gate answered never reaches, so that message is
  // not remembered as a case
  .afterResponse(async ({ request, outcome, answer, triage, settings }) => {
    if (outcome !== "completed") return;
    const answeredBy = await answer.model();
    if (answeredBy) {
      const { category, urgent } = triage;
      await remember(
        request,
        { category, urgent, family: familyOf(answeredBy) },
        settings.conversation.remembered,
      );
    }
  });
