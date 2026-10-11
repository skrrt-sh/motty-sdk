import { describe, expect, test } from "bun:test";
import { openrouter } from "@mottyjs/adapters/openrouter";
import { fake, on, run } from "@mottyjs/test";
import { jev } from "../src/models";
import desk from "../src/motty";

const { OPENROUTER_KEY } = process.env;

// Reading the picture is the part that varies, so the reader is real and the triage is faked.
// The picture is 64 by 64 pixels, its left half red and its right half blue
describe.skipIf(!OPENROUTER_KEY)("an attachment read by the real reader", () => {
  test("the two colours of a picture are named 4 times in 5", async () => {
    const triage = fake(on(jev, { abuse: 0.01, category: { other: 1 }, urgency: 0 }));
    const readers = openrouter({ key: OPENROUTER_KEY });

    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(
          desk,
          {
            options: { maxTokens: 60 },
            messages: [
              {
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: "My notebook cover looks like this now. Which two colours is it?",
                  },
                  {
                    type: "image",
                    mediaType: "image/png",
                    data: [
                      "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAfUlEQVR4nO3aSwoAMAxCQe9/",
                      "aXMKF4GBrgOlnxh9aTJd4/Jdl7cBJ+AKecR+Id+oRqYTkxLEHDVKThtoTGRGSkM9V4Ktwtji",
                      "zLEWmbvcafa6gENCI2IS8kkpxayCbkk91ADsgVaB2wCeEFuQM9AfahF2CXxF7kKPwd/5T68f",
                      "uOzw4mlC0SMAAAAASUVORK5CYII=",
                    ].join(""),
                  },
                ],
              },
            ],
          },
          { models: [triage, readers] },
        ),
      ),
    );

    const said = await Promise.all(runs.map(({ answer }) => answer.text()));
    expect(
      said.filter((text) => /red/i.test(text) && /blue/i.test(text)).length,
    ).toBeGreaterThanOrEqual(4);
    expect(runs.map(({ path }) => path)).toEqual(Array(5).fill(["conversation", "attachment"]));
  });
});
