import { motty } from "@mottyjs/core";
import { panelists } from "../../models";
import { tuning } from "../../settings";
import { ask } from "./ask";
import { asPanelist } from "./brief";

export const panel = motty({ name: "panel" })
  .use(tuning)
  .derive(({ settings }) => ({
    seats: panelists(settings.timeouts).slice(0, settings.panel.seats),
  }))
  .derive(async ({ prompt, seats }) => ({ opinions: await ask(seats, asPanelist(prompt)) }));
