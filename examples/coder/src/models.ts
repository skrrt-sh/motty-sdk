import { model } from "@mottyjs/core";
import { decision } from "@mottyjs/decision";

export const luna = model("openai/gpt-6-luna");
export const sol = model("openai/gpt-6.1-sol");
export const haiku = model("anthropic/claude-haiku-5-5");
export const sonnet = model("anthropic/claude-sonnet-5-5");
export const opus = model("anthropic/claude-opus-5-5");
export const jev = decision("typesafe/jev-latest");
