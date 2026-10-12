import { model } from "@mottyjs/core";

// An agent that names no model asks for the motty itself, so this is a model name like the others
export const name = "fleet";

// An agent stays on its own family, because no other takes the options it sends
export const anthropic = {
  lead: model("anthropic/claude-opus-5-5"),
  small: model("anthropic/claude-haiku-5-5"),
};
export const openai = {
  lead: model("openai/gpt-6.1-sol"),
  small: model("openai/gpt-6-luna"),
};

export const familyOf = (named: string) => named.slice(0, named.indexOf("/"));
