import { expect, setSystemTime, test } from "bun:test";
import { fake, memory, on, run } from "@mottyjs/test";
import { model, UpstreamFailed } from "@mottyjs/core";
import { anthropic, openai } from "../src/models";
import { scout } from "../src/modules/scout";
import fleet from "../src/motty";
import { price } from "../src/price";
import { budgetFrom } from "../src/settings";

test.each([
  ["a Claude Code lead", { "x-claude-code-session-id": "s1" }, "asked", anthropic.lead],
  [
    "a Claude Code subagent",
    { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a1b2c3d4" },
    "scout",
    anthropic.small,
  ],
  ["a Codex lead", { "session-id": "s1", "thread-id": "s1" }, "asked", openai.lead],
  ["a Codex subagent", { "session-id": "s1", "thread-id": "t1" }, "scout", openai.small],
])("%s under the motty's own name takes the %s route", async (_who, headers, taken, by) => {
  const models = fake(on(by, "orders.ts lists orders"));

  const { route, answer } = await run(fleet, { text: "Read orders.ts", headers }, { models: [models] });

  expect<string | undefined>(route).toBe(taken);
  expect(await answer.text()).toBe("orders.ts lists orders");
});

test.each([
  [
    "a Claude Code subagent",
    { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a1b2c3d4" },
    "claude-opus-5-5",
    anthropic.lead,
  ],
  ["a Codex subagent", { "session-id": "s1", "thread-id": "t1" }, "gpt-6.1-sol", openai.lead],
  ["a Codex subagent", { "session-id": "s1", "thread-id": "t1" }, "gpt-6-luna", openai.small],
])("%s is answered by the %s it asked for when the scouts are not sent to the small one", async (_who, headers, asked, by) => {
  const models = fake(on(by, "orders.ts lists orders"));

  const { route, answer } = await run(
    fleet,
    { text: "Read orders.ts", model: asked, headers },
    { models: [models], settings: { fleet: { scouts: "asked" } } },
  );

  expect(route).toBe("asked");
  expect(await answer.text()).toBe("orders.ts lists orders");
});

test("past the budget a subagent is closed by the small model and the lead is not", async () => {
  const storage = memory();
  const models = fake(
    on(anthropic.lead, [
      { type: "text", text: "I will read the files" },
      { type: "finish", reason: "stop", usage: { cost: 0.5 } },
    ]),
    on(anthropic.small, "Stopped early: orders.ts lists orders"),
    on(anthropic.lead, "Here is what was found"),
  );
  const host = { models: [models], storage, settings: { fleet: { budget: 0.5 } } };

  await run(
    fleet,
    {
      text: "Understand the repo",
      model: "claude-opus-5-5",
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "x-claude-code-session-id": "s1" },
    },
    host,
  );
  const stopped = await run(
    fleet,
    {
      text: "Read orders.ts",
      model: "claude-opus-5-5",
      options: { maxTokens: 200 },
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a1b2c3d4" },
    },
    host,
  );
  const next = await run(
    fleet,
    {
      text: "Go on",
      model: "claude-opus-5-5",
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "x-claude-code-session-id": "s1" },
    },
    host,
  );

  expect(await stopped.answer.text()).toBe("Stopped early: orders.ts lists orders");
  expect(models.sent(anthropic.small)[0]).toMatchObject({
    tools: [{ type: "function", name: "Read", input: {} }],
    options: { maxTokens: 200, toolChoice: "none" },
  });
  expect(next.route).toBe("asked");
  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toContain(
    "STOPPED Read orders.ts",
  );
});

test("a caller that is no agent is told what every seat ran on and what it cost", async () => {
  const storage = memory();
  const models = fake(
    on(anthropic.lead, [
      { type: "text", text: "I will read the files" },
      { type: "finish", reason: "stop", usage: { cost: 0.25 } },
    ]),
    on(anthropic.small, [
      { type: "text", text: "orders.ts lists orders" },
      { type: "finish", reason: "stop", usage: { cost: 0.25 } },
    ]),
  );
  const host = { models: [models], storage };

  await run(
    fleet,
    {
      text: "Understand the repo",
      model: "claude-opus-5-5",
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "x-claude-code-session-id": "s1" },
    },
    host,
  );
  await run(
    fleet,
    {
      text: "Read orders.ts",
      model: "claude-opus-5-5",
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a1b2c3d4" },
    },
    host,
  );
  const { answer } = await run(fleet, { text: "status?" }, host);

  expect(await answer.text()).toBe(
    [
      "lead        claude-opus-5-5     1 req   $0.250  Understand the repo",
      "sub b2c3d4  claude-haiku-5-5    1 req   $0.250  Read orders.ts",
      "spent $0.500 of $1.000",
    ].join("\n"),
  );
});

