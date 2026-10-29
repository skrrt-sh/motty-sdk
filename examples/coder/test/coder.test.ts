import { describe, expect, test } from "bun:test";
import { Overloaded, type Message } from "@mottyjs/core";
import { fake, memory, on, run } from "@mottyjs/test";
import { EmptyPrompt } from "../src/middleware/empty-prompt";
import { gpt, haiku, jev, mini, opus, sonnet } from "../src/models";
import { structured } from "../src/modules/structured";
import { tiers } from "../src/modules/tiers";
import coder from "../src/motty";

describe("tiers", () => {
  test("a short question without tools goes to the quick tier", async () => {
    const models = fake(
      on(mini, "quick reply"),
      on(haiku, "quick reply"),
    );

    const { route, answer } = await run(
      tiers,
      { text: "What does git stash do?" },
      { models: [models] },
    );

    expect(route).toBe("quick");
    expect(await answer.text()).toBe("quick reply");
  });

  test("a :max model name goes to the deep tier", async () => {
    const models = fake(
      on(sonnet, "plan"),
      on(opus, "deep reply"),
    );

    const { route, answer } = await run(
      tiers,
      { model: "acme/coder:max", text: "What does git stash do?" },
      { models: [models] },
    );

    expect(route).toBe("deep");
    expect(await answer.text()).toBe("deep reply");
  });

  test("a question that is not obvious goes where the decision model leans", async () => {
    const models = fake(
      on(jev, { tier: { quick: 0.05, standard: 0.5, deep: 0.45 } }),
      on(sonnet, "plan"),
      on(opus, "deep reply"),
    );

    const { route } = await run(
      tiers,
      { text: "Why does this deadlock? ".repeat(40) },
      { models: [models] },
    );

    expect(route).toBe("deep");
  });

  test("the deep tier asks for high reasoning effort", async () => {
    const models = fake(
      on(sonnet, "plan"),
      on(opus, "deep reply"),
    );

    await run(
      tiers,
      { model: "acme/coder:max", text: "What does git stash do?" },
      { models: [models] },
    );

    const [prompt] = models.sent(opus);
    expect(prompt?.options).toMatchObject({ reasoning: { effort: "high" } });
  });

  test("the quick tier reroutes to standard when both small models are down", async () => {
    const models = fake(
      on(mini, new Overloaded("busy")),
      on(haiku, new Overloaded("busy")),
      on(sonnet, "standard reply"),
    );

    const { route, answer } = await run(
      tiers,
      { text: "What does git stash do?" },
      { models: [models] },
    );

    expect(route).toBe("standard");
    expect(await answer.text()).toBe("standard reply");
  });

  test("the deep tier reroutes to standard when both strong models are down", async () => {
    const models = fake(
      on(sonnet, "plan"),
      on(sonnet, "standard reply"),
      on(opus, new Overloaded("busy")),
      on(gpt, new Overloaded("busy")),
    );

    const { route, answer } = await run(
      tiers,
      { model: "acme/coder:max", text: "Why does this deadlock?" },
      { models: [models] },
    );

    expect(route).toBe("standard");
    expect(await answer.text()).toBe("standard reply");
  });

  test("the deep tier plans first, and the caller reads the plan as reasoning", async () => {
    const models = fake(
      on(sonnet, "1. Find the lock order"),
      on(opus, "deep reply"),
    );

    const { thoughts } = await run(
      tiers,
      { model: "acme/coder:max", text: "Why does this deadlock?" },
      { models: [models] },
    );

    expect(thoughts).toEqual(["Answering with the deep tier", "1. Find the lock order"]);
    expect(models.sent(opus)[0]?.messages.at(-1)?.text).toContain("1. Find the lock order");
  });

  test("the deep tier answers without a plan when the planning model is down", async () => {
    const models = fake(
      on(sonnet, new Overloaded("busy")),
      on(opus, "deep reply"),
    );

    const { answer, thoughts } = await run(
      tiers,
      { model: "acme/coder:max", text: "Why does this deadlock?" },
      { models: [models] },
    );

    expect(thoughts).toEqual(["Answering with the deep tier"]);
    expect(await answer.text()).toBe("deep reply");
  });

  test("a conversation stays on the strongest tier it reached", async () => {
    const models = fake(
      on(sonnet, "plan"),
      on(opus, "deep reply"),
    );
    const storage = memory();
    const headers = { "x-conversation-id": "c1" };
    await run(
      tiers,
      { model: "acme/coder:max", text: "Why does this deadlock?", headers },
      { models: [models], storage },
    );

    const { route } = await run(
      tiers,
      { text: "What does git stash do?", headers },
      { models: [models], storage },
    );

    expect(route).toBe("deep");
  });

  test("the question is the agent's last text, past its notes and a tool's result, for its length and for the decision model", async () => {
    const models = fake(
      on(jev, { tier: { quick: 0.05, standard: 0.5, deep: 0.45 } }),
      on(sonnet, "plan"),
      on(opus, "deep reply"),
    );

    const { route } = await run(
      tiers,
      {
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "<reminder>Use the repo's style</reminder>" },
              { type: "text", text: "Why does this deadlock? ".repeat(40) },
            ],
          },
          { role: "assistant", parts: [{ type: "tool_call", id: "t1", name: "read", input: {} }] },
          { role: "user", parts: [{ type: "tool_result", id: "t1", text: "fn main() {}" }] },
        ],
      },
      { models: [models] },
    );

    expect(route).toBe("deep");
    expect(models.sent(jev)).toMatchObject([{ state: "Why does this deadlock? ".repeat(40) }]);
  });
});

