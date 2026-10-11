import { describe, expect, test } from "bun:test";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { openai } from "@mottyjs/adapters/openai";
import { openrouter } from "@mottyjs/adapters/openrouter";
import { answer } from "@mottyjs/core";
import { fake, on, run } from "@mottyjs/test";
import { flash, haiku, nano, oss } from "../src/models";
import { verdict } from "../src/modules/verdict";
import council from "../src/motty";

const { OPENAI_KEY, ANTHROPIC_KEY, OPENROUTER_KEY } = process.env;

describe.skipIf(!OPENAI_KEY || !ANTHROPIC_KEY || !OPENROUTER_KEY)(
  "the council on real models of three providers",
  () => {
    test("a question with one right answer is answered right, and the caller watched the panel", async () => {
      const { answer, calls, thoughts } = await run(
        council,
        {
          text: "Which planet of the solar system has the shortest year? One sentence.",
          options: { maxTokens: 800 },
        },
        {
          models: [
            openai({ key: OPENAI_KEY }),
            anthropic({ key: ANTHROPIC_KEY }),
            openrouter({ key: OPENROUTER_KEY }),
          ],
        },
      );

      const answered = calls.filter(({ code }) => code === undefined);
      expect(await answer.text()).toMatch(/Mercury/);
      expect(new Set(answered.map(({ model }) => model.split("/")[0]))).toEqual(
        new Set(["anthropic", "openai", "openrouter"]),
      );
      expect(thoughts.filter((thought) => /Mercury/.test(thought)).length).toBeGreaterThanOrEqual(2);
      expect(answered.some(({ cost = 0 }) => cost > 0)).toBe(true);
    }, 120_000);
  },
);

// The verdict is the part that varies, so the judge is real and the panel is faked
describe.skipIf(!ANTHROPIC_KEY)("the verdict of the real judge", () => {
  test("answers that contradict each other are found disputed 4 times in 5", async () => {
    const panel = fake(
      on(haiku, "Yes. Light always travels at the same speed, in any medium."),
      on(nano, "No. Light slows down in glass and water; only in a vacuum is its speed fixed."),
      on(oss, "No. Its speed depends on the medium it passes through."),
      on(flash, "No. Its speed depends on the medium it passes through."),
    );

    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(
          verdict.handle(({ verdict }) => answer(verdict.agreed ? "agreed" : "disputed")),
          { text: "Does light always travel at the same speed?" },
          { models: [panel, anthropic({ key: ANTHROPIC_KEY })] },
        ),
      ),
    );

    const verdicts = await Promise.all(runs.map(({ answer }) => answer.text()));
    expect(verdicts.filter((said) => said === "disputed").length).toBeGreaterThanOrEqual(4);
  }, 60_000);

  test("answers that say one thing in other words are found agreed 4 times in 5", async () => {
    const panel = fake(
      on(haiku, "No. It is slower in glass or water than in a vacuum."),
      on(nano, "No. Light slows down in a medium; only in a vacuum is its speed fixed."),
      on(oss, "No. Its speed depends on the medium it passes through."),
      on(flash, "No. Its speed depends on the medium it passes through."),
    );

    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(
          verdict.handle(({ verdict }) => answer(verdict.agreed ? "agreed" : "disputed")),
          { text: "Does light always travel at the same speed?" },
          { models: [panel, anthropic({ key: ANTHROPIC_KEY })] },
        ),
      ),
    );

    const verdicts = await Promise.all(runs.map(({ answer }) => answer.text()));
    expect(verdicts.filter((said) => said === "agreed").length).toBeGreaterThanOrEqual(4);
  }, 60_000);
});
