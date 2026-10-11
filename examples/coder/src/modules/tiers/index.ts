import { motty, reroute } from "@mottyjs/core";
import { tuning } from "../../settings";
import { deep } from "../deep";
import { quick, standard } from "./answer";
import { previousTier, remember, tierOf } from "./choose";

export const tiers = motty({ name: "tiers" })
  .use(tuning)
  .derive(async ({ request }) => ({ previous: await previousTier(request) }))
  .route(({ request, settings, previous }) => tierOf(request, settings.tiers, previous), {
    // A quick question still gets an answer when both small models are down
    quick: ({ prompt }) => quick(prompt).catch(() => reroute("standard")),
    standard: ({ prompt }) => standard(prompt),
    // Both strong models down is no reason to fail a request the standard tier can answer
    deep: deep.catch(() => reroute("standard")),
  })
  .afterResponse(async ({ request, route, outcome, settings }) => {
    if (outcome === "completed") await remember(request, route, settings.tiers);
  });
