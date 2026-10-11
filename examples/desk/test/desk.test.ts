import { describe, expect, test } from "bun:test";
import {
  Blocked,
  ContextTooLong,
  Overloaded,
  RateLimited,
  TimedOut,
  Unsupported,
  type Message,
  type Part,
} from "@mottyjs/core";
import type { Report } from "@mottyjs/core/host";
import { fake, memory, on, run } from "@mottyjs/test";
import { gemini, haiku, jev, nano, oss, sonnet } from "../src/models";
import desk from "../src/motty";

describe("early answers", () => {
  test.each([
    ["no messages", []],
    ["a blank message", [{ role: "user", text: "  \n" }]],
  ] satisfies [string, Message[]][])(
    "%s is asked again, and no model is called",
    async (_, messages) => {
      const { route, answer, calls } = await run(desk, { messages });

      expect(route).toBeUndefined();
      expect(await answer.text()).toBe(
        "I did not get a message. Tell me what happened and I will help.",
      );
      expect(calls).toEqual([]);
    },
  );

  test("abuse gets a canned reply, and no chat model reads it", async () => {
    const models = fake(on(jev, { abuse: 0.97, category: { other: 1 }, urgency: 0 }));

    const { path, answer, calls } = await run(
      desk,
      { text: "You useless idiots, I know where your office is." },
      { models: [models] },
    );

    expect(path).toEqual(["conversation"]);
    expect(await answer.text()).toContain("I can't help while the conversation is like this.");
    expect(calls.map((call) => call.model)).toEqual([jev.name]);
  });

  test("abuse is answered before the route, so the hook that remembers a case is not reached", async () => {
    const reported = Promise.withResolvers<Report>();
    const models = fake(on(jev, { abuse: 0.97, category: { other: 1 }, urgency: 0 }));

    await run(
      desk,
      { text: "You useless idiots, I know where your office is." },
      { models: [models], report: reported.resolve },
    );

    expect((await reported.promise).afterResponse).toEqual({
      failed: [],
      skipped: [],
      unreached: ["cases"],
    });
  });
});

describe("routes", () => {
  test("a plain question goes to the small model", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 0.9, dispute: 0.1 }, urgency: 0 }),
      on(nano, "Plus is 12 USD a month."),
    );

    const { path, answer } = await run(desk, { text: "How much is Plus?" }, { models: [models] });

    expect(path).toEqual(["conversation", "standard"]);
    expect(await answer.text()).toBe("Plus is 12 USD a month.");
  });

  test.each([
    ["a picture", { type: "image", url: "https://example.com/receipt.png" }],
    ["a PDF", { type: "file", mediaType: "application/pdf", data: "JVBERi0=" }],
  ] satisfies [string, Part][])("%s goes to a model that reads it", async (_, attachment) => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { dispute: 0.9 }, urgency: 3 }),
      on(gemini, "The receipt shows one charge."),
    );

    const { path, thoughts } = await run(
      desk,
      {
        messages: [
          { role: "user", parts: [{ type: "text", text: "Was I charged twice?" }, attachment] },
        ],
      },
      { models: [models] },
    );

    expect(path).toEqual(["conversation", "attachment"]);
    expect(thoughts).toEqual(["Reading your message", "Reading the attachment"]);
    expect(models.sent(gemini)[0]?.messages.at(-1)?.parts).toContainEqual(attachment);
  });

  test("a voice message is refused in the desk's own words", async () => {
    const models = fake(on(jev, { abuse: 0.01, category: { other: 1 }, urgency: 0 }));

    const asked = run(
      desk,
      {
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "Listen to this" },
              { type: "audio", mediaType: "audio/mp3", data: "SUQz" },
            ],
          },
        ],
      },
      { models: [models] },
    );

    await expect(asked).rejects.toBeInstanceOf(Unsupported);
    await expect(asked).rejects.toThrow("Send a voice message as text.");
  });

  test("a likely dispute goes to the strong model, though billing is likelier", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 0.6, dispute: 0.4 }, urgency: 1 }),
      on(sonnet, "Clause 2 applies."),
    );

    const { path, thoughts } = await run(
      desk,
      { text: "You charged me twice and I want it back." },
      { models: [models] },
    );

    expect(path).toEqual(["conversation", "escalated"]);
    expect(thoughts).toEqual([
      "Reading your message",
      "Escalated: dispute. Checking it against the policy",
    ]);
  });

  test("an urgent case is reasoned through at high effort, the caller's mute kept", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { technical: 1 }, urgency: 3 }),
      on(sonnet, "Clause 7 applies."),
    );

    const { path } = await run(
      desk,
      { text: "Sync is deleting my notes right now.", options: { reasoning: { exclude: true } } },
      { models: [models] },
    );

    const [prompt] = models.sent(sonnet);
    expect(path).toEqual(["conversation", "escalated"]);
    expect(prompt?.options).toMatchObject({ reasoning: { effort: "high", exclude: true } });
    expect(prompt?.messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
  });

  test("a request for JSON is filed as a ticket and never triaged", async () => {
    const models = fake(
      on(nano, {
        category: "dispute",
        urgency: "high",
        summary: "Charged twice for May",
        orderNumber: "A-1042",
        wants: "A refund of one charge",
      }),
    );

    const { path, answer, calls } = await run(
      desk,
      { text: "Order A-1042 was charged twice in May.", output: { schema: { type: "object" } } },
      { models: [models] },
    );

    expect(path).toEqual(["ticket"]);
    expect(await answer.json()).toMatchObject({ category: "dispute", orderNumber: "A-1042" });
    expect(calls.map((call) => call.model)).toEqual([nano.name]);
    expect(models.sent(nano)[0]?.output).toMatchObject({ name: "ticket", strict: true });
  });

  test("a ticket the schema refuses is filed again by the second clerk", async () => {
    const models = fake(
      on(nano, { category: "refund", summary: "Charged twice" }),
      on(haiku, {
        category: "dispute",
        urgency: "normal",
        summary: "Charged twice",
        orderNumber: null,
        wants: null,
      }),
    );

    const { answer } = await run(
      desk,
      { text: "I was charged twice.", output: { schema: { type: "object" } } },
      { models: [models] },
    );

    expect(await answer.json()).toMatchObject({ category: "dispute", urgency: "normal" });
  });
});

