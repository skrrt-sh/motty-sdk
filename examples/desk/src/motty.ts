import { motty } from "@mottyjs/core";
import { auth } from "@mottyjs/auth";
import { cardNumbers } from "./middleware/card-numbers";
import { emptyMessage } from "./middleware/empty-message";
import { policy } from "./middleware/policy";
import { cases } from "./modules/cases";
import { ticket } from "./modules/ticket";

export default motty({ name: "desk" })
  .use(auth())
  .use(emptyMessage)
  .use(policy({ ttl: "1h" }))
  .use(cardNumbers)
  // A request for JSON files a ticket: it is read, not answered, so it is never triaged
  .route(({ request }) => (request.output ? "ticket" : "conversation"), {
    ticket,
    conversation: cases,
  });
