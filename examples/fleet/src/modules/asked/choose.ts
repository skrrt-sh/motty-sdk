import { model, type Model, type NamedModel } from "@mottyjs/core";
import { familyOf, name } from "../../models";

// A host that publishes motties under a handle has an agent ask for handle/name
const isOwnName = (asked: string) => asked === name || asked.endsWith(`/${name}`);

// An agent run under the motty's own name asked for no model, so its family's lead model answers
export function modelFor(lead: NamedModel, asked: string): Model {
  return isOwnName(asked) ? lead : model(`${familyOf(lead.name)}/${asked}`);
}
