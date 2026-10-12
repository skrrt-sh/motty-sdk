import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { openai } from "@mottyjs/adapters/openai";
import { memory } from "@mottyjs/test";
import fleet from "./motty";
import { price } from "./price";
import { budgetFrom } from "./settings";

// The board lives in this process and is empty again after a restart, which suits a demo
export default serve(fleet, ({ ANTHROPIC_KEY, OPENAI_KEY, SCOUTS, BUDGET }) => ({
  models: [anthropic({ key: ANTHROPIC_KEY }), openai({ key: OPENAI_KEY })],
  storage: memory(),
  settings: {
    fleet: { scouts: SCOUTS === "asked" ? "asked" : "small", budget: budgetFrom(BUDGET) },
  },
  limits: { duration: 300_000, calls: 2 },
  price,
  report: (record) => console.log(JSON.stringify(record)),
}));
