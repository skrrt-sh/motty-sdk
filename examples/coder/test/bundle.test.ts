import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { bearer } from "@mottyjs/adapters/jwt";
import { mark, version, type Marked, type Report } from "@mottyjs/core/host";
import { mount } from "@mottyjs/serve";
import { parsed } from "@mottyjs/serve/sse";
import { fake, memory, on } from "@mottyjs/test";
import { z } from "zod";
import { haiku, jev, mini, opus, sonnet } from "../src/models";
import source from "../src/motty";
import { bundled, file } from "./bundled";

function ask(
  question: string,
  sent: { model?: string; headers?: { [name: string]: string }; signal?: AbortSignal } = {},
): Request {
  return new Request("http://coder.test/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer s3cret",
      ...sent.headers,
    },
    body: JSON.stringify({
      model: sent.model ?? "acme/coder",
      stream: true,
      messages: [{ role: "user", content: question }],
    }),
    signal: sent.signal ?? null,
  });
}

async function* pieces(reply: Response): AsyncGenerator<string> {
  if (reply.body === null) return;
  for await (const { data } of parsed(reply.body)) {
    if (data === "[DONE]") return;
    const { choices } = z
      .object({
        choices: z.array(z.object({ delta: z.object({ content: z.string().nullish() }) })),
      })
      .parse(JSON.parse(data));
    const content = choices[0]?.delta.content;
    if (content) yield content;
  }
}

describe("the bundle", () => {
  let coder: Marked;

  beforeAll(async () => {
    coder = await bundled();
  });

  test("is one file, and the motty is all it exports", async () => {
    const loaded: unknown = await import(file);

    expect(await readdir(`${import.meta.dir}/../dist`)).toEqual(["motty.js"]);
    expect(Object.keys(Object(loaded))).toEqual(["default"]);
  });

  test("imports the async context and nothing else, so the SDK in it is a copy of its own", async () => {
    const imports = new Bun.Transpiler({ loader: "js" }).scanImports(await Bun.file(file).text());

    expect(imports).toEqual([{ kind: "import-statement", path: "node:async_hooks" }]);
    expect(coder).not.toBe(source);
  });

  test("describes itself behind the mark as its source does", () => {
    expect(coder[mark].version).toBe(version);
    expect(coder[mark].description).toEqual({
      sdk: source[mark].description.sdk,
      name: "coder",
      plugins: [
        "auth",
        "empty-prompt",
        "off-topic",
        "settings",
        "compaction",
        "hidden-reasoning",
        "structured",
        "tiers",
        "deep",
      ],
    });
  });

  test("loading it asks nothing of the network and starts no timer", async () => {
    const watched = [
      spyOn(globalThis, "fetch"),
      spyOn(globalThis, "setTimeout"),
      spyOn(globalThis, "setInterval"),
      spyOn(globalThis, "setImmediate"),
    ];

    // The query makes it a module not loaded before, so the file runs again
    await import(`${file}?loaded-again`);
    const called = watched.map((spy) => spy.mock.calls.length);
    for (const spy of watched) spy.mockRestore();

    expect(called).toEqual([0, 0, 0, 0]);
  });
});