test("each session has a lead and a budget of its own", async () => {
  const storage = memory();
  const models = fake(
    on(anthropic.lead, [
      { type: "text", text: "I will read the files" },
      { type: "finish", reason: "stop", usage: { cost: 0.2 } },
    ]),
    on(openai.lead, [
      { type: "text", text: "I will read the tests" },
      { type: "finish", reason: "stop", usage: { cost: 0.3 } },
    ]),
    on(openai.small, "orders.test.ts tests orders"),
  );
  const host = { models: [models], storage, settings: { fleet: { budget: 0.2 } } };

  await run(
    fleet,
    { text: "Understand the repo", model: "claude-opus-5-5", headers: { "x-claude-code-session-id": "a" } },
    host,
  );
  await run(
    fleet,
    { text: "Understand the tests", model: "gpt-6.1-sol", headers: { "session-id": "b", "thread-id": "b" } },
    host,
  );
  await run(
    fleet,
    { text: "Read orders.test.ts", model: "gpt-6.1-sol", headers: { "session-id": "c", "thread-id": "t1" } },
    host,
  );

  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toBe(
    [
      "lead        claude-opus-5-5     1 req   $0.200  Understand the repo",
      "spent $0.200 of $0.200",
      "lead        gpt-6.1-sol         1 req   $0.300  Understand the tests",
      "spent $0.300 of $0.200",
      "sub t1      gpt-6-luna          1 req   $0.000  Read orders.test.ts",
      "spent $0.000 of $0.200",
    ].join("\n"),
  );
});

test("a session is on the board for a day from its first request and then gone", async () => {
  const storage = memory();
  const host = { models: [fake(on(openai.lead, "I will read the files"))], storage };

  try {
    setSystemTime(new Date("2026-03-01T23:00:00Z"));
    await run(
      fleet,
      { text: "Understand the repo", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "s1" } },
      host,
    );
    setSystemTime(new Date("2026-03-02T22:00:00Z"));
    const kept = await (await run(fleet, { text: "status?" }, host)).answer.text();
    setSystemTime(new Date("2026-03-02T23:30:00Z"));
    const gone = await (await run(fleet, { text: "status?" }, host)).answer.text();

    expect(kept).toContain("Understand the repo");
    expect(gone).toBe("spent $0.000 of $1.000");
  } finally {
    setSystemTime();
  }
});

test("subagents asking at once all pass a budget that none has been charged against yet", async () => {
  const storage = memory();
  const models = fake(
    ...Array.from({ length: 5 }, () =>
      on(anthropic.small, [
        { type: "text", text: "orders.ts lists orders" },
        { type: "finish", reason: "stop", usage: { cost: 0.5 } },
      ]),
    ),
  );
  const host = { models: [models], storage, settings: { fleet: { budget: 0.1 } } };

  const ran = await Promise.all(
    ["a1", "a2", "a3", "a4", "a5"].map((agent) =>
      run(
        fleet,
        {
          text: "Read orders.ts",
          headers: { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": agent },
        },
        host,
      ),
    ),
  );

  expect(ran.map(({ route }) => route)).toEqual(["scout", "scout", "scout", "scout", "scout"]);
  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toEndWith(
    "spent $2.500 of $0.100",
  );
});

test("a seat that is counted and has no row yet is left off the board", async () => {
  const inner = memory();
  const reached = Promise.withResolvers<void>();
  const written = Promise.withResolvers<void>();
  const host = {
    models: [fake(on(openai.lead, "I will read the files"))],
    storage: {
      ...inner,
      set: async (...given: Parameters<typeof inner.set>) => {
        reached.resolve();
        await written.promise;
        return inner.set(...given);
      },
    },
  };

  const asked = run(
    fleet,
    { text: "Understand the repo", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "s1" } },
    host,
  );
  await reached.promise;
  const board = await (await run(fleet, { text: "status?" }, host)).answer.text();
  written.resolve();
  await asked;

  expect(board).toBe("spent $0.000 of $1.000");
});

test("past the budget a Codex subagent is closed by the small OpenAI model and the lead is not", async () => {
  const storage = memory();
  const models = fake(
    on(openai.lead, [
      { type: "text", text: "I will read the files" },
      { type: "finish", reason: "stop", usage: { cost: 0.5 } },
    ]),
    on(openai.small, "Stopped early: orders.ts lists orders"),
    on(openai.lead, "Here is what was found"),
  );
  const host = { models: [models], storage, settings: { fleet: { budget: 0.5 } } };

  await run(
    fleet,
    { text: "Understand the repo", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "s1" } },
    host,
  );
  const stopped = await run(
    fleet,
    { text: "Read orders.ts", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "t1" } },
    host,
  );
  const next = await run(
    fleet,
    { text: "Go on", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "s1" } },
    host,
  );

  expect(await stopped.answer.text()).toBe("Stopped early: orders.ts lists orders");
  expect(models.sent(openai.small)[0]?.options?.toolChoice).toBeUndefined();
  expect(next.route).toBe("asked");
  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toBe(
    [
      "lead        gpt-6.1-sol         2 req   $0.500  Understand the repo",
      "sub t1      gpt-6-luna          1 req   $0.000  STOPPED Read orders.ts",
      "spent $0.500 of $0.500",
    ].join("\n"),
  );
});

