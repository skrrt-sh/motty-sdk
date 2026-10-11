import { think, type Usage } from "@mottyjs/core";
import type { Tuning } from "../../settings";

// A call costs what the host's price says, or what its upstream reported where the host has none
export function stageAfter(
  agreed: boolean,
  { cost = 0 }: Usage,
  { panel, spend }: Tuning,
): "merge" | "debate" {
  if (agreed || panel.rounds < 2) return "merge";
  if (cost > spend.requestUsd) {
    think(`$${cost} of $${spend.requestUsd} is spent: answering without a second round`);
    return "merge";
  }
  return "debate";
}
