# @mottyjs/decision

A plugin of the Motty SDK. A decision model answers typed questions about a text with
probabilities, where a chat model would have to be asked for prose and parsed. `decision(name)`
names one, and `choice`, `score` and `noul` are the questions it is asked.

```sh
bun add @mottyjs/decision
```

```ts
import { choice, decision, noul, score } from "@mottyjs/decision";
```

Judging whether the opening of a thread is on topic, and letting the request through when the
decision model is down:

```ts
import { decision, noul } from "@mottyjs/decision";

const jev = decision("typesafe/jev-latest");

export async function isOnTopic(opening: string, onTopicProbability: number): Promise<boolean> {
  try {
    const { software } = await jev.decide(opening, {
      software: noul({ instructions: "Is this a request about software or a codebase?" }),
    });
    return software.noul >= onTopicProbability;
  } catch {
    return true;
  }
}
```

The SDK as a whole is described in the
[root README](https://github.com/skrrt-sh/motty-sdk#readme), and the reasons behind its design in
[ARCHITECTURE.md](https://github.com/skrrt-sh/motty-sdk/blob/main/ARCHITECTURE.md).
