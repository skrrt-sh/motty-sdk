# @mottyjs/auth

A plugin of the Motty SDK. `auth()` is a part that puts the caller on the context and rejects a
request the host could not identify. It holds no check of its own: the host's auth adapter proves
the caller, and the key or token that proved it never reaches the motty.

```ts
import { auth } from "@mottyjs/auth";
```

A gate that refuses a caller who has spent the day's limit:

```ts
import { motty, QuotaExceeded } from "@mottyjs/core";
import { auth } from "@mottyjs/auth";
import { store } from "@mottyjs/store";

// The day is part of the key, so a new day starts at nothing and no reset has to run
const spendKey = (callerId: string) =>
  `spend:${callerId}:${new Date().toISOString().slice(0, 10)}`;

export const dailyLimit = motty({ name: "daily-limit" })
  .use(auth())
  .beforeHandle(async ({ caller }) => {
    if (((await store.get<number>(spendKey(caller.id))) ?? 0) >= 5) {
      throw new QuotaExceeded("Today's limit of $5 is spent");
    }
  });
```

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
