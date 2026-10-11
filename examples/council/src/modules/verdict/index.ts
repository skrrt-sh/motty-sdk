import { motty } from "@mottyjs/core";
import { tuning } from "../../settings";
import { panel } from "../panel";
import { judged } from "./judge";

export const verdict = motty({ name: "verdict" })
  .use(tuning)
  .use(panel)
  .derive(async ({ prompt, opinions, settings }) => ({
    verdict: await judged(prompt, opinions, settings.timeouts),
  }));
