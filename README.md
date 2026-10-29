<p align="center">
  <img src=".github/assets/logo.webp" alt="Motty" width="240">
</p>

<h1 align="center">Motty SDK</h1>

<p align="center"><strong>A model made of code, not weights</strong></p>

<p align="center">
  The layer below your agents. To them it is one more model.<br>
  Inside, it is your TypeScript, built to fit the stack you already have.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@mottyjs/core"><img src="https://img.shields.io/npm/v/%40mottyjs%2Fcore?label=npm&color=cb3837" alt="@mottyjs/core on npm"></a>
  <img src="https://img.shields.io/badge/runtime-Bun%20%7C%20Workers-f472b6" alt="Runtime: Bun, Workers">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript: strict">
</p>

---

A motty is a model made of code, not weights. You write it in TypeScript, and it is served like
any model, over the Chat Completions, Responses and Messages APIs. The Motty SDK is the
open-source toolkit for building one.

LLMs are layer 1. A motty is layer 2, built on top of them and below your agents and apps.

```text
your agent or app      any client of the three APIs, with only its URL changed
        │
      motty            your TypeScript, one chat request in and one streamed answer out
        │
OpenAI, Anthropic, …   the providers you already use, called with the host's keys
```

## What it makes possible

A motty has the whole request in its hands, calls as many models as it needs and keeps state
between requests. That gives you behaviour that is no setting of a model and no line of config.
Each example in this repository is one model name to its caller:

- **A budget for a coding agent's subagents.** [`examples/fleet`](examples/fleet) sits under
  Claude Code or Codex with nothing set but its URL. It shows what each agent spends and sends
  subagents to a small model. When a session's budget is spent, the small model closes the
  subagent's work from what it has read, so the lead still gets a report.
- **Several providers answering as one model.** [`examples/council`](examples/council) asks
  models of three providers at once and lets the caller watch them answer. A stronger model
  merges what they said, or runs a second round when they disagree. Each caller has a daily
  spending limit.
- **Rules on the answer as it streams.** [`examples/desk`](examples/desk) removes card numbers
  from the text while it streams, even a number split between two chunks. It puts one policy at
  the head of every prompt, so every customer shares one cached prefix.
- **The cheapest model that can do the job.** [`examples/coder`](examples/coder) turns away an
  off-topic first message with a decision model, summarises a thread that has grown long, and
  picks a tier of models for each request.

Each example has a README that follows one request through it.

## Quick start

A motty needs the core. Its host needs `serve` and the adapters, and its tests need the test kit:

```sh
bun add @mottyjs/core @mottyjs/serve @mottyjs/adapters
bun add --dev @mottyjs/test
```

A motty is a default export. This one sends a request without tools to the first of two small
models to answer, and any other to a strong model, retried twice, with a second one behind it:

```ts
// src/motty.ts
import { fallback, model, motty, race, retry } from "@mottyjs/core";

export const mini = model("openai/gpt-5-mini");
export const gpt = model("openai/gpt-5");
export const haiku = model("anthropic/claude-haiku");
export const sonnet = model("anthropic/claude-sonnet");

export default motty({ name: "coder" })
  .route(({ request }) => (request.tools.length === 0 ? "quick" : "standard"), {
    quick: ({ prompt }) => race(mini, haiku).complete(prompt),
    standard: ({ prompt }) => fallback(retry(sonnet, 2), gpt).complete(prompt),
  });
```

A serve file makes it a server. The provider keys are read from the environment and stay with the
host:

```ts
// src/serve.ts
import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { openai } from "@mottyjs/adapters/openai";
import coder from "./motty";

export default serve(coder, ({ OPENAI_KEY, ANTHROPIC_KEY }) => ({
  models: [
    openai({ key: OPENAI_KEY }),
    anthropic({ key: ANTHROPIC_KEY }),
  ],
  limits: { duration: 120_000, calls: 10, afterResponse: 30_000 },
  report: (record) => console.log(JSON.stringify(record)),
}));
```

`bun run src/serve.ts` starts it. Every time in the SDK is in milliseconds and every size in
bytes. A client of any of the three APIs then points its base URL at the server and calls it as
it would a model:

```sh
curl http://localhost:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model": "coder", "messages": [{"role": "user", "content": "What does git stash do?"}]}'
```

A test scripts the models and runs the whole request without the wire:

```ts
// test/coder.test.ts
import { expect, test } from "bun:test";
import { fake, on, run } from "@mottyjs/test";
import coder, { haiku, mini } from "../src/motty";

test("a short question without tools goes to the quick tier", async () => {
  const models = fake(
    on(mini, "quick reply"),
    on(haiku, "quick reply"),
  );

  const { route, answer } = await run(
    coder,
    { text: "What does git stash do?" },
    { models: [models] },
  );

  expect(route).toBe("quick");
  expect(await answer.text()).toBe("quick reply");
});
```

