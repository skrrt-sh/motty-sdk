import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { openai } from "@mottyjs/adapters/openai";
import { memory } from "@mottyjs/test";
import fleet from "./motty";
import { price } from "./price";

// The board lives in this process and is empty again after a restart, which suits a demo
export const host = ({ ANTHROPIC_KEY, OPENAI_KEY, SCOUTS, BUDGET }: typeof process.env) => ({
  models: [anthropic({ key: ANTHROPIC_KEY }), openai({ key: OPENAI_KEY })],
  storage: memory(),
  settings: {
    fleet: { scouts: SCOUTS === "asked" ? "asked" : "small", budget: Number(BUDGET ?? 1) },
  } as const,
  limits: { duration: 300_000, calls: 2 },
  price,
  report: (record: unknown) => console.log(JSON.stringify(record)),
});

export default serve(fleet, host);