describe("triage", () => {
  test("a request is answered as an ordinary one when the decision model is down", async () => {
    const models = fake(on(jev, new Overloaded("busy")), on(nano, "Plus is 12 USD a month."));

    const { path, answer } = await run(
      desk,
      { text: "You useless idiots, how much is Plus?" },
      { models: [models] },
    );

    expect(path).toEqual(["conversation", "standard"]);
    expect(await answer.text()).toBe("Plus is 12 USD a month.");
  });
});

describe("the caller's tools", () => {
  test("tools and the tool choice go upstream, and the call comes back as one", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 1 }, urgency: 0 }),
      on(nano, [
        { type: "tool_call", id: "call_1", name: "find_order", arguments: '{"order":"A-1042"}' },
        { type: "finish", reason: "tool_calls" },
      ]),
    );

    const { answer } = await run(
      desk,
      {
        text: "Where is the refund for order A-1042?",
        tools: [{ type: "function", name: "find_order", input: { type: "object" } }],
        options: { toolChoice: "required" },
      },
      { models: [models] },
    );

    const [prompt] = models.sent(nano);
    expect(prompt?.tools).toEqual([
      { type: "function", name: "find_order", input: { type: "object" } },
    ]);
    expect(prompt?.options).toEqual({ toolChoice: "required" });
    expect(await answer.finish()).toBe("tool_calls");
    expect(await Array.fromAsync(answer.chunks())).toEqual([
      { type: "tool_call", id: "call_1", name: "find_order", arguments: '{"order":"A-1042"}' },
    ]);
  });

  test("tool results go back to the family that made the call, untriaged", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 1 }, urgency: 0 }),
      on(haiku, [
        { type: "tool_call", id: "call_1", name: "find_order", arguments: '{"order":"A-1042"}' },
        { type: "finish", reason: "tool_calls" },
      ]),
      on(haiku, "It was refunded on 3 May."),
    );
    const storage = memory();
    const headers = { "x-conversation-id": "c1" };
    await run(
      desk,
      { text: "Where is the refund for order A-1042?", headers },
      { models: [models], storage, settings: { models: { frontline: "haiku" } } },
    );

    const { path, answer } = await run(
      desk,
      {
        headers,
        messages: [
          { role: "user", text: "Where is the refund for order A-1042?" },
          {
            role: "assistant",
            parts: [
              {
                type: "reasoning",
                text: "I need the order",
                provider: { anthropic: { signature: "s1" } },
              },
              { type: "tool_call", id: "call_1", name: "find_order", input: { order: "A-1042" } },
            ],
          },
          {
            role: "tool",
            parts: [{ type: "tool_result", id: "call_1", text: "Refunded on 3 May" }],
          },
        ],
      },
      { models: [models], storage },
    );

    expect(path).toEqual(["conversation", "standard"]);
    expect(await answer.text()).toBe("It was refunded on 3 May.");
    expect(models.sent(jev)).toHaveLength(1);
    expect(models.sent(nano)).toEqual([]);
    expect(models.sent(haiku)[1]?.messages[2]?.parts).toContainEqual({
      type: "reasoning",
      text: "I need the order",
      provider: { anthropic: { signature: "s1" } },
    });
  });

  test("a conversation whose family is down goes on with another, then remembered", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 1 }, urgency: 0 }),
      on(haiku, [
        { type: "tool_call", id: "call_1", name: "find_order", arguments: '{"order":"A-1042"}' },
        { type: "finish", reason: "tool_calls" },
      ]),
      on(haiku, new Overloaded("busy")),
      on(nano, "It was refunded on 3 May."),
    );
    const storage = memory();
    const headers = { "x-conversation-id": "c1" };
    await run(
      desk,
      { text: "Where is the refund for order A-1042?", headers },
      { models: [models], storage, settings: { models: { frontline: "haiku" } } },
    );
    await run(
      desk,
      {
        headers,
        messages: [
          { role: "user", text: "Where is the refund for order A-1042?" },
          {
            role: "assistant",
            parts: [
              { type: "tool_call", id: "call_1", name: "find_order", input: { order: "A-1042" } },
            ],
          },
          {
            role: "tool",
            parts: [{ type: "tool_result", id: "call_1", text: "Refunded on 3 May" }],
          },
        ],
      },
      { models: [models], storage },
    );

    await run(
      desk,
      { text: "Thanks. And when does it arrive?", headers },
      { models: [models], storage },
    );

    expect(
      models
        .sent(nano)[0]
        ?.messages.slice(-2)
        .map((message) => message.role),
    ).toEqual(["assistant", "tool"]);
    expect(models.sent(haiku)).toHaveLength(2);
    expect(models.sent(nano)).toHaveLength(2);
    expect(await storage.get("desk:case:c1")).toEqual({
      category: "billing",
      urgent: false,
      family: "openai",
    });
  });
});

