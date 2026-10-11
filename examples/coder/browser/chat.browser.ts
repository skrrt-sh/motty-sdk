import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { bearer } from "@mottyjs/adapters/jwt";
import type { Marked, ModelAdapter, Report } from "@mottyjs/core/host";
import { mount } from "@mottyjs/serve";
import { fake, memory, on } from "@mottyjs/test";
import { chromium, type Browser, type Page } from "playwright";
import { jev, opus, sonnet } from "../src/models";
import coder from "../src/motty";
import { bundled } from "../test/bundled";

const records: Report[] = [];
const stopped: string[] = [];

const onTopic = fake(on(jev, { software: 0.97 }));
const offTopic = fake(on(jev, { software: 0.02 }));

// The host's options are read once, so one judge serves every test by what it is asked
const judge: ModelAdapter = {
  serves: onTopic.serves,
  decide: (name, input, signal) =>
    (JSON.stringify(input).includes("cook") ? offTopic : onTopic).decide(name, input, signal),
};

// Counts aloud, slowly enough to be seen arriving and to be stopped halfway
const counting: ModelAdapter = {
  serves: () => true,
  async *call(name, _prompt, signal) {
    signal.addEventListener("abort", () => stopped.push(name), { once: true });
    for (let said = 1; said <= (name === opus.name ? 40 : 8); said++) {
      await Bun.sleep(25);
      signal.throwIfAborted();
      yield { type: "text", text: `${said} ` };
    }
    yield { type: "finish", reason: "stop" };
  },
};

// The record is handed over after the response has ended, so a test waits for it
async function reported(count: number): Promise<Report[]> {
  while (records.length < count) await Bun.sleep(5);
  return records;
}

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

