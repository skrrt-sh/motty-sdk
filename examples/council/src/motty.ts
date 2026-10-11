import { motty, reroute } from "@mottyjs/core";
import { auth } from "@mottyjs/auth";
import { dailyLimit } from "./middleware/daily-limit";
import { greeting } from "./middleware/greeting";
import { proseOnly } from "./middleware/prose-only";
import { debate } from "./modules/debate";
import { merge } from "./modules/merge";
import { panel } from "./modules/panel";
import { verdict } from "./modules/verdict";
import { stageAfter } from "./modules/verdict/next";
import { tuning } from "./settings";

export default motty({ name: "council" })
  .use(auth())
  .use(tuning)
  .use(proseOnly)
  .use(greeting)
  .use(dailyLimit)
  .use(panel)
  .use(verdict)
  .route(({ verdict, calls, settings }) => stageAfter(verdict.agreed, calls.total, settings), {
    merge,
    // A second round that lost its panelists is no reason to fail what the first can answer
    debate: debate.catch(() => reroute("merge")),
  });