describe("the policy", () => {
  test("it is sent first with a cache marker, and what was read from cache is kept", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 1 }, urgency: 0 }),
      on(nano, [
        { type: "text", text: "Plus is 12 USD a month." },
        { type: "finish", reason: "stop", usage: { input: 900, output: 9, cached: 800 } },
      ]),
    );
    const storage = memory();
    await run(desk, { text: "How much is Plus?" }, { models: [models], storage });

    await run(desk, { text: "And Team?" }, { models: [models], storage });

    expect(models.sent(nano)[1]?.messages[0]).toMatchObject({
      role: "system",
      cache: { ttl: "1h" },
    });
    expect(await storage.get("desk:policy:cache:read")).toBe(1600);
    expect(await storage.get("desk:policy:cache:written")).toBeUndefined();
  });
});

describe("resilience", () => {
  test("a conversation too long for the model is summarised and asked once more", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { technical: 1 }, urgency: 0 }),
      on(nano, new ContextTooLong("too many tokens")),
      on(nano, "The customer cannot sync on a second device."),
      on(nano, "Sign out on the old device first."),
      on(haiku, new ContextTooLong("too many tokens")),
    );

    const { path, answer, thoughts } = await run(
      desk,
      {
        messages: Array.from({ length: 21 }, (_, turn) => ({
          role: turn % 2 === 0 ? "user" : "assistant",
          text: `turn ${turn}`,
        })),
      },
      { models: [models] },
    );

    const again = models.sent(nano)[2]?.messages;
    expect(path).toEqual(["conversation", "standard"]);
    expect(await answer.text()).toBe("Sign out on the old device first.");
    expect(thoughts).toContain("This conversation is long: summarising its earlier part");
    expect(again).toHaveLength(11);
    expect(again?.[0]).toMatchObject({ cache: { ttl: "1h" } });
    expect(again?.[1]?.text).toContain("The customer cannot sync on a second device.");
  });

  test("a rate-limited strong model is tried again, then the other provider answers", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { dispute: 1 }, urgency: 0 }),
      on(sonnet, new RateLimited("slow down", { retryAfter: 1 })),
      on(oss, "Clause 2 applies."),
    );

    const { path, answer } = await run(
      desk,
      { text: "You charged me twice and I want it back." },
      { models: [models] },
    );

    expect(path).toEqual(["conversation", "escalated"]);
    expect(await answer.text()).toBe("Clause 2 applies.");
    expect(models.sent(sonnet)).toHaveLength(2);
  });

  test("both strong models busy sends the case to the standard path", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { dispute: 1 }, urgency: 0 }),
      on(sonnet, new RateLimited("slow down", { retryAfter: 1 })),
      on(oss, new Overloaded("busy")),
      on(nano, "Clause 2 applies."),
    );

    const { path, answer } = await run(
      desk,
      { text: "You charged me twice and I want it back." },
      { models: [models] },
    );

    expect(path).toEqual(["conversation", "standard"]);
    expect(await answer.text()).toBe("Clause 2 applies.");
    expect(models.sent(nano)[0]?.options).toEqual({});
  });

  test("a strong path failing by the request's own fault is not answered by a weaker", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { dispute: 1 }, urgency: 0 }),
      on(sonnet, new Blocked("content policy")),
      on(oss, new Blocked("content policy")),
    );

    const asked = run(
      desk,
      { text: "You charged me twice and I want it back." },
      { models: [models] },
    );

    await expect(asked).rejects.toBeInstanceOf(Blocked);
  });
});

