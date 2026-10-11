import { motty, Unsupported } from "@mottyjs/core";

// Several answers merge into prose, never into one tool call or one object of a caller's schema
export const proseOnly = motty({ name: "prose-only" }).beforeHandle(({ request }) => {
  if (request.tools.length > 0 || request.output) {
    throw new Unsupported("The council answers in prose: it calls no tools and fills no schema");
  }
});