## What the code can do

- **Read the whole request.** The messages, the tools, the options, the caller's headers and who
  the caller is are all there. `said(message)` is what the caller wrote, whether the message came
  as `text` or as parts.
- **Call any model, more than once and in any order.** `race`, `fallback`, `retry` and `timeout`
  compose, and a decision model such as Jev or Laya can pick.
- **Answer without a model.** An answer can be written by hand.
- **Change the prompt on the way up and the answer as it streams down.**
- **Keep state that outlives a request,** shared by every caller of the same URL.
- **Call anything outside** with `fetch`.
- **Be built from parts.** Middleware, modules and plugins compose into one motty, with typed
  settings the host may override.

A router, a cache, a fallback, a guardrail or a memory that agents share is none of it a feature
of the SDK. Each is your code over these few abilities. Start high, with `fallback` and `race`,
and go as low as a provider's own options on one call, or your own adapter, auth or plugin.

## How it fits your stack

- **Nothing above it changes.** A caller changes the URL and the model name and keeps its format.
- **Nothing below it changes.** A motty calls the providers you already use through adapters,
  and you can write your own.
- **It can be your gateway.** The host gives it auth, a limit on calls, time and body size per
  request, a price and a report of every request. Rate limits, budgets and the choice of model
  are code you write and test, not config. `mount` gives the same as a `fetch` handler inside
  your own HTTP server.
- **Your keys stay with the host.** A motty is one file, built apart from whatever runs it. The
  caller's token is removed before it runs, and upstream calls use the keys the host supplies.
  The same file runs self-hosted and on the Hub, a service that hosts motties.

## What it is not

- **Not an agent.** The SDK has no agent loop and no tool runner. The caller's tools are data in
  the request. A motty reads them, routes on them, may change them and hands them to a model,
  and the tool calls go back to the caller to run.
- **Not an MCP server or client.** An MCP server gives an agent tools, and the agent chooses
  when to call them. A motty is the model the agent calls, so every request goes through it.
  Tools an agent takes from MCP servers arrive as plain function tools, the same as any other.
- **Not a pass-through proxy.** A request is decoded, run through your code and written again
  for each upstream. Only the three chat endpoints and the model list are served.

## Packages

| Package | Kind | Holds |
| --- | --- | --- |
| [`@mottyjs/core`](packages/core) | Core | The builder, model calls, `fallback`, `race`, `retry`, `timeout`, answers, `said`, error classes, types |
| [`@mottyjs/store`](packages/store) | Plugin | Key-value storage that outlives a request |
| [`@mottyjs/decision`](packages/decision) | Plugin | Decision models and their questions |
| [`@mottyjs/auth`](packages/auth) | Plugin | A part that requires an identified caller |
| [`@mottyjs/settings`](packages/settings) | Plugin | Typed settings a host may override |
| [`@mottyjs/test`](packages/test) | Test kit | Scripted models, in-memory storage, `run` |
| [`@mottyjs/serve`](packages/serve) | Host side | `serve`, `mount` and the three wire APIs. Never in a bundle |
| [`@mottyjs/adapters`](packages/adapters) | Host side | Model providers, Redis and Durable Object storage, and auth by `jwt`, `bearer` or the host's own object with a `verify` function |

Only the core has no dependencies. Plugins compile into the motty's bundle, and the host side
never does. The reasons behind the design, and what was rejected, are in
[ARCHITECTURE.md](ARCHITECTURE.md). The core's own plan is in [CORE.md](CORE.md).

## Speed

A motty is one more step in every call, so what the SDK adds to one is measured against the
Vercel AI SDK, Mastra, LangChain JS and TanStack AI. The upstream is a stub inside the process,
so a figure is what an SDK adds to a call and never a model's latency. A gate runs the comparison
on every change and fails when a rival does not take more than 1.1 times Motty's time.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/benchmark-time-dark.svg">
  <img alt="Time per call through Motty and four other SDKs, in five scenarios. The figures are in the table below." src=".github/assets/benchmark-time-light.svg">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/benchmark-start-dark.svg">
  <img alt="Cold start and minified program size of Motty and four other SDKs. The figures are in the table below." src=".github/assets/benchmark-start-light.svg">
</picture>

The table gives each rival's cost as a multiple of Motty's, the median over the rounds. Above
one, Motty is ahead.

