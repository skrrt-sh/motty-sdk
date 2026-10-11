import { motty } from "@mottyjs/core";
import { tuning } from "../../settings";
import { panel } from "../panel";
import { merged } from "./answer";

export const merge = motty({ name: "merge" })
  .use(tuning)
  .use(panel)
  .handle(({ prompt, opinions, settings }) => merged(prompt, opinions, settings.timeouts));
