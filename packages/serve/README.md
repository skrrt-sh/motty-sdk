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

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