test("a request that failed is marked on the row of its seat", async () => {
  const storage = memory();
  const models = fake(on(openai.lead, new UpstreamFailed("The provider refused the request")));
  const host = { models: [models], storage };

  const asked = run(
    fleet,
    { text: "Understand the repo", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "s1" } },
    host,
  );

  await expect(asked).rejects.toBeInstanceOf(UpstreamFailed);
  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toBe(
    [
      "lead        gpt-6.1-sol         1 req   $0.000  1 FAILED Understand the repo",
      "spent $0.000 of $1.000",
    ].join("\n"),
  );
});

test("the scout seat fails for a caller that is no agent", async () => {
  await expect(run(scout, { text: "Read orders.ts" })).rejects.toThrow();
});

test("tokens read from a cache and written to one are priced at their own rates and not again as input", async () => {
  const storage = memory();
  const models = fake(
    on(anthropic.lead, [
      { type: "text", text: "I will read the files" },
      {
        type: "finish",
        reason: "stop",
        usage: { input: 1_000_000, cached: 500_000, cacheWrite: 250_000, output: 100_000 },
      },
    ]),
  );
  const host = { models: [models], storage, price };

  await run(
    fleet,
    {
      text: "Understand the repo",
      model: "claude-opus-5-5",
      headers: { "x-claude-code-session-id": "s1" },
    },
    host,
  );

  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toBe(
    [
      "lead        claude-opus-5-5     1 req   $4.350  Understand the repo",
      "spent $4.350 of $1.000",
    ].join("\n"),
  );
});

test("a model the host has no rate for is charged as the lead model of its family", async () => {
  const storage = memory();
  const models = fake(
    on(model("anthropic/claude-sonnet-5-5"), [
      { type: "text", text: "I will read the files" },
      { type: "finish", reason: "stop", usage: { input: 1_000_000, output: 1_000_000 } },
    ]),
  );
  const host = { models: [models], storage, price };

  await run(
    fleet,
    { text: "Understand the repo", model: "claude-sonnet-5-5", headers: { "x-claude-code-session-id": "s1" } },
    host,
  );

  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toBe(
    [
      "lead        claude-sonnet-5-5   1 req  $24.000  Understand the repo",
      "spent $24.000 of $1.000",
    ].join("\n"),
  );
  expect(price("openai/gpt-6.1-terra", { input: 1_000_000, output: 1_000_000 })).toBe(18);
});

test("a seat's task is the last text the agent sent, without its paths and on one line", async () => {
  const storage = memory();
  const models = fake(on(openai.lead, "I will read the file"));
  const host = { models: [models], storage };

  await run(
    fleet,
    {
      model: "gpt-6.1-sol",
      headers: { "session-id": "s1", "thread-id": "s1" },
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "The working directory is /Users/me/repo/" },
            { type: "text", text: "Read /Users/me/repo/src/orders.ts\nand   say what it does" },
          ],
        },
      ],
    },
    host,
  );

  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toBe(
    [
      "lead        gpt-6.1-sol         1 req   $0.000  Read orders.ts and say what it does",
      "spent $0.000 of $1.000",
    ].join("\n"),
  );
});

test("a task longer than a row is cut at 70 characters and says that it was cut", async () => {
  const storage = memory();
  const models = fake(on(openai.lead, "I will read the files"));
  const host = { models: [models], storage };

  await run(
    fleet,
    {
      text: "Understand this repo, one subagent per module, and tell me in five short lines what each does",
      model: "gpt-6.1-sol",
      headers: { "session-id": "s1", "thread-id": "s1" },
    },
    host,
  );

  expect(await (await run(fleet, { text: "status?" }, host)).answer.text()).toBe(
    [
      "lead        gpt-6.1-sol         1 req   $0.000  Understand this repo, one subagent per module, and tell me in five sh…",
      "spent $0.000 of $1.000",
    ].join("\n"),
  );
});

test.each([
  [undefined, 1],
  ["", 1],
  ["0", 0],
  ["2.5", 2.5],
])("a BUDGET of %p is a budget of %p", (given, budget) => {
  expect(budgetFrom(given)).toBe(budget);
});

test.each(["5$", "abc", "-1", "Infinity"])("a BUDGET of %p stops the host with its name and value", (given) => {
  expect(() => budgetFrom(given)).toThrow(
    `The fleet host was given BUDGET=${given}, which is no amount in USD of 0 or more`,
  );
});
