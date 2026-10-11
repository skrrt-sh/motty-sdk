import { describe, expect, test } from "bun:test";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { openai } from "@mottyjs/adapters/openai";
import { run } from "@mottyjs/test";
import { Ticket } from "../src/modules/ticket/fill";
import desk from "../src/motty";

const { OPENAI_KEY, ANTHROPIC_KEY } = process.env;

describe.skipIf(!OPENAI_KEY || !ANTHROPIC_KEY)("tickets filed by the real clerks", () => {
  test("a double charge is filed as a ticket the schema accepts 5 times in 5", async () => {
    const clerks = [openai({ key: OPENAI_KEY }), anthropic({ key: ANTHROPIC_KEY })];

    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(
          desk,
          {
            text: "Order A-1042 was charged twice in May. I want one charge back today.",
            options: { maxTokens: 200 },
            output: { schema: { type: "object" } },
          },
          { models: clerks },
        ),
      ),
    );

    const tickets = await Promise.all(
      runs.map(async ({ answer }) => Ticket.safeParse(await answer.json())),
    );
    expect(tickets.filter(({ success }) => success)).toHaveLength(5);
    expect(
      tickets.filter(({ data }) => data?.orderNumber === "A-1042").length,
    ).toBeGreaterThanOrEqual(4);
  });
});
