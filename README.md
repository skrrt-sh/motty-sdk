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
  <img src="https://img.shields.io/badge/runtime-Bun-f472b6" alt="Runtime: Bun">
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6" alt="TypeScript: strict">
</p>

---

A motty is a model made of code, not weights. The Motty SDK is the open-source toolkit for
building them.

LLMs are layer 1. A motty is layer 2, built on top of them and below your agents. To everything
above it, it is one more model. Inside, it is your TypeScript, with the whole request in its
hands and no limit on what it does before it answers.

## It fits what you already have

- **Nothing above it changes.** A caller changes the URL and the model name and keeps its format,
  whether that is the Chat Completions, Responses or Messages API. An agent does not know it is
  talking to a motty.
- **Nothing below it changes.** A motty calls the providers you already use, through adapters,
  and you can write your own.
- **It goes where you need it.** A motty can be your gateway, served with the host's auth, limits
  and a record of every request. It can sit behind a gateway you have as one of its models, or in
  front of it. `mount` gives it as a `fetch` handler inside your own HTTP server.
- **Your keys stay with you.** A motty is one file, built apart from whatever runs it. The
  server, the adapters and the provider keys stay with the host, so the same file runs
  self-hosted and on the Hub, a service that hosts motties.

## What the code inside can do

- **Read the whole request.** The messages, the tools, the options, the caller's headers and who
  the caller is are all there.
- **Call any model, more than once and in any order.** That is one model, several in a race, a
  fallback chain, a retry, or a decision model such as Jev or Laya that picks. The host sets how
  many calls one request may make.
- **Answer without a model.** An answer can be written by hand.
- **Change the prompt before it goes up and the answer as it streams down.**
- **Keep state that outlives a request.** Every caller of the same URL shares it.
- **Call anything outside** with `fetch`.
- **Be put together from parts.** Middleware, modules and plugins compose into one motty, with
  typed settings the host may override.

## What follows from that

A router, a gateway, a cache, a fallback, a guardrail, a memory that agents share, a model that
merges other models. None of these is a feature of the SDK. Each is your own code over the same
few abilities, and so is whatever nobody has named yet.

Other gateways are set up in config and take code as a plugin, and an auto-router picks by rules
of its own. A motty is all code. It is typed, yours to change, and tested with scripted models
and no wire. It is fast, and as high or as low level as you need. Start with `fallback` and
`race`, and go down to a provider's own options on one call, or to your own adapter, auth or
plugin.

A motty is not an agent. It has no agent loop and runs no tools.

## Status

The packages are on npm under the `@mottyjs` scope, all at one version. Until `1.0.0` a minor
version may break an API. The SDK runs on Bun only, since `serve`, the adapters, the bundler and
the test runner are Bun's. A motty's own code uses web-standard APIs and the async context. No
other runtime is promised.

| Package | What it holds |
| --- | --- |
| [`@mottyjs/core`](packages/core) | The builder, model calls, `fallback`, `race`, `retry` and `timeout`, the errors and the types |
| [`@mottyjs/serve`](packages/serve) | The host side, which serves a motty over the Chat Completions, Responses and Messages APIs |
| [`@mottyjs/adapters`](packages/adapters) | Model providers, Redis storage, and jwt and bearer auth for the host |
| [`@mottyjs/decision`](packages/decision) | Decision models and their choice, score and noul questions |
| [`@mottyjs/store`](packages/store) | Key-value storage kept in whatever the host supplies |
| [`@mottyjs/settings`](packages/settings) | Typed settings with defaults in code and overrides from the host |
| [`@mottyjs/auth`](packages/auth) | A part that requires a caller the host has identified |
| [`@mottyjs/test`](packages/test) | Scripted models, in-memory storage and a `run` function for any test runner |

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
it would a model.

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

## Examples

Four motties, each with a README that follows one request through it:

- [`examples/coder`](examples/coder) sends coding-agent requests to the cheapest model that can
  handle them.
- [`examples/council`](examples/council) puts a hard question to models of three providers and
  has a stronger model merge what they said, within a spending limit.
- [`examples/desk`](examples/desk) is a customer-support desk served as one model.
- [`examples/fleet`](examples/fleet) runs a coding agent's subagents through one motty, shows what
  each one spends, sends them to a small model and stops them at a budget.

