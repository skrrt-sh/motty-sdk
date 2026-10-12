# fleet

Runs a coding agent's whole fleet of subagents through one motty. The host sees what each agent
spends, sends the subagents to a small model and closes the work of a subagent once its session has
spent its budget. This page follows one request through the motty.

## The whole request

Claude Code and Codex both work, and neither needs a plugin or a setting of its own beyond the
address of the motty. Each of them says on every request which session it belongs to and whether it
is the lead or a subagent, and that is all the motty reads.

```mermaid
flowchart TD
  request([Request]) --> seat{"seat<br/>which agent sent it?"}
  seat -- "Codex: OpenAI family<br/>its own thread inside the session is a subagent" --> brake
  seat -- "Claude Code: Anthropic family<br/>an agent id is a subagent" --> brake
  seat -- "neither: not an agent" --> board(["The board, as an ordinary reply"])

  brake{"brake<br/>a subagent, and the budget is spent?"}
  brake -- yes --> closed(["The family's small model closes the work<br/>with its tools forbidden, from what was read so far"])
  brake -- no --> kind{"a subagent, and scouts are small?"}

  kind -- yes --> scout["scout: the family's small model"]
  kind -- no --> asked["asked: the model the agent named"]

  scout --> answer([Answer])
  asked --> answer
  closed --> ledger
  answer --> ledger["ledger, after the response<br/>adds the request and its cost to the seat's row"]
```

- An agent stays on its own family. Codex is answered by OpenAI models and Claude Code by Anthropic
  ones, because each sends options that only its own family takes.
- A Codex subagent is known by a thread of its own inside the lead's session, whatever model name
  Codex was started with. Nothing is decided by the tools a request declares, since Codex does not
  always declare them where a motty would see them.
- An agent started under the motty's own name asked for no model, so the lead model of its family
  answers. That is `gpt-6.1-sol` for Codex and `claude-opus-5-5` for Claude Code.
- A subagent past the budget is not cut off. The small model writes its report from what the
  subagent has read, so the lead still gets an answer and can finish. The lead is never stopped.
- The closing request keeps the tools the subagent declared and forbids their use. Anthropic
  refuses a conversation of tool calls that declares no tools, and OpenAI accepts either form.
- The ledger runs after the response, so it adds no time to an answer.
- The budget belongs to one agent session, which is a lead and its subagents. It is checked before
  a call and charged after the response, so subagents running in parallel can each pass the check
  and the total can overshoot. With a budget of 0.1, five subagents that asked at once and cost 0.5
  each ended at 2.5.
- A model with no rate of its own is charged at the rate of its family's lead model, so nothing an
  agent names is free.

## The board

Anyone who asks the same address without being an agent gets the board as the reply, so a plain
chat request shows the fleet while it works. The board below is put together from the rows of
several real runs, so that it shows both markers at once. No single run printed it.

```text
lead        gpt-6.1-sol         7 req   $0.070  Spawn three subagents in parallel, one per file (orders.ts, payments.…
sub b644a7  gpt-6-luna          2 req   $0.002  Read only orders.ts and summarize what it does in exactly one sentenc…
sub 5c1257  gpt-6-luna          2 req   $0.001  1 FAILED Read only users.ts and summarize what it does in exactly one…
sub f65a01  gpt-6-luna          2 req   $0.001  STOPPED Read only payments.ts and summarize what it does in exactly o…
spent $0.073 of $1.000
```

- A row is a seat, the lead or one subagent, in the order the seats were first seen. It names the
  model that answered first, the requests made, what they cost and the task as the agent put it.
- The board shows every session still alive, each with its rows and its own `spent` line under
  them. A session's rows and its budget are kept for a day from its first request and are gone
  after that, whatever storage the host has.
- `FAILED` with a count marks a seat whose requests were refused or failed, so a call that spent
  nothing is still on the board.
- `STOPPED` marks a subagent that the brake closed.
- Codex under a model name it knows starts a subagent from the lead's conversation and hides the
  subagent's own task from the motty. The row of such a subagent shows the last thing the lead's
  conversation said, which is the lead's task or the notes Codex adds about the working directory.

## Running it

The first result needs no key. The tests run every branch above with scripted models.

```sh
bun test examples/fleet/test
```

The board needs no real key either, since asking for it calls no model. Start the host with two
placeholders and ask it from a second terminal.

```sh
OPENAI_KEY=none ANTHROPIC_KEY=none bun examples/fleet/src/serve.ts
bun examples/fleet/demo/board.ts
```

A real run needs three things.

1. The host reads `OPENAI_KEY` and `ANTHROPIC_KEY`, which are not the `OPENAI_API_KEY` and
   `ANTHROPIC_API_KEY` most people have exported. Bun reads them from a `.env` in the directory it
   is started from, which is the repository root for the commands on this page.
2. An agent, either the `claude` or the `codex` command.
3. Port 3000 is free, or `PORT` names another one.

```sh
bun examples/fleet/src/serve.ts
```

Claude Code needs only the address and a key that is no key. The `ANTHROPIC_API_KEY` here is for
the agent, which will not start without one, and the host never reads it.

```sh
ANTHROPIC_BASE_URL=http://localhost:3000 ANTHROPIC_API_KEY=not-a-key \
  claude --print "Understand this repo. Use one subagent per module, in parallel."
```

Codex takes the motty as a provider, under a model name it knows or under `fleet`.

```sh
FLEET_KEY=not-a-key codex exec -m gpt-6.1-sol \
  -c 'model_provider="fleet"' \
  -c 'model_providers.fleet={name="fleet",base_url="http://localhost:3000/v1",env_key="FLEET_KEY",wire_api="responses"}' \
  "Understand this repo. Use one subagent per module, in parallel."
```

In a second pane `sh examples/fleet/demo/board.sh` asks for the board once a second. It takes the
URL of the host as its argument when that is not `http://localhost:3000`.

The demo does all of this in one process against a small temporary repository and prints the board
as it changes. Its arguments are positional and each has a default, so the two commands below do
the same.

```sh
bun examples/fleet/demo/demo.ts
bun examples/fleet/demo/demo.ts small 1 claude fleet
```

| Argument | Values                                           | Default  |
| -------- | ------------------------------------------------ | -------- |
| scouts   | `small`, or `asked` to only watch                | `small`  |
| budget   | what a session may spend, in USD                 | `1`      |
| agent    | `claude` or `codex`                              | `claude` |
| model    | the model name Codex is started with             | `fleet`  |

Claude Code turns on beta features in a header of Anthropic's own, and such a header travels on to
Anthropic with the body it describes, so an account without that beta may refuse the request. That
is the account's answer, not the motty's.

The host has no `auth`, because it is meant for localhost. The headers that tell a lead from a
subagent and one session from another are the caller's own word, so anyone who reaches the address
can spend the host's keys, and it must not be exposed as it is.

## Changing the numbers

`BUDGET=5` sets what one session may spend in USD, and the default is 1. A value that is no amount
stops the host as it starts. With `SCOUTS=asked` each subagent stays on the model its agent asked
for, so the motty only watches.

A cost is what the host's `price` makes of the tokens a call reported. Its rates are this host's own
example figures in US dollars per million tokens, not a price list the SDK ships, so put your own
there before trusting a total. The host keeps its state in its own process, so the board is empty
again after a restart.

The one eval has the real small model close a stopped subagent's work and is skipped without a key.
Its file does not end in `.test.ts`, so a plain `bun test` makes no paid call, and `bun run eval`
runs it.
