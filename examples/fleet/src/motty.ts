import { motty } from "@mottyjs/core";
import { brake } from "./middleware/brake";
import { ledger } from "./middleware/ledger";
import { seat } from "./middleware/seat";
import { name } from "./models";
import { asked } from "./modules/asked";
import { board } from "./modules/board";
import { scout } from "./modules/scout";
import { tuning } from "./settings";

export default motty({ name })
  .use(tuning)
  .use(seat)
  .use(ledger)
  .use(brake)
  .route(
    ({ family, seat, settings }) => {
      // An agent says which one it is on every request, so one that does not is someone asking about the fleet
      if (family === undefined) return "board";
      return seat !== "lead" && settings.fleet.scouts === "small" ? "scout" : "asked";
    },
    { board, scout, asked },
  );
