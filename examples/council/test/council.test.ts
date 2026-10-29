import { describe, expect, test } from "bun:test";
import {
  answer,
  Forbidden,
  QuotaExceeded,
  Unsupported,
  UpstreamFailed,
} from "@mottyjs/core";
import { fake, memory, on, run } from "@mottyjs/test";
import { flash, haiku, nano, oss, sonnet } from "../src/models";
import { panel } from "../src/modules/panel";
import council from "../src/motty";

describe("verdict", () => {
  test("a panel that agrees is merged by the chair at once", async () => {
    const models = fake(
      on(haiku, "Canberra"),
      on(nano, "It is Canberra"),
      on(oss, "Canberra, I think"),
      on(flash, "Canberra, I think"),
      on(sonnet, { agreed: true, disputed: [] }),
      on(sonnet, "The capital is Canberra."),
    );

    const { path, answer } = await run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models] },
    );

    expect(path).toEqual(["merge"]);
    expect(await answer.text()).toBe("The capital is Canberra.");
    expect(models.sent(haiku)).toHaveLength(1);
    expect(models.sent(sonnet)[1]?.messages.at(-1)?.text).toContain(
      "Panelist 1:\nCanberra\n\nPanelist 2:\nIt is Canberra\n\nPanelist 3:\nCanberra, I think",
    );
  });

  test("a panel that disagrees answers again after reading each other", async () => {
    const models = fake(
      on(haiku, "Sydney"),
      on(haiku, "Canberra, on reflection"),
      on(nano, "Canberra"),
      on(oss, "Melbourne"),
      on(flash, "Melbourne"),
      on(sonnet, { agreed: false, disputed: ["Which city is the capital"] }),
      on(sonnet, "The capital is Canberra."),
    );

    const { path, answer } = await run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models] },
    );

    expect(path).toEqual(["debate"]);
    expect(await answer.text()).toBe("The capital is Canberra.");
    const rebuttal = models.sent(haiku)[1]?.messages.at(-1)?.text;
    expect(rebuttal).toContain("Panelist 2:\nCanberra");
    expect(rebuttal).toContain("Panelist 3:\nMelbourne");
    expect(rebuttal).toContain("Which city is the capital");
    expect(models.sent(sonnet)[1]?.messages.at(-1)?.text).toContain(
      "Panelist 1:\nCanberra, on reflection",
    );
  });

  test("one round is all a host that sets one gets", async () => {
    const models = fake(
      on(haiku, "Sydney"),
      on(nano, "Canberra"),
      on(oss, "Melbourne"),
      on(flash, "Melbourne"),
      on(sonnet, { agreed: false, disputed: ["Which city is the capital"] }),
      on(sonnet, "The capital is Canberra."),
    );

    const { path } = await run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models], settings: { panel: { rounds: 1 } } },
    );

    expect(path).toEqual(["merge"]);
    expect(models.sent(haiku)).toHaveLength(1);
  });

  test("a second round that loses its panelists falls back to merging the first", async () => {
    const models = fake(
      on(haiku, "Sydney"),
      on(haiku, new Forbidden("no access")),
      on(nano, "Canberra"),
      on(nano, new Forbidden("no access")),
      on(oss, "Melbourne"),
      on(oss, new Forbidden("no access")),
      on(flash, "Melbourne"),
      on(sonnet, { agreed: false, disputed: ["Which city is the capital"] }),
      on(sonnet, "The capital is Canberra."),
    );

    const { path, answer } = await run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models] },
    );

    expect(path).toEqual(["merge"]);
    expect(await answer.text()).toBe("The capital is Canberra.");
    expect(models.sent(sonnet)[1]?.messages.at(-1)?.text).toContain("Panelist 1:\nSydney");
  });
});

describe("panel", () => {
  test("a panelist that fails is left out", async () => {
    const models = fake(
      on(haiku, new Forbidden("no access")),
      on(nano, new Forbidden("no access")),
      on(oss, "Canberra"),
      on(flash, "Canberra"),
    );

    const { answer: opinions } = await run(
      panel.handle(({ opinions }) => answer(opinions.join(" | "))),
      { text: "What is the capital of Australia?" },
      { models: [models] },
    );

    expect(await opinions.text()).toBe("Canberra | Canberra");
  });

  test("fewer than two panelists fail the request as an upstream failure", async () => {
    const models = fake(
      on(haiku, new Forbidden("no access")),
      on(nano, new Forbidden("no access")),
      on(oss, new Forbidden("no access")),
      on(flash, "Canberra"),
    );

    const asked = run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models] },
    );

    await expect(asked).rejects.toBeInstanceOf(UpstreamFailed);
    await expect(asked).rejects.toThrow("1 of 3 panelists answered, and a council needs 2");
  });

  test("a host may seat two panelists", async () => {
    const models = fake(on(haiku, "Canberra"), on(nano, "Canberra"));

    await run(
      panel.handle(({ opinions }) => answer(opinions.join(" | "))),
      { text: "What is the capital of Australia?" },
      { models: [models], settings: { panel: { seats: 2 } } },
    );

    expect(models.sent(oss)).toHaveLength(0);
  });
});

