import { expect, test } from "bun:test";
import { fake, memory, on, run } from "@mottyjs/test";
import { UpstreamFailed } from "@mottyjs/core";
import { anthropic, openai } from "../src/models";
import { scout } from "../src/modules/scout";
import fleet from "../src/motty";
import { price } from "../src/price";

test("a subagent that asked for the lead's model is answered by the small one", async () => {
  const models = fake(on(anthropic.small, "orders.ts lists orders"));

  const { route, answer } = await run(
    fleet,
    {
      text: "Read orders.ts",
      model: "claude-opus-5-5",
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a1b2c3d4" },
    },
    { models: [models] },
  );

  expect(route).toBe("scout");
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
    options: { toolChoice: "none" },
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

test("a Codex lead under the motty's own name is answered by the lead model of its family", async () => {
  const models = fake(on(openai.lead, "I will spawn three subagents"));

  const { route, answer } = await run(
    fleet,
    {
      text: "Understand the repo",
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "session-id": "s1", "thread-id": "s1" },
    },
    { models: [models] },
  );

  expect(route).toBe("asked");
  expect(await answer.text()).toBe("I will spawn three subagents");
});

test("a Codex subagent that names a real model and declares no tools is answered by the small one", async () => {
  const models = fake(on(openai.small, "orders.ts lists orders"));

  const { route, answer } = await run(
    fleet,
    { text: "Read orders.ts", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "t1" } },
    { models: [models] },
  );

  expect(route).toBe("scout");
  expect(await answer.text()).toBe("orders.ts lists orders");
});

test("a Codex subagent under the motty's own name is answered by the small one", async () => {
  const models = fake(on(openai.small, "orders.ts lists orders"));

  const { route, answer } = await run(
    fleet,
    {
      text: "Read orders.ts",
      tools: [{ type: "function", name: "Read", input: {} }],
      headers: { "session-id": "s1", "thread-id": "t1" },
    },
    { models: [models] },
  );

  expect(route).toBe("scout");
  expect(await answer.text()).toBe("orders.ts lists orders");
});

test("a Codex subagent is answered by the model it asked for when the scouts are not sent to the small one", async () => {
  const models = fake(on(openai.lead, "orders.ts lists orders"));

  const { route } = await run(
    fleet,
    { text: "Read orders.ts", model: "gpt-6.1-sol", headers: { "session-id": "s1", "thread-id": "t1" } },
    { models: [models], settings: { fleet: { scouts: "asked" } } },
  );

  expect(route).toBe("asked");
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

test("a Claude Code subagent is answered by the model it asked for when the scouts are not sent to the small one", async () => {
  const models = fake(on(anthropic.lead, "orders.ts lists orders"));

  const { route, answer } = await run(
    fleet,
    {
      text: "Read orders.ts",
      model: "claude-opus-5-5",
      headers: { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a1b2c3d4" },
    },
    { models: [models], settings: { fleet: { scouts: "asked" } } },
  );

  expect(route).toBe("asked");
  expect(await answer.text()).toBe("orders.ts lists orders");
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

test("a model the host has no rate for is left at the cost its upstream reported", () => {
  expect(price("openrouter/openai/gpt-oss-20b", { input: 1_000_000 })).toBeUndefined();
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
