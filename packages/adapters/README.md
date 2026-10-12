# @mottyjs/adapters

The adapters of the Motty SDK: plain objects a host passes in its host options, one import path
each. Model providers: `openai`, `anthropic`, `openrouter`, `deepseek`, `moonshot`, `zai`,
`dashscope`, `minimax`, `groq`, `mistral`, `together`, `fireworks`, `ollama`, `local` and
`typesafe`. Storage: `redis`. Auth: `jwt` and `bearer`, or an object of the host's own. A
credential stays inside the adapter the host made and never enters a motty's code. This package is
never in a motty's bundle.

```sh
bun add @mottyjs/adapters
```

```ts
import { openai } from "@mottyjs/adapters/openai";
```

The adapters of a serve file:

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

A connection takes `headers` for every request it makes and `body` fields in the provider's own
names. A call may state headers of its own in its options, for a harness whose headers an upstream
expects. Sending on a caller's is one line in the motty:

```ts
import { model, motty } from "@mottyjs/core";

export default motty({ name: "relay" }).handle(({ request, prompt }) => {
  prompt.options = { ...prompt.options, headers: Object.fromEntries(request.headers) };
  return model("anthropic/claude-sonnet").complete(prompt);
});
```

The connection's headers and the credential always win over a call's of the same name. Headers of
the connection itself, credentials and cookies, headers that say where a request came from, and
headers that describe the caller's body are never sent. Whatever else the caller sent reaches the
model provider, a token for another service included, so send on only what the upstream needs.

`jwt` verifies a signed token against exactly one of a key set address (`jwks`), a public key in
PEM (`key`) or a shared secret (`secret`), and gives its `sub` as the caller's id. By default it
checks the signature and the times the token itself states, and a token that states no expiry is
accepted. Every further check is the host's to add: beside the way of verifying, `jwt` takes the
options of `jose`'s `jwtVerify`, all optional. A host whose identity provider signs tokens for
several applications with one key set should name the issuer and the audience:

```ts
jwt({
  jwks: JWKS_URL,
  issuer: "https://id.acme.example/",
  audience: "desk",
  requiredClaims: ["exp"],
  clockTolerance: 30,
});
```

`bearer`, from the same import path, takes one plain secret and gives the caller the id the host
named, for a service that holds a long-lived credential:

```ts
import { bearer } from "@mottyjs/adapters/jwt";

bearer({ secret: OPS_TOKEN, id: "ops" });
```

Both are conveniences. Auth is the host's own to write: the `auth` option takes any object with a
`verify` function, which is given the token the caller sent and returns the caller, or `undefined`
for nobody, at once or as a promise. A lookup of an API key in the host's own table, here its
`ownerOf`:

```ts
import { ownerOf } from "./keys";

export default serve(desk, ({ OPENAI_KEY }) => ({
  models: [openai({ key: OPENAI_KEY })],
  auth: {
    verify: async (token) => {
      const owner = await ownerOf(token);
      return owner === undefined ? undefined : { id: owner };
    },
  },
}));
```

How far each model provider's adapter is proven differs. `openai`, `anthropic`, `openrouter` and
`typesafe` are proven against the live API, by tests that make real calls and run under
`bun run test:live`. The others are proven only against stubs written from each provider's own
documents; `mistral`, `together` and `fireworks` have a live test that runs once that provider's
key is set.

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
