# @mottyjs/test

The test kit of the Motty SDK, used with the author's own test runner. `fake` and `on` script the
models, `memory` is storage for a test, and `run` is the whole lifecycle of a request without the
wire. Cases, tables and coverage stay with the runner.

```ts
import { fake, memory, on, run } from "@mottyjs/test";
```

A request answered by a scripted model:

```ts
import { expect, test } from "bun:test";
import { model, motty } from "@mottyjs/core";
import { fake, on, run } from "@mottyjs/test";

const mini = model("openai/gpt-5-mini");

const relay = motty({ name: "relay" }).handle(({ prompt }) => mini.complete(prompt));

test("a question is answered by the small model", async () => {
  const models = fake(on(mini, "quick reply"));

  const { answer } = await run(
    relay,
    { text: "What does git stash do?" },
    { models: [models] },
  );

  expect(await answer.text()).toBe("quick reply");
});
```

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
