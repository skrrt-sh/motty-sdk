import { motty } from "@mottyjs/core";
import { tuning } from "../../settings";
import { drawn } from "./draw";

// The same state every caller adds to, read by a caller that is no agent at all
export const board = motty({ name: "board" })
  .use(tuning)
  .handle(({ settings }) => drawn(settings.fleet.budget));
