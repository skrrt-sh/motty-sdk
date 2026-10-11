import { model } from "@mottyjs/core";
import { decision } from "@mottyjs/decision";

export const mini = model("openai/gpt-5-mini");
export const gpt = model("openai/gpt-5");
export const haiku = model("anthropic/claude-haiku");
export const sonnet = model("anthropic/claude-sonnet");
export const opus = model("anthropic/claude-opus");
export const jev = decision("typesafe/jev-latest");
