# @mottyjs/serve

The host side of the Motty SDK. `serve(motty, options)` is for a serve file, whose default export
Bun starts; `mount(motty, options)` returns `fetch` and `close` for a host that has a server of
its own, on Bun, Node 22 and later, Deno or Cloudflare Workers. Both serve the motty as a model
over the Chat Completions, Responses and Messages APIs. This package is never in a motty's
bundle.

```sh
bun add @mottyjs/serve
```

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

## Hosting anywhere

`mount` takes the same options as the serve file above, a function of the environment. On
Workers the environment holds the Worker's bindings once `nodejs_compat` is on and the
compatibility date is 2025-04-01 or later; with an older date it is empty.

On Cloudflare Workers a mount is the module's default export. The third argument of `fetch` has
the shape of a Workers execution context, so every record is waited for through
`ctx.waitUntil` with no code of the host's. Turn on the `nodejs_compat` and
`enable_request_signal` flags, the second so that a caller who leaves is noticed. A bundler other
than Wrangler must leave `node:*` imports external.

```ts
export default mount(coder, options);
```

On Deno, pass the mount's `fetch` to the server. Deno 2.9 prints a warning about legacy aborts,
which leaves the records as they are; `--unstable-no-legacy-abort` silences it.

```ts
Deno.serve(mount(coder, options).fetch);
```

On Node, `node:http` hands the mount a web request and streams its reply back. A host that
prefers a library can use `@hono/node-server` instead.

```ts
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mount } from "@mottyjs/serve";

const { fetch } = mount(coder, options);

createServer(async (incoming, outgoing) => {
  const left = new AbortController();
  outgoing.on("close", () => outgoing.writableFinished || left.abort());
  const bodiless = incoming.method === "GET" || incoming.method === "HEAD";
  const reply = await fetch(
    new Request(`http://${incoming.headers.host}${incoming.url}`, {
      method: incoming.method,
      headers: Object.entries(incoming.headersDistinct).flatMap(([name, values = []]) =>
        values.map((value) => [name, value]),
      ),
      body: bodiless ? null : Readable.toWeb(incoming),
      signal: left.signal,
      duplex: "half",
    }),
  );
  outgoing.writeHead(reply.status, [...reply.headers].flat());
  if (reply.body === null) outgoing.end();
  else Readable.fromWeb(reply.body).pipe(outgoing);
}).listen(3000);
```

A host that has already authenticated and numbered a request states both in the third argument,
`fetch(request, undefined, { id, caller, waitUntil })`, and the auth adapter is not asked. The
`namespace` option prefixes every stored key in place of the motty's name, so two motties of one
name keep apart. `report` may return a promise, and the record is waited for until it settles.

A caller of the Responses API through the AI SDK sets `providerOptions.openai.store` to `false`,
since a motty holds no Responses state on the server and refuses an `item_reference`.

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
