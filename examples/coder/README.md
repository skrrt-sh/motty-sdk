# coder

Sends coding-agent requests to the cheapest model that can handle them. This page follows one
request through the motty; the rules behind each step are in
[ARCHITECTURE.md](../../ARCHITECTURE.md).

## The whole request

The root in `src/motty.ts` uses five parts. Four are gates that run first: `auth`, `empty-prompt`,
`off-topic` and `compaction`. The request then goes to one of two modules by whether the caller
asked for JSON, and the fifth, `hidden-reasoning`, runs on the answer.

```mermaid
flowchart TD
  request([Chat request]) --> auth{"auth<br/>host identifies the caller?"}
  auth -- no --> rejected(["Error: unauthenticated, 401"])
  auth -- "yes: caller.id on the context" --> empty{"empty-prompt<br/>any messages?"}
  empty -- no --> emptyError(["Error: empty_prompt, 400"])
  empty -- yes --> opening{"off-topic<br/>first turn of the thread?"}

  opening -- "no, an assistant already replied" --> long
  opening -- yes --> topic{"jev: about software?<br/>probability >= 0.1"}
  topic -- "yes, or jev is down" --> long
  topic -- no --> canned(["Canned reply, no route<br/>later hooks do not run"])

  long{"compaction<br/>more than 80 messages?"}
  long -- no --> kind
  long -- yes --> older{"any turns before<br/>the kept tail?"}
  older -- "no: left as it is" --> kind
  older -- yes --> summarise["mini summarises the older turns<br/>prompt = system + summary + last turns"]
  summarise --> kind

  kind{"request.output set?"}
  kind -- "yes: structured" --> structured[[structured module]]
  kind -- "no: chat" --> tiers[[tiers module]]

  structured --> strip
  tiers --> strip
  strip["hidden-reasoning<br/>drops reasoning chunks from the answer"] --> sent([Answer sent to the caller])
  sent --> remember["tiers only: remember the tier that answered"]
```

- `auth` holds no check of its own. The host's adapter proves the caller: `jwt` in `src/serve.ts`
  here. When the host gives none, the request is rejected as unauthenticated.
- The gates change `prompt` or end the request; `request` stays as the caller sent it.
- An off-topic refusal is an ordinary reply, not an error, because an agent shows an error as a
  failure of its own.
- The summary keeps the system message and a tail that starts at a user message, so a tool result
  is never separated from its call.
- `hidden-reasoning` removes the answering model's reasoning only. Progress sent with `think` is
  not part of the answer and still reaches the caller.

## Chat: the tiers module

`src/modules/tiers` picks one of three tiers. Cheap rules run first, the decision model only when
none of them applies, and a conversation never moves to a weaker tier than it already reached.

```mermaid
flowchart TD
  start([chat]) --> previous["derive: previous tier of this conversation<br/>store key: tier: + the x-conversation-id header's value"]
  previous --> fast{"model name ends with :fast?"}
  fast -- yes --> pickedQuick[picked: quick]
  fast -- no --> max{"model name ends with :max?"}
  max -- yes --> pickedDeep[picked: deep]
  max -- no --> short{"no tools and question<br/>under 400 chars?"}
  short -- yes --> pickedQuick
  short -- no --> classify{"jev: how much reasoning<br/>does this need?"}
  classify -- "deep probability >= 0.35" --> pickedDeep
  classify -- "otherwise: jev's own pick" --> pickedAny[picked: quick, standard or deep]
  classify -- "jev is down" --> pickedStandard[picked: standard]

  pickedQuick --> strongest
  pickedDeep --> strongest
  pickedAny --> strongest
  pickedStandard --> strongest
  strongest{"stronger of picked and previous<br/>think: Answering with the X tier"}

  strongest -- quick --> quick["race: mini, haiku"]
  strongest -- standard --> standard["fallback: sonnet retried twice, then gpt"]
  strongest -- deep --> plan

  subgraph deep [deep module]
    plan["sonnet outlines a plan, shown to the caller as reasoning<br/>plan appended to prompt; skipped if sonnet is down"]
    plan --> effort[reasoning effort: high]
    effort --> strong["fallback: opus with 20 s to the first chunk, then gpt"]
  end

  quick -- "both down: reroute" --> standard
  strong -- "anything in deep throws: reroute" --> standard

  quick --> answer([Answer])
  standard --> answer
  strong --> answer
  standard -- "both down" --> failed([Request fails])

  answer --> after{"afterResponse<br/>completed and has a conversation id?"}
  after -- yes --> save["store the tier that answered, for 24 h"]
  after -- no --> nothing([Nothing stored])
```

- Staying on the stronger tier keeps the provider's prompt cache, which a move to a cheaper model
  mid-conversation would throw away.
- The deep threshold is low on purpose: a weak answer to a hard request costs more than a strong
  answer to an easy one.
- After a reroute, `route` is the entry that answered, so that is the tier remembered.

## JSON: the structured module

`src/modules/structured` answers requests that carry an output schema. They never reach the tier
choice.

```mermaid
flowchart TD
  start([structured]) --> size{"jev: can a small model fill<br/>this JSON without reasoning?"}
  size -- "probability >= 0.7" --> small["mini answers"]
  size -- "lower, or jev is down" --> strong["fallback: sonnet retried twice, then gpt"]

  small --> valid{"reply parses<br/>as JSON?"}
  valid -- yes --> answer([Answer])
  valid -- "no, or mini failed: reroute" --> strong
  strong --> answer
```

- The small reply is read before any of it is sent, so one that was cut off is answered again by
  the strong model instead of reaching the caller's parser.

## Where the numbers come from

Every threshold above is a default in `src/settings.ts`, and the host may override it in
`src/serve.ts`, except the retry count, which is fixed in the code. The models are named in
`src/models.ts`; `jev` is the decision model.
