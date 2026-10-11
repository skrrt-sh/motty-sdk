import { motty, reroute } from "@mottyjs/core";
import { tuning } from "../../settings";
import { small, strong } from "./answer";
import { sizeOf } from "./choose";

export const structured = motty({ name: "structured" })
  .use(tuning)
  .route(({ request, settings }) => sizeOf(request, settings.structured), {
    // A slower reply costs the caller less than one its parser rejects
    small: ({ prompt }) => small(prompt).catch(() => reroute("strong")),
    strong: ({ prompt }) => strong(prompt),
  });