describe("seats", () => {
  test("a seat falls back to another provider's model", async () => {
    const models = fake(
      on(haiku, new Forbidden("no access")),
      on(nano, "From OpenAI"),
      on(oss, "From OpenRouter"),
      on(flash, "From OpenRouter"),
    );

    const { answer: opinions } = await run(
      panel.handle(({ opinions }) => answer(opinions.join(" | "))),
      { text: "What is the capital of Australia?" },
      { models: [models] },
    );

    expect(await opinions.text()).toBe("From OpenAI | From OpenAI | From OpenRouter");
  });

  test("the chair and the judge each fall back to another provider", async () => {
    const models = fake(
      on(haiku, "Canberra"),
      on(nano, "Canberra"),
      on(nano, { agreed: true, disputed: [] }),
      on(oss, "Canberra"),
      on(flash, "Canberra"),
      on(flash, "The capital is Canberra."),
      on(sonnet, new Forbidden("no access")),
    );

    const { answer } = await run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models] },
    );

    expect(await answer.text()).toBe("The capital is Canberra.");
    expect(models.sent(nano)[1]?.options).toEqual({
      provider: { anthropic: { thinking: { type: "between_tools" } }, openai: {} },
    });
  });

  test("panelists reason a little, the chair a lot, and the judge not at all", async () => {
    const models = fake(
      on(haiku, "Canberra"),
      on(nano, "Canberra"),
      on(oss, "Canberra"),
      on(flash, "Canberra"),
      on(sonnet, { agreed: true, disputed: [] }),
      on(sonnet, "The capital is Canberra."),
    );

    await run(council, { text: "What is the capital of Australia?" }, { models: [models] });

    const [judging, merging] = models.sent(sonnet);
    expect(models.sent(haiku)[0]?.options).toEqual({ reasoning: { effort: "low" } });
    expect(models.sent(flash)[0]?.options).toEqual({ reasoning: { effort: "low" } });
    expect(judging?.options).toEqual({
      provider: { anthropic: { thinking: { type: "between_tools" } }, openai: {} },
    });
    expect(merging?.options).toEqual({ reasoning: { effort: "high" } });
  });
});

describe("time limits", () => {
  test("a seat whose model is late with its first chunk goes on to another provider's", async () => {
    const models = fake(
      on(haiku, async () => {
        await Bun.sleep(100);
        return "Too late";
      }),
      on(nano, "From OpenAI"),
      on(oss, "From OpenRouter"),
      on(flash, "From OpenRouter"),
    );

    const { answer: opinions, calls } = await run(
      panel.handle(({ opinions }) => answer(opinions.join(" | "))),
      { text: "What is the capital of Australia?" },
      { models: [models], settings: { timeouts: { first: 20 } } },
    );

    expect(await opinions.text()).toBe("From OpenAI | From OpenAI | From OpenRouter");
    expect(calls.filter(({ model }) => model === haiku.name).map(({ code }) => code)).toEqual([
      "aborted",
      "aborted",
    ]);
  });
});

describe("progress", () => {
  test("the caller reads every panelist and the verdict before the answer", async () => {
    const models = fake(
      on(haiku, "Sydney"),
      on(nano, "Canberra"),
      on(oss, "Melbourne"),
      on(flash, "Melbourne"),
      on(sonnet, { agreed: false, disputed: ["Which city is the capital"] }),
      on(sonnet, "The capital is Canberra."),
    );

    const { thoughts } = await run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models], settings: { panel: { rounds: 1 } } },
    );

    expect(thoughts.slice(0, 3).toSorted()).toEqual(["Canberra", "Melbourne", "Sydney"]);
    expect(thoughts.at(3)).toBe("The panel disagrees on: Which city is the capital");
    expect(thoughts).toHaveLength(4);
  });
});

