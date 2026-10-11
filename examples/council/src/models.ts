import { fallback, model, race, retry, timeout } from "@mottyjs/core";
import type { Tuning } from "./settings";

export const haiku = model("anthropic/claude-haiku-5-5");
export const sonnet = model("anthropic/claude-sonnet-5-5");
export const nano = model("openai/gpt-5-nano");
export const oss = model("openrouter/openai/gpt-oss-20b");
export const flash = model("openrouter/deepseek/deepseek-v4-flash");

type Limits = Tuning["timeouts"];

const claudeSeat = (limits: Limits) =>
  fallback(retry(timeout(haiku, limits), 1), timeout(nano, limits));

const gptSeat = (limits: Limits) =>
  fallback(retry(timeout(nano, limits), 1), timeout(oss, limits));

// Two cheap models share this seat: the first to start answering keeps it
const openSeat = (limits: Limits) =>
  fallback(timeout(race(oss, flash), limits), timeout(haiku, limits));

// Each seat starts at another provider, so one provider's outage never empties the panel
export const panelists = (limits: Limits) => [
  claudeSeat(limits),
  gptSeat(limits),
  openSeat(limits),
];

export const chair = (limits: Limits) =>
  fallback(retry(timeout(sonnet, limits), 2), timeout(flash, limits));

// The stand-in is of another family, so the judge's prompt addresses each family it may reach
export const judge = (limits: Limits) =>
  fallback(retry(timeout(sonnet, limits), 1), timeout(nano, limits));