The reasons behind the design, and what was rejected, are in [ARCHITECTURE.md](ARCHITECTURE.md).
The core's own plan is in [CORE.md](CORE.md).

## Packages

| Package | Kind | Holds |
| --- | --- | --- |
| [`@mottyjs/core`](packages/core) | Core | The builder, model calls, `fallback`, `race`, `retry`, `timeout`, answers, error classes, types |
| [`@mottyjs/store`](packages/store) | Plugin | Key-value storage that outlives a request |
| [`@mottyjs/decision`](packages/decision) | Plugin | Decision models and their questions |
| [`@mottyjs/auth`](packages/auth) | Plugin | A part that requires an identified caller |
| [`@mottyjs/settings`](packages/settings) | Plugin | Typed settings a host may override |
| [`@mottyjs/test`](packages/test) | Test kit | Scripted models, in-memory storage, `run` |
| [`@mottyjs/serve`](packages/serve) | Host side | `serve`, `mount` and the three wire APIs. Never in a bundle |
| [`@mottyjs/adapters`](packages/adapters) | Host side | Model providers, Redis storage, and auth by `jwt`, `bearer` or the host's own object with a `verify` function |

Only the core has no dependencies. Plugins compile into the motty's bundle; the host side never
does.

## Speed

A motty is one more step in every call, so what the SDK adds to one is measured. The same calls
are made through Motty and through four other SDKs, the Vercel AI SDK, Mastra, LangChain JS and
TanStack AI. The upstream is a stub that answers inside the process, so a figure is what an SDK
adds to a call, never a model's own latency. A gate runs the comparison on every change and
fails when a rival does not take more than 1.1 times Motty's time, or when its program is not
larger. One entry is listed as a known loss and is held to the opposite: it
fails once Motty is ahead there, so the list cannot go stale.

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
| Text, 20 chunks | 39.6 µs | 1.34× | 6.00× | 0.50× | 2.83× |
| Stream, 20 chunks | 40.6 µs | 7.57× | 9.39× | 2.70× | 2.86× |
| Stream, 200 chunks | 234 µs | 8.30× | 6.40× | 3.43× | 3.38× |
| Structured output stream, 20 chunks | 51.0 µs | 8.81× | 11.15× | 3.16× | 2.65× |
| Served over HTTP, 200 chunks | 484 µs | 4.24× | 3.33× | 2.78× | 2.17× |
| Cold start, import to first streamed answer | 22.5 ms | 1.93× | 7.98× | 3.02× | 2.14× |
| Minified program size | 249 KB | 2.49× | 22.81× | 4.65× | 2.88× |

Motty is behind in one place, a non-streamed text call against LangChain. Motty always reads a
stream upstream, and that is the entry the gate lists as a known loss.

The figures are those of this repository as it stood on 2026-10-12, measured that day on an Apple
M4 Max with Bun 1.4.2, against `ai` 7.0.137, `@mastra/core` 1.75.0, `@langchain/openai` 1.6.2 and
`@tanstack/ai` 0.68.0.
They come from 15 rounds of 20,000 chunks after one discarded, with the SDKs taking turns in one
process. To measure it yourself, run `bun gates/bench/rivals/compare.ts`, which prints the same
figures with each call's 99th percentile.

## Running the checks

```sh
bun install
bun run lint
bun run typecheck
bun test
```

- The storage adapter is tested against a real server, or not at all. Start one with
  `podman compose up -d --wait`, or the same with `docker`, and run the tests with
  `REDIS_URL=redis://127.0.0.1:6379`.
- `bun run test:live` makes real calls that cost money. It needs provider keys in `.env`, and a
  provider without a key is skipped.

## Provider adapters

How far each model provider's adapter is proven differs.

- `openai`, `anthropic`, `openrouter` and `typesafe` are proven against the live API.
- `mistral`, `together` and `fireworks` have a live test that runs when that provider's key is
  set.
- `deepseek`, `moonshot`, `zai`, `dashscope`, `minimax`, `groq`, `ollama` and `local` are so far
  proven only against stubs built from the vendor's reference.
- No gateway is tested yet, neither calling a motty nor called by one. The nearest proven is
  `openrouter`, a router, as an upstream.

## Security

How to report a vulnerability, and what the SDK does and does not guard, is in
[SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[Apache-2.0](LICENSE). Copyright 2026 Skrrt LLC.
