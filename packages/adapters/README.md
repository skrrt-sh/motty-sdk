# @mottyjs/adapters

The adapters of the Motty SDK: plain objects a host passes in its host options, one import path
each. Model providers: `openai`, `anthropic`, `openrouter`, `deepseek`, `moonshot`, `zai`,
`dashscope`, `minimax`, `groq`, `mistral`, `together`, `fireworks`, `ollama`, `local` and
`typesafe`. Storage: `redis`. Auth: `jwt`. A credential stays inside the adapter the host made and
never enters a motty's code. This package is never in a motty's bundle.

```ts
import { openai } from "@mottyjs/adapters/openai";
```

The adapters of a serve file. Which providers are proven against the live API is listed in the
root README:

```ts
import { serve } from "@mottyjs/serve";
import { jwt } from "@mottyjs/adapters/jwt";
import { openai } from "@mottyjs/adapters/openai";
import { openrouter } from "@mottyjs/adapters/openrouter";
import { redis } from "@mottyjs/adapters/redis";
import desk from "./motty";

export default serve(desk, ({ OPENAI_KEY, OPENROUTER_KEY, REDIS_URL, JWKS_URL }) => ({
  models: [
    openai({ key: OPENAI_KEY }),
    // A customer's message goes through a router only to providers that keep none of it
    openrouter({ key: OPENROUTER_KEY, body: { provider: { data_collection: "deny" } } }),
  ],
  storage: redis({ url: REDIS_URL }),
  auth: jwt({ jwks: JWKS_URL }),
}));
```

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
