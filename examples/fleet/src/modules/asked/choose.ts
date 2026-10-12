import { model, type Model, type NamedModel } from "@mottyjs/core";
import { familyOf, name } from "../../models";

// An agent run under the motty's own name asked for no model, so its family's lead model answers
export function modelFor(lead: NamedModel, asked: string): Model {
  return asked === name ? lead : model(`${familyOf(lead.name)}/${asked}`);
}