describe("time limits", () => {
  test("a small model late with its first chunk gives way to the other", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 1 }, urgency: 0 }),
      on(nano, async () => {
        await Bun.sleep(100);
        return "Too late";
      }),
      on(haiku, "Plus is 12 USD a month."),
    );

    const { answer, calls } = await run(
      desk,
      { text: "How much is Plus?" },
      { models: [models], settings: { models: { firstChunk: 20 } } },
    );

    expect(await answer.text()).toBe("Plus is 12 USD a month.");
    expect(calls.map(({ model, code }) => [model, code])).toEqual([
      [jev.name, undefined],
      [nano.name, "aborted"],
      [haiku.name, undefined],
    ]);
  });

  test("a strong model silent for too long is tried again, then the other answers", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { dispute: 1 }, urgency: 0 }),
      on(sonnet, async () => {
        await Bun.sleep(100);
        return "Too late";
      }),
      on(oss, "Clause 2 applies."),
    );

    const { path, answer } = await run(
      desk,
      { text: "You charged me twice and I want it back." },
      { models: [models], settings: { models: { silent: 20 } } },
    );

    expect(path).toEqual(["conversation", "escalated"]);
    expect(await answer.text()).toBe("Clause 2 applies.");
    expect(models.sent(sonnet)).toHaveLength(2);
  });

  test("both strong models silent sends the case to the standard path", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { dispute: 1 }, urgency: 0 }),
      on(sonnet, async () => {
        await Bun.sleep(100);
        return "Too late";
      }),
      on(oss, async () => {
        await Bun.sleep(100);
        return "Too late";
      }),
      on(nano, "Clause 2 applies."),
    );

    const { path, answer } = await run(
      desk,
      { text: "You charged me twice and I want it back." },
      { models: [models], settings: { models: { silent: 20 } } },
    );

    expect(path).toEqual(["conversation", "standard"]);
    expect(await answer.text()).toBe("Clause 2 applies.");
  });

  test("a strong model that stalls halfway through its answer fails the request", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { dispute: 1 }, urgency: 0 }),
      on(sonnet, async function* () {
        yield { type: "text", text: "Clause 2 " };
        await Bun.sleep(100);
        yield { type: "text", text: "applies." };
      }),
    );

    const asked = run(
      desk,
      { text: "You charged me twice and I want it back." },
      { models: [models], settings: { models: { silent: 20 } } },
    );

    await expect(asked).rejects.toBeInstanceOf(TimedOut);
    expect(models.sent(oss)).toEqual([]);
  });
});

describe("the answer", () => {
  test("a card number split between chunks never reaches the caller", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { billing: 1 }, urgency: 0 }),
      on(nano, [
        { type: "text", text: "The card 4111 1111 " },
        { type: "text", text: "1111 1111 was charged 12 USD " },
        { type: "text", text: "on 3 May." },
      ]),
    );

    const { answer } = await run(
      desk,
      { text: "Which card did you charge?" },
      { models: [models] },
    );

    expect(await answer.text()).toBe("The card [card number removed] was charged 12 USD on 3 May.");
  });
});

describe("memory", () => {
  test("a conversation stays with the family that answered, not the one set", async () => {
    const models = fake(
      on(jev, { abuse: 0.01, category: { account: 1 }, urgency: 0 }),
      on(haiku, "Answer from the account's email address."),
    );
    const storage = memory();
    const headers = { "x-conversation-id": "c7" };
    await run(
      desk,
      { text: "I lost my second factor.", headers },
      { models: [models], storage, settings: { models: { frontline: "haiku" } } },
    );

    const { answer } = await run(
      desk,
      { text: "Which address is that?", headers },
      { models: [models], storage },
    );

    expect(await answer.text()).toBe("Answer from the account's email address.");
    expect(await storage.get("desk:case:c7")).toEqual({
      category: "account",
      urgent: false,
      family: "anthropic",
    });
  });
});