describe("the motty from its bundle, behind a host with its own SDK copy", () => {
  let coder: Marked;

  beforeAll(async () => {
    coder = await bundled();
  });

  test("a short question is answered by the quick tier, a piece at a time", async () => {
    const reported = Promise.withResolvers<Report>();
    const served = mount(coder, () => ({
      models: [
        fake(
          on(jev, { software: 0.97 }),
          on(mini, [
            { type: "text", text: "git stash " },
            { type: "text", text: "shelves changes" },
          ]),
          on(haiku, [
            { type: "text", text: "git stash " },
            { type: "text", text: "shelves changes" },
          ]),
        ),
      ],
      auth: bearer({ secret: "s3cret", id: "ada" }),
      report: reported.resolve,
    }));

    const reply = await served.fetch(ask("What does git stash do?"));

    expect(reply.status).toBe(200);
    expect(reply.headers.get("content-type")).toStartWith("text/event-stream");
    expect(await Array.fromAsync(pieces(reply))).toEqual(["git stash ", "shelves changes"]);
    expect(await reported.promise).toMatchObject({
      outcome: "completed",
      path: ["chat", "quick"],
      entries: ["chat", "quick"],
      settings: {},
    });
  });

  test("a caller the host does not know is refused by the motty and told so by the host", async () => {
    const reported = Promise.withResolvers<Report>();
    const served = mount(coder, () => ({
      auth: bearer({ secret: "s3cret", id: "ada" }),
      report: reported.resolve,
    }));

    const reply = await served.fetch(
      ask("What does git stash do?", { headers: { authorization: "Bearer wrong" } }),
    );

    expect(reply.status).toBe(401);
    expect(await reply.json()).toMatchObject({ error: { code: "invalid_api_key" } });
    expect(await reported.promise).toMatchObject({
      outcome: "failed",
      part: "auth",
      error: { code: "unauthenticated", status: 401 },
    });
  });

  test("the host's settings move a short question off the quick tier", async () => {
    const reported = Promise.withResolvers<Report>();
    const served = mount(coder, () => ({
      models: [
        fake(
          on(jev, { software: 0.97, tier: { quick: 0.1, standard: 0.8, deep: 0.1 } }),
          on(sonnet, "standard reply"),
        ),
      ],
      auth: bearer({ secret: "s3cret", id: "ada" }),
      settings: { tiers: { quickQuestionChars: 0 } },
      report: reported.resolve,
    }));

    const reply = await served.fetch(ask("What does git stash do?"));

    expect(await Array.fromAsync(pieces(reply))).toEqual(["standard reply"]);
    expect(await reported.promise).toMatchObject({
      path: ["chat", "standard"],
      settings: { tiers: { quickQuestionChars: 0 } },
    });
  });

  test("the tier that answered is stored under the motty's name", async () => {
    const reported = Promise.withResolvers<Report>();
    const storage = memory();
    const served = mount(coder, () => ({
      models: [fake(on(jev, { software: 0.97 }), on(sonnet, "plan"), on(opus, "deep reply"))],
      storage,
      auth: bearer({ secret: "s3cret", id: "ada" }),
      report: reported.resolve,
    }));

    const reply = await served.fetch(
      ask("Why does this deadlock?", {
        model: "acme/coder:max",
        headers: { "x-conversation-id": "c1" },
      }),
    );

    expect(await Array.fromAsync(pieces(reply))).toEqual(["deep reply"]);
    await reported.promise;
    expect(await storage.get("coder:tier:c1")).toBe("deep");
  });

  test("a caller who leaves mid-answer stops the upstream call", async () => {
    const reported = Promise.withResolvers<Report>();
    const stopped: string[] = [];
    const leaving = new AbortController();
    const served = mount(coder, () => ({
      models: [
        fake(on(jev, { software: 0.97 }), on(sonnet, "plan")),
        {
          serves: (name) => name === opus.name,
          async *call(name, _prompt, signal) {
            const left = Promise.withResolvers<void>();
            signal.addEventListener(
              "abort",
              () => {
                stopped.push(name);
                left.resolve();
              },
              { once: true },
            );
            yield { type: "text", text: "The lock " };
            await left.promise;
            signal.throwIfAborted();
          },
        },
      ],
      auth: bearer({ secret: "s3cret", id: "ada" }),
      report: reported.resolve,
    }));

    const reply = await served.fetch(
      ask("Why does this deadlock?", { model: "acme/coder:max", signal: leaving.signal }),
    );
    const { value } = await pieces(reply).next();
    leaving.abort();

    expect(value).toBe("The lock ");
    expect(await reported.promise).toMatchObject({
      outcome: "aborted",
      error: { code: "aborted" },
      path: ["chat", "deep"],
    });
    expect(stopped).toEqual([opus.name]);
  });
});
