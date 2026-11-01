# @mottyjs/settings

A plugin of the Motty SDK. `settings(groups)` defines a motty's settings in code, each group a
schema whose every value has a default. A part that uses them reads them typed from the context,
and a host may override any subset. A bad override fails at start, though one an async schema
refuses is only written to stderr, as a mount returns at once.

A schema is any Standard Schema validator. The example uses zod, which this package does not
install:

```sh
bun add @mottyjs/settings zod
```

```ts
import { settings, type Settings } from "@mottyjs/settings";
```

Two groups defined with zod, and a part that reads one of them:

```ts
import { motty } from "@mottyjs/core";
import { settings, type Settings } from "@mottyjs/settings";
import { z } from "zod";

const probability = z.number().min(0).max(1);

export const tuning = settings({
  offTopic: z.object({
    onTopicProbability: probability.default(0.1),
  }),
  structured: z.object({
    smallProbability: probability.default(0.7),
  }),
});

export type Tuning = Settings<typeof tuning>;

export const offTopic = motty({ name: "off-topic" })
  .use(tuning)
  .beforeHandle(({ settings }) => {
    console.log(settings.offTopic.onTopicProbability);
  });
```

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
