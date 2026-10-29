# @mottyjs/core

The core of the Motty SDK: all a motty needs to work and a plugin needs to be written. It holds
the `motty` builder, `model`, the combinators `fallback`, `race`, `retry` and `timeout`, `answer`,
`reroute`, `think`, `said`, the error classes and the types. It has no dependencies, and only
what is imported ends up in a motty's bundle. `said(message)` is what a message says, whether it
came as `text` or as parts.

```sh
bun add @mottyjs/core
```

```ts
import { fallback, model, motty, race, retry, reroute } from "@mottyjs/core";
```

A motty that answers a request without tools with the first of two small models to reply, and
any other with a strong model, retried twice, with a second one behind it:

```ts
import { fallback, model, motty, race, retry, reroute } from "@mottyjs/core";

const mini = model("openai/gpt-5-mini");
const gpt = model("openai/gpt-5");
const haiku = model("anthropic/claude-haiku");
const sonnet = model("anthropic/claude-sonnet");

export default motty({ name: "coder" })
  .route(({ request }) => (request.tools.length === 0 ? "quick" : "standard"), {
    // A quick question still gets an answer when both small models are down
    quick: ({ prompt }) => race(mini, haiku).complete(prompt).catch(() => reroute("standard")),
    standard: ({ prompt }) => fallback(retry(sonnet, 2), gpt).complete(prompt),
  });
```

A call may state `headers` in its options for the request that answers it. They are sent only
where the host's connection allows the name, and a header with no value is skipped:

```ts
const session = request.headers.get("x-session");
prompt.options = { ...prompt.options, headers: { "x-session": session } };
return sonnet.complete(prompt);
```

A plugin reaches the host through the import path `@mottyjs/core/host`.

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
