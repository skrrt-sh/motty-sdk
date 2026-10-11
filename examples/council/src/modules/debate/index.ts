import { motty } from "@mottyjs/core";
import { tuning } from "../../settings";
import { merged } from "../merge/answer";
import { panel } from "../panel";
import { ask } from "../panel/ask";
import { verdict } from "../verdict";
import { inRebuttal } from "./rebut";

export const debate = motty({ name: "debate" })
  .use(tuning)
  .use(panel)
  .use(verdict)
  .derive(async ({ prompt, seats, opinions, verdict }) => ({
    revised: await ask(seats, inRebuttal(prompt, opinions, verdict.disputed)),
  }))
  .handle(({ prompt, revised, settings }) => merged(prompt, revised, settings.timeouts));