| | Motty | AI SDK | Mastra | LangChain | TanStack AI |
| --- | ---: | ---: | ---: | ---: | ---: |
| Text, 20 chunks | 40.4 µs | 1.35× | 6.18× | 0.49× | 2.83× |
| Stream, 20 chunks | 40.6 µs | 7.58× | 9.21× | 2.70× | 2.80× |
| Stream, 200 chunks | 230 µs | 8.31× | 6.25× | 3.49× | 3.40× |
| Structured output stream, 20 chunks | 50.2 µs | 8.91× | 11.09× | 3.22× | 2.73× |
| Served over HTTP, 200 chunks | 474 µs | 4.27× | 3.38× | 2.88× | 2.23× |
| Cold start, import to first streamed answer | 21.1 ms | 1.96× | 8.77× | 3.18× | 2.40× |
| Minified program size | 249 KB | 2.49× | 22.75× | 4.64× | 2.87× |

Motty is behind in one place, a non-streamed text call against LangChain. Motty always reads a
stream upstream, and that is the entry the gate lists as a known loss.

The figures were measured on 2026-10-14 on an Apple M4 Max with Bun 1.4.2, against `ai` 7.0.137,
`@mastra/core` 1.75.0, `@langchain/openai` 1.6.2 and `@tanstack/ai` 0.68.0. Each time per call is
the median of five runs, each of 15 rounds of 20,000 chunks after one discarded, with the SDKs
taking turns in one process. Cold start is the median of five runs of 21 starts, each in a fresh
process and taken before the timed calls. Run `bun gates/bench/rivals/compare.ts` to measure it
yourself.

### Storage

Each storage adapter is timed against the least its server does for the same call. For Redis
that is Bun's own client sending one command, and for Workers a bare Durable Object making plain
key-value calls. A gate runs the comparison on every change and fails when an adapter call takes
1.5 times the bare one. One more round trip in a call reads 2.0.

| Call | Redis | Share of the bare client | Durable Object | Share of the bare object |
| --- | ---: | ---: | ---: | ---: |
| Get | 0.24 ms | 1.00× | 21 µs | 1.06–1.09× |
| Set with an expiry | 0.24 ms | 1.00× | 25 µs | 1.05–1.06× |
| Increment with an expiry | 0.25 ms | 1.04× | 61–86 µs | 1.10–1.11× |

With 100 calls in flight the Redis adapter makes 226,000 gets, 181,000 sets and 131,000
increments a second. With 50 in flight the Durable Object makes 46,000 gets a second, and 13,000
to 17,000 increments of one key. Increments made at once all count, and none is lost.

The figures were measured on 2026-10-29 on an Apple M4 Max with Bun 1.4.4, against Valkey 9.1.2
in a local container and a Durable Object in workerd 2026-10-25 on the same machine. A time is the
median of 5,000 calls made one after another, with a value of 512 bytes. A share is the median
over 200 rounds the two take in turn, and the range is over five runs. On Cloudflare the trip to
the object costs more than any figure here. Run `bun test gates/test/storage.test.ts` with
`REDIS_URL` set to measure the shares yourself.

## Status

The packages are on npm under the `@mottyjs` scope, all at one version. Until `1.0.0` a minor
version may break an API. The SDK runs on Bun and Cloudflare Workers. `serve` and the Redis
adapter are Bun's. On Workers a host serves a motty with `mount` and stores with the `cloudflare`
adapter, a Durable Object of the host's own Worker.

- Images, files and audio are carried inside a chat request where the upstream takes them. The
  embeddings, images, audio, files and batches endpoints are not served.
- `openai`, `anthropic`, `openrouter` and `typesafe` are proven against the live API.
- `mistral`, `together` and `fireworks` have a live test that runs when that provider's key is
  set.
- `deepseek`, `moonshot`, `zai`, `dashscope`, `minimax`, `groq`, `ollama` and `local` are so far
  proven only against stubs built from the vendor's reference.
- No gateway is tested yet, neither calling a motty nor called by one. The nearest proven is
  `openrouter`, a router, as an upstream.

## Running the checks

```sh
bun install
bun run lint
bun run typecheck
bun test
```

- The Durable Object adapter is tested in workerd, which its tests start on their own.
- The Redis adapter is tested against a real server, or not at all. The server is Valkey 9,
  and any that speaks the Redis protocol from Redis 6 on works too. Start one with
  `podman compose up -d --wait`, or the same with `docker`, and run the tests with
  `REDIS_URL=redis://127.0.0.1:6379`.
- `bun run test:live` makes real calls that cost money. It needs provider keys in `.env`, and a
  provider without a key is skipped.

## Security

How to report a vulnerability, and what the SDK does and does not guard, is in
[SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Skrrt LLC.