describe.each([
  { from: "source", load: async (): Promise<Marked> => coder },
  { from: "bundle", load: bundled },
])("the motty from its $from", ({ from, load }) => {
  let served: ReturnType<typeof mount>;
  let server: Bun.Server<undefined>;

  beforeAll(async () => {
    served = mount(await load(), () => ({
      models: [judge, fake(on(sonnet, "1. Find the lock order")), counting],
      storage: memory(),
      auth: bearer({ secret: "s3cret", id: "browser" }),
      report: (record) => void records.push(record),
    }));
    // The page and the API share an origin, as they would behind one proxy
    server = Bun.serve({
      port: 0,
      fetch: (request, listening) =>
        new URL(request.url).pathname.startsWith("/v1/")
          ? served.fetch(request, listening)
          : new Response(Bun.file(`${import.meta.dir}/chat.html`)),
    });
  });

  afterAll(async () => {
    await served.close();
    await server.stop(true);
  });

  describe.each([
    { format: "chat-completions", unauthenticated: "invalid_api_key" },
    { format: "responses", unauthenticated: "invalid_api_key" },
    { format: "messages", unauthenticated: "authentication_error" },
  ])("$format in a browser", ({ format, unauthenticated }) => {
    beforeEach(async () => {
      records.length = 0;
      stopped.length = 0;
      page = await browser.newPage();
      page.setDefaultTimeout(5_000);
      await page.goto(server.url.href);
      await page.selectOption("#format", format);
      await page.fill("#token", "s3cret");
    });

    afterEach(async () => {
      await page.close();
    });

    test("a short question is answered by the quick tier, a piece at a time", async () => {
      await page.fill("#prompt", "What does git stash do?");
      await page.click("#send");
      // Found and read in one step, while Stop can still be pressed: the answer is still arriving
      const partial = await page.locator("body:has(#stop:enabled) #answer:not(:empty)").textContent();
      await page.locator("#send:enabled").waitFor();

      const answer = await page.textContent("#answer");
      expect(await page.textContent("#status")).toBe("done");
      expect(answer).toBe("1 2 3 4 5 6 7 8 ");
      expect(answer).toStartWith(partial ?? "");
      expect(partial).not.toBe(answer);
      await page.screenshot({ path: `/tmp/motty-browser-shots/${from}-${format}-done.png` });
      const [record] = await reported(1);
      expect(record).toMatchObject({ outcome: "completed", path: ["chat", "quick"] });
    });

    test("the deep tier shows its choice and its plan before the answer", async () => {
      await page.fill("#model", "acme/coder:max");
      await page.fill("#prompt", "Why does this deadlock?");
      await page.click("#send");
      await page.locator("#answer:not(:empty)").waitFor();
      const progress = await page.textContent("#reasoning");
      await page.locator("#send:enabled").waitFor();

      expect(progress).toBe("Answering with the deep tier\n1. Find the lock order");
      expect(await page.textContent("#reasoning")).toBe(progress);
      expect(await page.textContent("#status")).toBe("done");
      expect(await page.textContent("#answer")).toEndWith("39 40 ");
      const [record] = await reported(1);
      expect(record).toMatchObject({ outcome: "completed", path: ["chat", "deep"] });
    });

    test("Stop ends the answer where it was and is reported as aborted", async () => {
      await page.fill("#model", "acme/coder:max");
      await page.fill("#prompt", "Why does this deadlock?");
      await page.click("#send");
      await page.locator("#answer:not(:empty)").waitFor();
      await page.click("#stop");
      await page.locator("#send:enabled").waitFor();

      const [record] = await reported(1);
      expect(record?.outcome).toBe("aborted");
      expect(stopped).toEqual([opus.name]);
      expect(await page.textContent("#status")).toBe("stopped");
      expect(await page.textContent("#answer")).toMatch(/^1 (\d+ )*$/);
      expect(await page.textContent("#answer")).not.toContain("40 ");
      await page.screenshot({ path: `/tmp/motty-browser-shots/${from}-${format}-stopped.png` });
    });

    test("an off-topic opening gets the canned reply", async () => {
      await page.fill("#prompt", "What should I cook tonight?");
      await page.click("#send");
      await page.locator("#send:enabled").waitFor();

      expect(await page.textContent("#status")).toBe("done");
      expect(await page.textContent("#answer")).toBe(
        "I only answer questions about software and codebases.",
      );
      const [record] = await reported(1);
      expect(record).toMatchObject({ outcome: "completed", path: [] });
    });

    test("a wrong token is shown as this format's authentication error", async () => {
      await page.fill("#token", "wrong");
      await page.fill("#prompt", "What does git stash do?");
      await page.click("#send");
      await page.locator("#send:enabled").waitFor();

      expect(await page.textContent("#status")).toBe(`error ${unauthenticated} (HTTP 401)`);
      expect(await page.textContent("#answer")).toBe("");
      const [record] = await reported(1);
      expect(record).toMatchObject({ outcome: "failed", error: { code: "unauthenticated" } });
    });

    test("a conversation that reached the deep tier stays on it", async () => {
      await page.fill("#conversation", `${format}-thread`);
      await page.fill("#model", "acme/coder:max");
      await page.fill("#prompt", "Why does this deadlock?");
      await page.click("#send");
      await page.locator("#send:enabled").waitFor();
      await reported(1);

      await page.fill("#model", "acme/coder");
      await page.fill("#prompt", "What does git stash do?");
      await page.click("#send");
      await page.locator("#send:enabled").waitFor();

      expect(await page.textContent("#status")).toBe("done");
      const [, second] = await reported(2);
      expect(second).toMatchObject({ outcome: "completed", path: ["chat", "deep"] });
    });

    test("closing the page mid-answer is reported as aborted", async () => {
      await page.fill("#model", "acme/coder:max");
      await page.fill("#prompt", "Why does this deadlock?");
      await page.click("#send");
      await page.locator("#answer:not(:empty)").waitFor();
      await page.close();

      const [record] = await reported(1);
      expect(record?.outcome).toBe("aborted");
      expect(stopped).toEqual([opus.name]);
    });
  });
});
