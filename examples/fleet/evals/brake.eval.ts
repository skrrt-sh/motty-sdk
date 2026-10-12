import { describe, expect, test } from "bun:test";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { run } from "@mottyjs/test";
import fleet from "../src/motty";

const { ANTHROPIC_KEY } = process.env;

// What a model says once its tools are forbidden is the part that varies, so the small model is
// real. A budget of nothing is spent from the start, so the first request of a subagent is closed
describe.skipIf(!ANTHROPIC_KEY)("a subagent closed by the real small model", () => {
  test("a subagent stopped between two tool calls reports in words 4 times in 5", async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, () =>
        run(
          fleet,
          {
            model: "claude-opus-5-5",
            options: { maxTokens: 200 },
            headers: { "x-claude-code-session-id": "s1", "x-claude-code-agent-id": "a1b2c3d4" },
            tools: [
              {
                type: "function",
                name: "Read",
                description: "Reads a file of the repository",
                input: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"],
                },
              },
            ],
            messages: [
              { role: "user", text: "Read orders.ts and payments.ts and say what each does." },
              {
                role: "assistant",
                parts: [
                  { type: "tool_call", id: "call_1", name: "Read", input: { path: "orders.ts" } },
                ],
              },
              {
                role: "tool",
                parts: [
                  {
                    type: "tool_result",
                    id: "call_1",
                    text: 'export const list = () => db.all("orders");',
                  },
                ],
              },
            ],
          },
          {
            models: [anthropic({ key: ANTHROPIC_KEY })],
            settings: { fleet: { budget: 0 } },
          },
        ),
      ),
    );

    const said = await Promise.all(
      runs.map(async ({ answer }) => {
        const chunks = await Array.fromAsync(answer.chunks());
        return {
          text: await answer.text(),
          called: chunks.some(({ type }) => type === "tool_call"),
        };
      }),
    );
    expect(said.filter(({ called }) => called)).toHaveLength(0);
    expect(said.filter(({ text }) => /stopped/i.test(text)).length).toBeGreaterThanOrEqual(4);
  });
});
