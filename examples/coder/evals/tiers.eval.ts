import { describe, expect, test } from "bun:test";
import { typesafe } from "@mottyjs/adapters/typesafe";
import { fake, on, run } from "@mottyjs/test";
import { gpt, haiku, mini, opus, sonnet } from "../src/models";
import { tiers } from "../src/modules/tiers";

const { TYPESAFE_KEY } = process.env;

// The choice is the part that varies, so the decision model is real and the answers are faked
describe.skipIf(!TYPESAFE_KEY)("tier choice by the real decision model", () => {
  test("a concurrency bug across services goes to the deep tier 9 times in 10", async () => {
    const answers = fake(
      on(mini, "quick reply"),
      on(haiku, "quick reply"),
      on(sonnet, "plan or standard reply"),
      on(gpt, "standard reply"),
      on(opus, "deep reply"),
    );
    const decisions = typesafe({ key: TYPESAFE_KEY });
    const text = [
      "Two workers each take a row lock on the orders table and then wait on the other's row in",
      "the inventory table. It only happens under load, about once in ten thousand requests, and",
      "the Postgres log shows a deadlock detected error with both transactions rolled back. The",
      "code path goes through three services and a retry wrapper that re-enters the transaction.",
      "Explain why this deadlocks, and how to restructure the locking order so it cannot.",
    ].join(" ");

    const runs = await Promise.all(
      Array.from({ length: 20 }, () => run(tiers, { text }, { models: [answers, decisions] })),
    );

    expect(runs.filter(({ route }) => route === "deep").length).toBeGreaterThanOrEqual(18);
  });
});
