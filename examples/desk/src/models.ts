import { fallback, model, retry, timeout, type Model, type NamedModel } from "@mottyjs/core";
import { decision } from "@mottyjs/decision";
import type { Tuning } from "./settings";

export const nano = model("openai/gpt-4.1-nano");
export const haiku = model("anthropic/claude-haiku-5-5");
export const sonnet = model("anthropic/claude-sonnet-5-5");
export const oss = model("openrouter/openai/gpt-oss-20b");
export const gemini = model("openrouter/google/gemini-2.5-flash-lite");
export const jev = decision("typesafe/jev-latest");

const frontlines = { nano, haiku };
const seniors = { sonnet, oss };
const readers = { gemini, haiku };

export const familyOf = (name: string) => name.slice(0, name.indexOf("/"));

// A model goes on only from reasoning its own family signed, so that family is asked
// first, whatever the operator chose
function inOrder<Name extends string>(
  tier: Record<Name, NamedModel>,
  chosen: Name,
  family?: string,
): [NamedModel, ...NamedModel[]] {
  const models = Object.values<NamedModel>(tier);
  const first = models.find((model) => familyOf(model.name) === family) ?? tier[chosen];
  return [first, ...models.filter((model) => model !== first)];
}

export function frontline(chosen: Tuning["models"], family?: string): Model {
  return fallback(
    ...inOrder(frontlines, chosen.frontline, family).map((model) =>
      timeout(model, chosen.firstChunk),
    ),
  );
}

// A model that reasons is silent for long before its first chunk too, so one patience limits both
export function senior(chosen: Tuning["models"], family?: string): Model {
  const patient = (model: Model) =>
    timeout(model, { first: chosen.silent, stall: chosen.silent });
  const [first, ...others] = inOrder(seniors, chosen.senior, family);
  return fallback(retry(patient(first), 1), ...others.map(patient));
}

export function reader(chosen: Tuning["models"], family?: string): Model {
  return fallback(
    ...inOrder(readers, chosen.reader, family).map((model) => timeout(model, chosen.firstChunk)),
  );
}

export const clerk = fallback(nano, haiku);
export const secondClerk = fallback(haiku, sonnet);
export const summariser = fallback(nano, haiku);