describe("structured", () => {
  test("JSON a small model can fill is asked of the small model", async () => {
    const models = fake(on(jev, { small: 0.9 }), on(mini, { files: ["parser.ts"] }));

    const { route, answer } = await run(
      structured,
      { text: "Which files did we touch?", output: { schema: { type: "object" } } },
      { models: [models] },
    );

    expect(route).toBe("small");
    expect(await answer.json()).toEqual({ files: ["parser.ts"] });
  });

  test("JSON that needs reasoning goes to the strong model", async () => {
    const models = fake(on(jev, { small: 0.2 }), on(sonnet, { files: ["parser.ts"] }));

    const { route } = await run(
      structured,
      { text: "Which files did we touch?", output: { schema: { type: "object" } } },
      { models: [models] },
    );

    expect(route).toBe("strong");
  });

  test("a small reply that is not JSON is answered again by the strong model", async () => {
    const models = fake(
      on(jev, { small: 0.9 }),
      on(mini, "Here are the files"),
      on(sonnet, { files: ["parser.ts"] }),
    );

    const { route, answer } = await run(
      structured,
      { text: "Which files did we touch?", output: { schema: { type: "object" } } },
      { models: [models] },
    );

    expect(route).toBe("strong");
    expect(await answer.json()).toEqual({ files: ["parser.ts"] });
  });

  test("the strong model answers when the decision model is down", async () => {
    const models = fake(on(jev, new Overloaded("busy")), on(sonnet, { files: ["parser.ts"] }));

    const { route } = await run(
      structured,
      { text: "Which files did we touch?", output: { schema: { type: "object" } } },
      { models: [models] },
    );

    expect(route).toBe("strong");
  });

  test("the decision model reads the question sent as parts beside the schema", async () => {
    const models = fake(on(jev, { small: 0.9 }), on(mini, { files: ["parser.ts"] }));

    await run(
      structured,
      {
        messages: [{ role: "user", parts: [{ type: "text", text: "Which files did we touch?" }] }],
        output: { schema: { type: "object" } },
      },
      { models: [models] },
    );

    expect(models.sent(jev)).toMatchObject([
      { state: { schema: { schema: { type: "object" } }, question: "Which files did we touch?" } },
    ]);
  });
});

describe("request kind", () => {
  test("a request for JSON skips the tiers", async () => {
    const models = fake(
      on(jev, { software: 0.97, small: 0.9 }),
      on(mini, { files: ["parser.ts"] }),
    );

    const { path } = await run(
      coder,
      { text: "Which files did the parser fix touch?", output: { schema: { type: "object" } } },
      { models: [models] },
    );

    expect(path).toEqual(["structured", "small"]);
  });
});

describe("gates", () => {
  test("an empty prompt is rejected", async () => {
    await expect(run(coder, { messages: [] })).rejects.toBeInstanceOf(EmptyPrompt);
  });

  test.each([
    ["as text", { text: "What should I cook tonight?" }],
    [
      "as parts, as the Responses and Messages APIs send it",
      { messages: [{ role: "user", parts: [{ type: "text", text: "What should I cook tonight?" }] }] },
    ],
  ] satisfies [string, Parameters<typeof run>[1]][])(
    "an off-topic opening sent %s gets a canned reply and no route",
    async (_, request) => {
      const models = fake(on(jev, { software: 0.02 }));

      const { route, answer } = await run(coder, request, { models: [models] });

      expect(route).toBeUndefined();
      expect(await answer.text()).toBe("I only answer questions about software and codebases.");
      expect(models.sent(jev)).toMatchObject([{ state: "What should I cook tonight?" }]);
    },
  );

  test("requests pass when the decision model is down", async () => {
    const models = fake(
      on(jev, new Overloaded("busy")),
      on(mini, "quick reply"),
      on(haiku, "quick reply"),
    );

    const { answer } = await run(
      coder,
      { text: "What does git stash do?" },
      { models: [models] },
    );

    expect(await answer.text()).toBe("quick reply");
  });
});

describe("prompt and answer", () => {
  test("a long thread is sent upstream as a summary and its last turns", async () => {
    const models = fake(
      on(mini, { summary: "Fixed the parser", files: ["parser.ts"], decisions: ["keep the AST"] }),
      on(mini, "quick reply"),
      on(haiku, "quick reply"),
    );
    const messages = Array.from(
      { length: 90 },
      (_, turn): Message => ({
        role: turn % 2 === 0 ? "user" : "assistant",
        text: `turn ${turn}`,
      }),
    );

    await run(coder, { messages }, { models: [models] });

    const [prompt] = models.sent(haiku);
    expect(prompt?.messages).toHaveLength(13);
    expect(prompt?.messages[0]?.text).toContain("Fixed the parser");
  });

  test("the answering model's reasoning is not sent to the caller", async () => {
    const models = fake(
      on(jev, { software: 0.97 }),
      on(sonnet, "plan"),
      on(opus, [
        { type: "reasoning", text: "The lock order differs" },
        { type: "text", text: "deep reply" },
      ]),
    );

    const { answer } = await run(
      coder,
      { model: "acme/coder:max", text: "Why does this deadlock?" },
      { models: [models] },
    );

    const chunks = await Array.fromAsync(answer.chunks());
    expect(chunks.map((chunk) => chunk.type)).not.toContain("reasoning");
    expect(await answer.text()).toBe("deep reply");
  });
});