describe("spend", () => {
  test("a request already over its limit answers without a second round", async () => {
    const models = fake(
      on(haiku, [
        { type: "text", text: "Sydney" },
        { type: "finish", reason: "stop", usage: { input: 40, output: 20 } },
      ]),
      on(nano, "Canberra"),
      on(oss, "Melbourne"),
      on(flash, "Melbourne"),
      on(sonnet, { agreed: false, disputed: ["Which city is the capital"] }),
      on(sonnet, "The capital is Canberra."),
    );

    const { path, thoughts } = await run(
      council,
      { text: "What is the capital of Australia?" },
      {
        models: [models],
        settings: { spend: { requestUsd: 0.1 } },
        price: (_model, { output = 0 }) => output / 100,
      },
    );

    expect(path).toEqual(["merge"]);
    expect(models.sent(haiku)).toHaveLength(1);
    expect(thoughts.at(-1)).toBe("$0.2 of $0.1 is spent: answering without a second round");
  });

  test("what a request cost at the host's price is added to its caller's day", async () => {
    const models = fake(
      on(haiku, [
        { type: "text", text: "Canberra" },
        { type: "finish", reason: "stop", usage: { input: 1000, output: 500 } },
      ]),
      on(nano, "Canberra"),
      on(oss, "Canberra"),
      on(flash, "Canberra"),
      on(sonnet, ({ output }) =>
        output ? { agreed: true, disputed: [] } : "The capital is Canberra.",
      ),
    );
    const storage = memory();
    await run(
      council,
      { text: "What is the capital of Australia?" },
      {
        models: [models],
        storage,
        price: (_model, { input = 0, output = 0 }) => (input + 3 * output) / 10_000,
      },
    );

    await run(
      council,
      { text: "What is the capital of Australia?" },
      {
        models: [models],
        storage,
        price: (_model, { input = 0, output = 0 }) => (input + 3 * output) / 10_000,
      },
    );

    expect(
      await storage.get(`council:spend:tester:${new Date().toISOString().slice(0, 10)}`),
    ).toBe(0.5);
  });

  test("two requests of one caller that end together both add what they cost", async () => {
    const models = fake(
      on(haiku, [
        { type: "text", text: "Canberra" },
        { type: "finish", reason: "stop", usage: { output: 25 } },
      ]),
      on(nano, "Canberra"),
      on(oss, "Canberra"),
      on(flash, "Canberra"),
      on(sonnet, ({ output }) =>
        output ? { agreed: true, disputed: [] } : "The capital is Canberra.",
      ),
    );
    const storage = memory();

    await Promise.all([
      run(
        council,
        { text: "What is the capital of Australia?" },
        { models: [models], storage, price: (_model, { output = 0 }) => output / 100 },
      ),
      run(
        council,
        { text: "And what is the capital of Austria?" },
        { models: [models], storage, price: (_model, { output = 0 }) => output / 100 },
      ),
    ]);

    expect(
      await storage.get(`council:spend:tester:${new Date().toISOString().slice(0, 10)}`),
    ).toBe(0.5);
  });

  test("a caller over the daily limit is refused before any model is called", async () => {
    const models = fake(
      on(haiku, [
        { type: "text", text: "Canberra" },
        { type: "finish", reason: "stop", usage: { output: 300 } },
      ]),
      on(nano, "Canberra"),
      on(oss, "Canberra"),
      on(flash, "Canberra"),
      on(sonnet, { agreed: true, disputed: [] }),
      on(sonnet, "The capital is Canberra."),
    );
    const storage = memory();
    await run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models], storage, price: (_model, { output = 0 }) => output / 100 },
    );

    const asked = run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models], storage, price: (_model, { output = 0 }) => output / 100 },
    );

    await expect(asked).rejects.toBeInstanceOf(QuotaExceeded);
    expect(models.sent(haiku)).toHaveLength(1);
  });

  test("a request that failed still adds what it spent", async () => {
    const models = fake(
      on(haiku, new Forbidden("no access")),
      on(nano, new Forbidden("no access")),
      on(oss, new Forbidden("no access")),
      on(flash, [
        { type: "text", text: "Canberra" },
        { type: "finish", reason: "stop", usage: { output: 1 } },
      ]),
    );
    const storage = memory();

    const asked = run(
      council,
      { text: "What is the capital of Australia?" },
      { models: [models], storage, price: (_model, { output = 0 }) => output / 100 },
    );

    await expect(asked).rejects.toBeInstanceOf(UpstreamFailed);
    expect(
      await storage.get(`council:spend:tester:${new Date().toISOString().slice(0, 10)}`),
    ).toBe(0.01);
  });
});

describe("gates", () => {
  test.each([
    ["as text", { text: "Hello!" }],
    [
      "as parts, as the Responses and Messages APIs send it",
      { messages: [{ role: "user", parts: [{ type: "text", text: "Hello!" }] }] },
    ],
  ] satisfies [string, Parameters<typeof run>[1]][])(
    "a greeting sent %s is answered by hand, with no council and no route",
    async (_, request) => {
      const { route, answer, calls } = await run(council, request);

      expect(route).toBeUndefined();
      expect(await answer.text()).toBe(
        "Hello. Ask me something hard and I will put it to the council.",
      );
      expect(calls).toEqual([]);
    },
  );

  test("a request with tools is refused", async () => {
    const asked = run(council, {
      text: "What is the capital of Australia?",
      tools: [{ type: "function", name: "lookup", input: { type: "object" } }],
    });

    await expect(asked).rejects.toBeInstanceOf(Unsupported);
  });
});
