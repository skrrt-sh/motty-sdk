import { motty } from "@mottyjs/core";
import { auth } from "@mottyjs/auth";
import { compaction } from "./middleware/compaction";
import { emptyPrompt } from "./middleware/empty-prompt";
import { hiddenReasoning } from "./middleware/hidden-reasoning";
import { offTopic } from "./middleware/off-topic";
import { structured } from "./modules/structured";
import { tiers } from "./modules/tiers";

export default motty({ name: "coder" })
  .use(auth())
  .use(emptyPrompt)
  .use(offTopic)
  .use(compaction)
  .use(hiddenReasoning)
  // A request for JSON is not a coding task, so it never reaches the tier choice
  .route(({ request }) => (request.output ? "structured" : "chat"), {
    structured,
    chat: tiers,
  });
