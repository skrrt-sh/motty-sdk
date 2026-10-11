# @mottyjs/serve

The host side of the Motty SDK, on Bun. `serve(motty, options)` is for a serve file, whose default
export Bun starts; `mount(motty, options)` returns `fetch` and `close` for a host that has a
server of its own. Both serve the motty as a model over the Chat Completions, Responses and
Messages APIs. This package is never in a motty's bundle.

```ts
import { mount, serve } from "@mottyjs/serve";
```

A serve file. The keys are read from the environment and stay with the host:

```ts
import { serve } from "@mottyjs/serve";
import { anthropic } from "@mottyjs/adapters/anthropic";
import { jwt } from "@mottyjs/adapters/jwt";
import { openai } from "@mottyjs/adapters/openai";
import { redis } from "@mottyjs/adapters/redis";
import coder from "./motty";

export default serve(coder, ({ OPENAI_KEY, ANTHROPIC_KEY, REDIS_URL, JWKS_URL }) => ({
  models: [
    openai({ key: OPENAI_KEY }),
    anthropic({ key: ANTHROPIC_KEY }),
  ],
  storage: redis({ url: REDIS_URL }),
  auth: jwt({ jwks: JWKS_URL }),
  limits: { duration: 120_000, calls: 10, afterResponse: 30_000 },
  report: (record) => console.log(JSON.stringify(record)),
}));
```

Every time is in milliseconds and every size in bytes. A request body is at most `limits.body`,
32 MB unless stated, and has the edge's `receive` to arrive, 60 000 unless stated in the third
argument beside `keepAlive` and `drain`: `serve(coder, options, { receive: 30_000 })`. Every limit
and every time of the edge is checked when the host is made. Every reply to a request that was
let in carries the id of its report, in `x-request-id` on the two OpenAI APIs and in `request-id`
on Messages.

In development, start the serve file with `bun --watch src/serve.ts`, the examples'
`bun run dev`. Bun starts the process again on the same port whenever the motty or a file it
imports changes, so the next request is answered by the new code, about 0.1 to 0.3 s later. An
edit that does not load prints its error and leaves nothing listening until the file is fixed,
when the server comes back by itself. This is for development only: a restart does not drain, and
a request in flight is cut off, so a deployed host runs the serve file plainly.

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
