# @mottyjs/store

A plugin of the Motty SDK. A motty is stateless by default; what must survive a request goes
through `store`: `get`, `set`, `delete` and `increment` over whatever storage the host supplies.
The host puts the motty's name ahead of every key.

```ts
import { store } from "@mottyjs/store";
```

Remembering which tier answered a conversation, for a day:

```ts
import type { ChatRequest } from "@mottyjs/core";
import { store } from "@mottyjs/store";

type Tier = "quick" | "standard" | "deep";

function tierKey(request: ChatRequest): string | undefined {
  const conversation = request.headers.get("x-conversation-id");
  return conversation ? `tier:${conversation}` : undefined;
}

export async function previousTier(request: ChatRequest): Promise<Tier | undefined> {
  const key = tierKey(request);
  return key ? store.get<Tier>(key) : undefined;
}

export async function remember(request: ChatRequest, tier: Tier): Promise<void> {
  const key = tierKey(request);
  if (key) await store.set(key, tier, { ttl: 24 * 60 * 60 });
}
```

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
