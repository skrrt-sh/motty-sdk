# Motty SDK — Architecture

## What a motty is

A motty is a layer-2 model. LLMs are layer 1, and a motty is a model made of code on top of them
and below agents. To its caller it is just another model, a chat request in and an answer out,
and an agent does not know it is calling one. Inside, it is plain code that holds the whole
request and may do anything before it answers. It has no weights. The SDK is the open-source
toolkit for building motties; the Hub is a service that hosts and sells them.

- **It is a toolkit, not a list of features.** A router, a gateway, a cache, a fallback or a
  memory that agents share is each a motty's own code over the same few abilities: reading the
  request, calling models, answering by hand, changing the prompt and the answer, `store` and
  `fetch`.
- **It fits the stack that is already there.** Above it, a caller changes the URL and the model
  name. Below it, the same providers are called, through adapters.
- **It takes what surrounds a model call, and the agent keeps its loop and its tools.** That is
  the choice of model, several models answering as one, what outlives a request, and what is
  changed on the way in and out. Rejected: running the caller's tools, which makes a motty a
  second agent.
- **A gateway is one thing a motty can be.** Served with the host's auth, limits and record it
  is one; it also goes behind a gateway as a model, or in front of one as its upstream. What
  differs from a gateway product is that the logic is the code itself, not config with code as a
  plugin, and that the code is built apart from whatever runs it.
- **Not a backend framework.** It serves one kind of endpoint, a model, with no general routes
  and no ORM.
- **Not an agent framework.** No agent loop, tool runner or retrieval pipeline. A motty is plain
  code with `store`, `fetch` and the caller's identity, so retrieval is a hook, not a framework.
- **Not an MCP server or client.** The SDK speaks no MCP. MCP gives an agent tools that it
  chooses to call. A motty is the model the agent calls, so it sees every request. Tools that
  come from MCP servers arrive as plain function tools, and a tool the provider runs is carried
  whole to an upstream of the same family.

## Principles

- **A motty looks like a model.** A caller changes the URL and the model name, and keeps its format.
- **Real logic, in plain code.** Having to go around the SDK to call a model is an SDK gap.
- **One way to do each thing.** The whole API fits on one page, and a new name has to earn a place.
- **Only what is imported ends up in the bundle.** The core is one import, not a mandatory payload.
- **Same code on the Hub and self-hosted.** The host supplies four services: models, storage,
  identity, setting overrides. It also controls the request: a stop signal, limits, and a function
  that receives the record. A plugin, ours or anyone's, reaches the host through one import path of
  the core made for that.
- **Stateless by default.** What must survive a request goes through `store` or an outside database.
- **Strictly typed, without ceremony.** Types are inferred, and a type error reads as a plain list.
- **Small and fast, and measured.** What the SDK adds in size, type-check time and time per call is
  measured on every change, and a feature that slows generation or grows the bundle is removed.
  The limits themselves are the host's.
- **Mistakes fail early and loudly:** a bad route name or an unknown setting in the types, a bad
  override when the host supplies it.
- **An option the SDK does not know still reaches the model** or fails the call. Only an option
  marked as a hint may be left out.
- **No provider quirks in the core, no runtime ties in a bundle:** adapters and `serve` hold them.
- **The document and the example come first.** Nothing else is built. The reference example, the
  coding router in the examples folder, is the one acceptance test: buildable with no workarounds.

## Vocabulary

- **Part**: a motty used by another. **Middleware**: a part with only hooks. **Module**: a part that
  routes or handles. **Plugin**: a package built on the core, a part or functions a hook calls.
  **Import**: an SDK import path.
- **Entry**: a named item of a route table. **Chooser**: the function passed first to `.route`.
- **Host**: whoever runs a motty, `serve` or the Hub. **Host options**: what `serve`, `mount` and
  the test `run` take. **Edge**: the host's wire side, which writes the caller's stream.
- **Settings**: only the values declared with `settings()`. **Caller**: whoever sends the request.
- **Assembled**: flattened into one chain, once, before the first request. **Bundle**: the one
  file a build produces. **Record**: the facts of one request, given to the host when it is over.
- **Family**: the providers that speak one wire format.

## Core

The first deliverable and one package: all a motty needs to work and a plugin needs to be written.

### The building block

```ts
export const tiers = motty({ name: "tiers" })
  .use(tuning)
  .derive(async ({ request }) => ({ previous: await previousTier(request) }))
  .route(({ request, settings, previous }) => tierOf(request, settings.tiers, previous), {
    // A quick question still gets an answer when both small models are down
    quick: ({ prompt }) => quick(prompt).catch(() => reroute("standard")),
    standard: ({ prompt }) => standard(prompt),
    // Both strong models down is no reason to fail a request the standard tier can answer
    deep: deep.catch(() => reroute("standard")),
  })
  .afterResponse(async ({ request, route, outcome, settings }) => {
    if (outcome === "completed") await remember(request, route, settings.tiers);
  });

export default motty({ name: "coder" })
  .use(auth())
  .use(emptyPrompt)
  .use(offTopic)
  .use(compaction)
  .use(hiddenReasoning)
  // A request for JSON is not a coding task, so it never reaches the tier choice
  .route(({ request }) => (request.output ? "structured" : "chat"), {
    structured,
    chat: tiers,
  });
```

- **One building block, `motty()`.** No router, plugin class or sub-app type; `settings()` and
  `auth()` return motties made with it. Rejected: a separate `flow()` builder, the same thing twice.
- **Named hooks, not wrappers.** Rejected: steps shaped `(ctx, next)`. Fixed phases say when code
  runs and what it sees; a wrapper hides both, and cannot run after the caller left.
- **Functions, not classes.** Logic is plain functions taking the data they need, never the whole
  context, whose inferred type is lost outside the chain. Rejected: a base class and service
  classes; request state has no place on an instance. Errors are the one exception: they are
  classes so that `instanceof` works.
- **A motty is fixed once built.** Loading awaits nothing and reads no network or settings;
  configuration arrives with the request. So a motty can be described at load and cold starts stay
  fast.
- **Every builder method returns a new motty,** so sharing a part never affects its other users.
- **A part is identified by its `name` and an optional `seed`.** The same name and seed is one part,
  applied once on a path, as in Elysia; a part made by a function passes the arguments that change
  it as the seed. `name` labels it in the report; the root's is the default `store` namespace.
  Two different parts grown from one `motty()` call with one name and seed fail at load. Two made
  apart cannot be told from one function called twice: the first reached is applied, and whoever
  uses the other reads the first's values. A part's name must be its own. Rejected: an error at
  load, which would refuse one part function used twice.
- **Types come from the chain.** Each `.derive` and used part changes the type seen after it.
- **A `derive` cannot take a name the chain already has,** which the types refuse; a name any
  member of a union result takes counts as taken. Past the types, a chain's own derive that
  names a value its lifecycle already made fails the request, named by the value. A used part
  may still replace an earlier value. Cause: a parent that derived a shared part's value again
  handed a nested motty, typed by that part, another value. Not closed: the same derive inside
  a used part, and a second used part that derives the same name.
- **A derived value needs a known name.** A result typed as a map of any names is refused by
  the types: such a map goes under one name.

### Lifecycle

1. **Before routing.** `.derive(fn)` adds typed values. `.beforeHandle(fn)` throws to reject,
   changes `prompt`, returns an `Answer` to reply at once, or returns nothing to continue.
2. **Answering.** `.route(chooser, table)` or `.handle(fn)`. The chooser may be async and call a
   model or `think`; it names the entry: a handler giving an `Answer` or a reroute, or a motty.
3. **Before sending.** `.afterHandle(fn)` runs only if there is an answer, and may assign `answer`.
4. **After the answer.** `.afterResponse(fn)` runs once the caller has it all, and sees `calls`.
5. **`.onError(fn)`**, outside the phases, is a boundary: it gets what was thrown inside its motty
   and not caught nearer, with the context, and may return an `Answer`.

- **A motty answers in exactly one way.** One `.route` or `.handle`, its own or a part's. Routed
  motties combine by nesting, not `.use`. Rejected: `.branch(pick, arms)` anywhere in a chain: no
  single place to read where a request went.
- **The chain reads in lifecycle order.** Hooks run as registered, a part's at its `.use`. Only
  after hooks follow `.route`, `.handle`, or a `.use` that brings a route.
- **A hook may answer early:** a cache hit, a canned reply, a refusal. The before hooks, the
  answering step and the `afterHandle` hooks registered after it are skipped; `afterHandle` hooks
  registered before it run. Rejected: a router wrapped around the motty per case, which nested
  the root and put each case in the route path.
- **`afterResponse` runs for every outcome:** `"completed"`, `"aborted"`, `"failed"`. After
  `.route`, `route` and `answer` are present when completed, else optional; narrowing on
  `outcome` types the route by the table. In a part used earlier it is a plain string, absent
  when no entry answered.
- **When `onError` returns an answer, it counts as an early answer from the step that threw.**
  When nothing recovers, `afterResponse` still runs, with `"failed"`.
- **An `afterResponse` is not run only when a `derive` or the `.route` its own chain has before
  it, the parts that chain uses included, made nothing:** the steps that make the values the
  hook is typed to read. A parent's or a sibling's `derive` does not count. A `beforeHandle`
  makes none, so a part's own early answer keeps its later `afterResponse`, and a hook after
  `.handle` runs on an early answer; a hook after `.route` is not run when no entry answered.
  Cause: the cut was the hook's own place, so accounting registered after an early answer was
  lost, which no comparable framework does; and with the place taken across the whole
  flattened lifecycle, a part that only logs, used after its parent's `derive`, was not run on
  an early answer though it reads nothing that `derive` made. Rejected: running every
  `afterResponse` of a motty that was entered, which hands a completed hook values no step
  made.
- **Recovering a thrown `afterHandle` keeps `route` and `path` on the context.** The entry did
  answer; only the path given back and recorded is empty. Cause: the recovery cleared them for
  every hook, so a completed `afterResponse` after `.route` read undefined where its type
  promised the entry.
- **A failure in after-response work reaches no boundary.** The caller already has the answer, so
  the failure goes in the record.
- **Ending early.** A caller leaving or the host's time limit fires `signal`: `"aborted"`. Passing
  `limits.calls` throws `LimitReached`. After-response work has `limits.afterResponse` for its
  time, and its calls still count against `limits.calls`.
- **After-response work is limited to thirty seconds unless the host sets another limit.**
  Rejected: no limit by default. One hook that never returned then meant no record was ever sent.

### Routing

- **A handler may reroute.** `reroute(name)` hands the request, `prompt` as it stands, to that
  entry: after a failure, or an answer read and found weak. `route` is the entry that answered.
- **A reroute name is typed by its table,** also inside a handler's `.catch(...)`. So is the
  chooser's result.
- **`path` tells nested routes apart.** `route` is one level; `path` is every entry from the root
  down, a typed tuple such as `["chat", "deep"]`, and counts are kept by it. After hooks always have
  it, empty when no entry ran: the request was answered before routing. Rejected: prefixing route
  names with the motty's `name`: two names for an entry, two identities for a shared part.
- **Routes nest to any depth, and a reroute stays in its own table.** Rejected: a reroute by path
  from a nested motty, assembled before the tables it goes into, so the names could not be checked.
- **A motty entry runs its whole lifecycle inside the parent's:** its before hooks after the
  parent's chooser, its after hooks before the parent's. Its early answer ends only itself.
- **`.catch(recover)` is a boundary around one entry,** placed by the parent on a nested motty, so
  its fallback may also be a reroute typed by the parent's table. `onError` covers a whole motty.
- **`recover` gets what was thrown and the parent's context, and passes the error on by
  returning nothing,** as `onError` does. The context is the parent's: what the entry derived
  ended with it. Cause: a boundary that handled one error class had to throw the rest again by
  hand, and could read neither the request nor `calls` to decide.
- **A module reads a parent's value by using the part that derives it.** A part is run once per
  request wherever it is used, so the module gets the value by type and the work is not repeated.
  A value the parent derives in its own chain is made a part to be shared. Rejected: a module
  that declares what it expects of its parent, or a third accumulator in the chain's type, for
  what a part already says: about 60% more type work on a chain with no children.
- **A module's changes to `prompt` stay inside it.** If it fails and its parent reroutes, the next
  entry gets the prompt as the parent had it.
- **Shared logic is a function, not a route.** Entries that reroute to each other share one table.
- **An entry runs once per request.** A reroute to one that already ran throws `RouteLoop`.
- **A module is never called like a model.** Rejected: `deep.complete(prompt)` in a handler, a
  second way to run a module, with `route` naming an entry that did not answer. Also rejected: a
  chooser returning an ordered list of names, which covers a failure but not an answer read first.

### The context and interruption

The context is data: read-only `request` (id, model, messages, tools, options, output schema,
headers), mutable `prompt` sent upstream, `signal`, derived values, `calls` from the start, then
`route`, `path`, `answer`, `outcome`.

- **Models, `store` and `think` are imported, not carried.** The async context finds the request.
- **A derived value never takes a name the context owns.** The types refuse it; if a cast hides it
  from the compiler, the request fails.
- **A motty answers to any model name.** The name asked for is a signal to route on.
- **Every header the caller sent is on `request`, except the credential headers of every API
  the edge serves.** Any hook or part reads the rest, with no allowed list: the SDK does not
  decide how an author uses them. The host removes those headers on every path, always:
  whatever one holds, readable or not, every occurrence, with an auth adapter or without one.
  So a motty never sees the key or token that proves who the caller is to the host, and a
  token for a service the motty calls is sent in a header no API names a credential. Cause: a
  second credential header was kept when it held another well-formed token, so a placeholder
  key beside the real token, the same token padded or spelled another way, or another caller's
  valid token reached the motty; and so did a token sent in another API's credential header,
  an OpenAI client's `api-key` on the Messages path or `x-api-key` on an OpenAI path.
  Rejected: comparing tokens, which cannot tell a token spelled another way from another
  token.
- **`signal` is a standard `AbortSignal`.** SDK calls follow it unasked, except in `afterResponse`.
- **When it fires, the work stops.** Calls in flight are cancelled; what was used is still counted.
  No further step is run: the request fails with `Aborted`, which the boundaries see like any other
  error. An answer being streamed from a model ends with `Aborted` at once, even if the host's
  model call keeps sending. Rejected: waiting for the model call to end by itself, which a host
  that ignores the signal never does.
- **The core waits on nothing it does not control without also watching the signal.** A hook, a
  stream an author made by hand, a function the host supplied: each wait ends with `Aborted` when
  the signal fires, even if the code behind it never returns. A stream made by hand is closed and
  not read further. Cause: one hook that never settled held the whole request, so the
  after-response work never ran and no record was sent.
- **Nothing a phase started outlives it.** When the answer has been sent, model calls still open
  are cancelled, and what they reported is counted before the caller is told the usage. Calls made
  in after-response work are cancelled the same way when that work ends. Cause: a call left open
  kept its upstream sending to nobody, and its usage reached neither the caller nor the record.
  Rejected: listing such a call in the record as unfinished, which named the call but not its cost.
- **Outcome `"aborted"` means the host stopped the request, whatever the reason; the error's code
  says why:** the caller left, the time limit passed, the reply held what the caller's API
  cannot carry, the server is shutting down. When the host aborts the signal with an SDK error
  as the reason, such as `TimedOut` for its own time limit, that error is the one raised. A
  platform's own timeout reason is `TimedOut` too. With any other reason it is `Aborted`. Cause:
  with one error for all, a caller still connected was told it had left.

### Models and combinators

- **Models are named, not configured:** `model("provider/name").complete(prompt)`. Hosts hold keys.
- **A model name is `provider/name`, and the name is the provider's own.** The SDK ships no list of
  names: a list is large and out of date with every release.
- **The family is read from the name's prefix:** `openai/*`, `anthropic/*`, `motty/*`. The host then
  uses that family's API for the call. For any other prefix, the host states which family's API
  that provider speaks.
- **A model made by name carries that name, readable.** The test kit scripts a reply for a model
  and reads back what it was sent by the model itself, so a test never repeats the name as text.
  What a combinator returns carries none: it stands for several models. Rejected: an optional name
  on every model, with which a test could script a `fallback` and learn it only when run.
- **A name is resolved when called,** so it may come from `request.model` or a setting. One the host
  cannot serve fails that call with `UnknownModel`, and `fallback` moves on. No check at start.
- **Combinators return models, so they nest:** `fallback(...models)`, `race(...models)`, which
  cancels the losers, `retry(model, times)`, `timeout(model, ms)`.
- **`retry` repeats only retryable failures,** honours a retry-after of thirty seconds or less,
  and counts retries, not tries.
  With no retry-after it waits half a second, doubling each time, up to thirty seconds. Rejected:
  retrying at once, a hot loop against an upstream that is already overloaded. `Aborted` and
  `LimitReached` are never repeated, whatever an upstream says.
- **A retry-after longer than those thirty seconds is not waited for:** the call ends at once
  with that failure, so a `fallback` can move on. Cause: an upstream that answered 429 with a
  retry-after of a day held the request, and a streaming caller with it, for as long as the
  host set no duration limit, which is optional. Rejected: waiting the thirty seconds and
  calling again, which calls an upstream that said not to.
- **When every model failed, `fallback` throws the last failure,** and `race` throws the failure of
  the model listed first.
- **Once the request is stopped, a combinator throws the stop's error.** When that is the SDK's
  own `Aborted`, the last model failure is its `cause`. An error the host gave as its reason is
  raised as it is: it is the host's object, and may be shared between requests.
- **A time limit belongs to a model call; how long a request may take is the host's.** `timeout`
  fails a call whose first chunk is late, with `TimedOut`. Without it, `fallback` waits forever on
  an upstream that hangs. A decision call past its adapter's limit throws `TimedOut` too.
- **`timeout(model, { first, stall })` also ends a stream that goes silent between chunks,** as
  an error in the stream. A `timeout` limits whatever it wraps, a `fallback` or a `retry` as a
  whole.
- **`fallback` and `race` stop switching models at the answer's first chunk,** not at progress. An
  error after that goes into the stream.
- **A model is not a step.** Rejected: `model(name)` in the chain. A handler has room for more.
- **Inside a bundle a motty reaches another as code.** Called by name it is a model call like any
  other, served by a host that knows the name. Protecting against a loop is that host's job.
- **Tools belong to the caller's agent.** They pass through; a motty runs none, but routes on them.

### Answers and structured output

- **The caller picks streaming or not, as with any model API.** Inside, an answer is always a
  stream, so a motty is written once; the edge collects it for a non-streaming request.
- **Buffered, it is re-read in any order:** `text()`, `chunks()`, `json()`, `usage()`, `finish()`,
  `model()`.
- **An answer names the model that gave it:** the name that was called, whichever of a
  `fallback` or a `race` it came from, and none for an answer made by hand, nor for one a time
  limit ended by itself, which stands over several models. A rewritten answer
  keeps the original's. Cause: a motty that chose its next step by which model had answered read
  it off `calls`, and got another call's when one more had succeeded since.
- **Answers are made by hand** with `answer(text)`, or `answer(chunks, original)` to rewrite
  output. A rewritten answer keeps the original's finish reason, usage and failure.
  Rejected: a rewrite that always ends in `stop`, which turned a tool call into a plain reply.
- **Two views of usage.** `answer.usage()` is the call that answered. `calls` is on the context from
  the start and grows with every model call, cancelled and failed too: model, the token counts the
  upstream reported, cache writes included, each call's `time` in total and to its first event, what the
  call left out as `warnings`, the upstream's own `id` for a call that finished, with the token
  totals summed as it goes. A count an upstream did not report is absent, never a zero. So any
  hook reads usage so far and `afterResponse` the final figure. This serves a self-host and the
  motty's own logic; the Hub counts for itself, because it provides the inference.
- **A failed call keeps what its failure said beside its code,** in `calls` and in the record
  alike: the message of the error the motty would catch, so an upstream's words as its adapter
  cut them, and the SDK's sentence for a value a host threw, never that value's text. A
  completed call holds neither. Cause: a `fallback` that moved on left a completed request with
  no error in its record, so an option the spoken API does not take stayed hidden behind the
  next model's answer. Rejected: an error object on the call, which would bring the stack and
  the cause into what the motty reads.
- **A call that finished keeps the upstream's own id for the response, as `id`,** in `calls`
  and in the record alike, where the upstream gave one. It is what a host matches a call
  against the provider's own logs by. A call that failed or was cut short has none. Rejected
  for now: an id on those too, which would touch all three wire formats and grow the author's
  bundle, and is left until matching shows it is needed.
- **A call that was stopped is counted with what its host says of it until the phase it began
  in ends.** A `race` loser or a call cut by a time limit ends in `calls` at once, as aborted,
  and the core goes on without it; the usage its host reports after that is added to its entry
  and to the totals when it comes, and dropped once the answer has been sent, or, for a call
  made in after-response work, once that work ends. Nothing waits for it: it is read on in
  batches of about two milliseconds with one turn of the event loop between them, so a burst is
  counted and a host that never waits cannot hold the loop. Cause: with one turn per event,
  about an event a millisecond was read, so a cut call's buffered chunks outlasted the phase
  and its usage went uncounted.
- **A host stops a call by its signal.** The stream of a stopped call is closed only when its
  phase ends, so a host that stops generating only when its stream is closed pays for a `race`
  loser until then.
  Cause: a host that counts every call at its proxy knew what a cancelled call had cost and had
  one turn to say so, which no call across a process boundary meets.
- **The caller is told what the request used.** The reply's standard `usage` field, in the caller's
  format, holds the total over every call made before the reply ended, not only the one that
  answered. No field of our own.
- **Usage is read, never computed.** The counts are the ones each upstream reports with its answer;
  the SDK only adds them up. It never tokenizes, which would slow generation and grow the bundle.

- **`complete({ messages, output: schema })` asks for JSON, `json()` reads it.** For a Standard
  Schema the value is validated and typed, or `InvalidOutput` is thrown. A caller's schema is
  always a JSON Schema, passed as `{ schema }` with the name and strictness the caller sent: the
  reply is parsed, not validated, and typed `unknown`. With no schema it asks for any JSON object.
- **The `{ schema }` form holds a Standard Schema too,** with the name, the description and the
  strictness an author states beside it; the value is validated and typed as for the schema
  alone. Cause: an author with a schema library could not ask for strict output without writing
  the JSON Schema by hand, which a library's own JSON Schema type did not fit without a cast.
- **A Standard Schema goes upstream as the JSON Schema it provides itself.** One that provides none
  fails the call with `Unsupported`. Rejected: a converter in the core, a dependency per validator.
- **The SDK ships no validator.** AJV as a built-in was rejected: it compiles with `new Function`,
  and the bundle stays free of run-time code generation so stricter runtimes stay possible; it is
  also a dependency. An author wraps precompiled validators instead.
- **A caller's schema passes through** as `request.output` and `prompt.output`, a routing signal.

### Progress

- **`think(text)` sends a line of progress; `think(answer)` forwards an intermediate answer live.**
  A caller who is not streaming gets progress collected in the reply's reasoning.
- **Progress is reasoning on the wire:** an Anthropic thinking block, a Responses reasoning summary,
  and in Chat Completions both `reasoning` and `reasoning_content`, since clients read either.
  Every client shows reasoning, none an event of ours.
  Rejected: writing it into the reply, which the caller's agent would read as the model's words.
- **`think` only offers progress; the edge decides whether to send it.** A motty never writes to
  the stream, so it cannot break it.
- **One stage: before the answer.** It closes when the answer starts being sent, after
  `afterHandle`. Pieces go out in call order, one at a time. The first starts the response.
- **Outside the stage `think` does nothing** and does not throw; its caller need not know the phase.
- **An answer cuts progress short.** A forwarded answer still arriving is dropped. Its call is
  cancelled when the answer has been sent, like any call still open then.
- **Models reasoning at once do not collide.** Only answers passed to `think` reach the caller: the
  first live, the others whole. What is shown is plain code, with no option on `model` or `think`.
  Rejected: sending them at once. Chat Completions has one `reasoning` field with no block id.
- **Progress is not part of `answer`.** The answering model's own reasoning is, for `afterHandle`.
- **It never reaches a model:** the codec drops a motty's own reasoning, which no upstream signed.
- **Why a route was chosen is the motty's business,** said by `think`. Rejected: a report field.
- **A caller mutes progress the way it mutes a model's reasoning.** No cross-format standard
  exists, so each format's own control is followed: `thinking` and its `display` in Anthropic
  Messages, `reasoning.summary` in Responses, `reasoning.exclude` in Chat Completions. A caller
  whose request returns no reasoning from a model gets no progress either.

### Errors

- **Errors are thrown, and are known classes** with a base, a code and a status. Authors add theirs:
  `class EmptyPrompt extends MottyError.define("empty_prompt", 400) {}`.
- **Upstream errors keep their meaning:** `RateLimited`, `QuotaExceeded`, `Overloaded`,
  `ContextTooLong`, `Blocked`, `Unsupported`, `Forbidden`, `InvalidRequest`, `UnknownModel`,
  `UpstreamFailed`, and `UpstreamRefused` for an upstream that rejected the host's own key or
  billing. The SDK adds `TimedOut`, `Aborted`, `Unauthenticated`, `InvalidOutput`, `LimitReached`,
  `RouteLoop`, and `UnknownRoute` for a name cast past the types.
- **Every upstream's failure is named by one of those kinds, the same whichever provider
  failed.** A motty's `fallback`, `retry` and boundaries are written once against the kinds and
  never read a provider's own code or status. The set is closed: a provider adds none.
- **A failure is named by the most specific thing the upstream said, in a fixed order:** the
  provider's own table, on its code, type or stated limit; then the wire family's table, on the
  error's code and type; then a number an upstream put in the error where a status was not
  sent; then the status. Cause: named by status alone, a spent balance told as 402 or as 429
  was a refused credential or a rate limit to wait out, a prompt too long told as 400 or 403 a
  bad request or a refused key, and an unknown model told as 400 the caller's mistake.
- **A provider's table belongs to its adapter and a family's to its codec.** A provider that
  speaks a shared wire format names its own codes in its dialect, read before the family's, for
  a failed response and for a failure told inside a stream alike. A failure a provider tells
  with no `error` field is stated by its dialect, which says what error such a body or chunk
  holds; the family's reader looks for none, and the family's table holds the family's own
  codes.
- **By status alone:** 401 and 403 are `UpstreamRefused`; 402 is `QuotaExceeded`; 404 with an
  error in its body is `UnknownModel`, and with none it is `UpstreamFailed` and not retried, a
  wrong address being the host's setup; 408, 504 and 524 are `TimedOut`; 429 is `RateLimited`;
  498, 503 and 529 are `Overloaded`; any other 4xx is `InvalidRequest`, and the rest
  `UpstreamFailed`.
- **An upstream's redirect is never followed.** A 3xx is `UpstreamFailed`, not retried, and
  never told by where it points: 301, 302, 303, 307 and 308 are told as a redirect that is not
  followed, any other 3xx by its status. Cause: the next address was sent the key and every
  connection header.
- **An option or a value the model does not take is `Unsupported`,** where the upstream says so
  by code. An OpenAI API that refuses one with no code is read by its words, only on the 400
  it refuses one with: where the option is named, by how the sentence begins, and where none
  is, by a sentence that is nothing but the refusal. Under any other status the words name
  nothing. Another model may take it, which is what the kind says to a `fallback`.
- **A list of what a validator refused, at the top of a body with no error object, is the
  message, for every provider:** where and what, entry by entry. The list itself is kept in the
  provider facts, shortened as any fact is.
- **An ending an upstream tells as a failure is one.** A finish reason that means the upstream
  ran out of capacity or lost its connection is an error of that kind, and one that means the
  content was filtered is the content-filter ending, under whatever name the provider uses.
- **The status a caller gets is the kind's own, in the number the caller's API gives that
  kind.** A spent quota is 402 and an overload 529 to a caller of Anthropic Messages, 429 and
  503 to a caller of an OpenAI API. An upstream's status is kept in the record with its code and
  type, and is not sent on, except that an invalid request keeps the 4xx it came with. Cause: with the upstream's status passed through, one kind reached callers under
  different statuses by provider, and a prompt too long that a provider told as 403 was written
  to the caller as a permission error.
- **Whether a failure may be retried is the upstream's to say, and the caller is told.** A retry
  flag and a retry-after an upstream sends replace the kind's defaults: a spent quota and a rate
  limit no wait can meet are not retried. The reply carries the flag in the header the official
  client libraries read before they look at a status, and a `retry-after` only for a wait that
  is a finite number of zero or more, in whole seconds rounded up.
- **A spent balance or limit is `QuotaExceeded`, in the upstream's words.** It is the host's
  account, yet the caller may be the one who can act: a request that asks for less output may
  fit what is left. A sentence that holds a link is left out, since the link goes to the host's
  account, and with it a question that only leads into it; a rate limit is told the same way.
  Where nothing is left, the caller is told in the SDK's words that the account has no quota,
  or the rate limit no room, for the request. Cause: told as a refused credential, the one
  sentence that said so was kept from the caller.
- **An upstream's 413 is `InvalidRequest`, for every chat API.** It is a limit on the request's
  bytes, enforced before the API reads the prompt. A prompt of too many tokens is
  `ContextTooLong`, and the upstream names it by its own error code. Cause: one codec read 413 as
  the first and the shared table as the second. A decision server's 413 that says the state is
  too large, as Laya's does, is `ContextTooLong`; any other is `InvalidRequest` too.
- **A decision upstream's failure is told in the upstream's own sentence, as a chat upstream's
  is,** with the adapter's secrets cut first. Cause: every failure was told only by its status,
  so an author could not tell a misspelt model from a malformed question. A model the upstream
  does not know is `UnknownModel`, read from the upstream's words: Jev tells it with the same
  400 and error type as any misuse, and a `fallback` routes on that kind.
- **A decision upstream's 404 is the host's address, never a model.** It is `UpstreamFailed`, not
  retried, and says the address is likely wrong; only words that say "unknown model" make any
  status `UnknownModel`. Cause: Jev and Laya both answer a path they do not have with a 404,
  which the shared table read as `UnknownModel`, so a mistyped address looked like a misspelt
  model. Rejected: quoting the address, which may hold a secret.
- **A refusal is content, never an error.** `Blocked` is an upstream's content policy at work.
- **Errors land as in React's error boundaries,** chosen because an author already knows where an
  error lands. `.onError(fn)` is a boundary for everything inside its motty: its own hooks, its
  entries, any motty nested in it. The nearest boundary gets the error first and returns an
  `Answer`, the fallback, to recover. If it returns nothing or throws, the next boundary up gets it.
- **Interruptions are ordinary typed errors.** SDK calls throw `Aborted` once the caller left or the
  host's time limit passed. Every error is a typed class and every one reaches the boundaries,
  `Aborted` and `LimitReached` included; a boundary tells them apart by class and reacts. A fallback
  answer for a caller who already left is simply not sent.
- **`UnknownModel` means one thing: the host or an upstream does not know the name.** No tool reuses
  the code for a meaning of its own, so `fallback` past it is tested like any other failure.
- **An error is told by its code, not by which copy of a class made it.** `instanceof` holds for
  any SDK error that carries the class's code. So it still holds after an error has crossed the
  host contract as facts, in a test and in a host alike. Two classes defined with one code are the
  same error.
- **A caller never receives a bare server error.** Above the root's boundary sits the SDK's own:
  whatever reaches the top, handled by `onError` or not, goes out in the caller's format with a code
  and a message that says what happened.
- **An error reaches the caller in its own words.** An SDK error the motty or a plugin raised goes
  out with its own message at any status, and an upstream's failure with the upstream's own
  message, under the code and status it already had. Cause: a caller whose option an upstream
  refused was told only that the request was not valid, not which option. Rejected: the own
  message only for the motty's errors below 500 and a general one per code for the rest, which
  hid from the caller the one sentence they could act on; a host option to hide messages, a
  second behaviour for every client to meet.
- **A refusal of the host's own key or bill is told in the SDK's words.** The caller is told that
  the upstream refused the host's credentials or account, as `UpstreamRefused` with no status of
  the upstream's; what the upstream said is kept in the error's provider facts, with the
  adapter's secrets cut from it. Cause: one upstream echoes part of the key it refused, and
  another's refusal over the bill names the host's account and balance. Rejected: the upstream's
  words here too, one rule with no exception, which is that leak; passing on the words of
  upstreams that echo nothing, a list per provider.
- **An adapter's secrets are cut from all an upstream said before any of it is shortened.** The
  adapter hands its cut to the codec that reads the failure, of a failed response and of a
  failure inside a stream alike. The codec runs it over the message, a router's raw text and
  every field's name and value, and only then caps them; it never learns what a secret is.
  Cause: the record is built from the error the motty catches, so nothing on it is the host's
  alone to read; and cut after the record was capped, a cap broke a key or a header in two,
  the rule that made up for it cut ordinary words where a text ended, and a short key's start
  was left in the record.
- **A failure is named from what the upstream said as it came,** and the cut is taken from what
  is told and recorded: a cut may break a code.
- **A sentence the SDK wrote is never cut; the cut runs over the upstream's words alone.**
  Cause: a key that is an ordinary word was cut out of "The upstream answered 500".
- **What the adapter itself produces it cuts itself:** the cause of a connection that threw,
  and the decision adapter's body, cut and then shortened.
- **A secret an upstream echoes as a field's name is cut as a value is, at every depth.** Two
  names the cut makes equal are both kept, the later numbered. Cause: a key echoed as a field
  name reached the motty in the error's provider facts.
- **A field named `__proto__` is a field like any other,** in a caller's body, an upstream's
  stream, a record and the settings: it is kept as a field and nothing is inherited from it.
  Cause: such a field was dropped from what was passed on and inherited by what read it, so an
  upstream's stream could forge its own finish reason and usage.
- **A key of twenty characters or more is cut whole, by four characters of either end and by
  eight of its middle.** An end is cut only at that edge of a name: a beginning not preceded,
  an end not followed, by a letter, a digit, `_` or `-`. A mask leaves a key's ends there, and
  a word may end as a key does. A shorter key is cut only whole and only where it stands
  alone, not inside a longer run of letters, digits, `-`, `_` or a dot between them. Cause:
  the placeholder keys local servers use, `ollama` and `none`, and a key ending `-prod` cut
  ordinary words out of messages.
- **A connection header's value is a secret whole, and so is every part of it, each from
  sixteen characters:** a flag, a date or a version stays. The parts are split on whitespace
  and `;` `,` `=`, and each is cut only whole, with no exception where a text ends. Rejected:
  cutting it by masked fragment as the key is, since a header may be a word. A connection's
  body is no place for a secret: an upstream may quote the request, and a body field is not
  cut.
- **An adapter address that holds a name or a password, or is no address, fails when the
  adapter is made,** in the adapter's words and without the address. Cause: one runtime quotes
  such an address in its failure and another drops the credentials silently.
- **An adapter reads at most 65,536 bytes of a failure's body and lets the rest go.** A body
  cut there that is no longer JSON is told by its status. Answers and streams have no such
  limit.
- **An adapter is given the key itself, trimmed once when the adapter is made.** Nothing is read
  back out of a header, and a key that is only whitespace is no key. Cause: a key written with
  a trailing space turned the cut off.
- **The cut matches a secret's own text.** A key echoed encoded, in another letter case or
  inside a successful answer is not looked for. Rejected: scanning for it, which costs every
  request and still misses a key that was encoded; a key valid for one request is the answer.
- **What names the host's account in an upstream's failure is cut from the message the caller
  and the motty are told:** an organisation, a project, a request id. The error's provider
  facts keep what the upstream said, for the record. Each adapter, or the codec of a provider's
  own family, owns a closed, ordered list of patterns beside its failure table; the shared wire
  code applies the list it is given and holds none. An id is cut with the words that join it to
  the sentence, and no mark is put in its place. An id read by its shape alone is cut only from
  a failure that is not the caller's own request told back, where a name of the caller's may
  have that shape: never from `InvalidRequest`, `Unsupported`, `ContextTooLong` or
  `UnknownModel`. A router's list is those of the providers it routes to, and all a provider
  said is cut before any of it is shortened. Rejected: scrubbing any UUID or token, which cuts
  tool-use ids.
- **An id is cut as far as its characters run,** bounded only against hostile input, in the
  thousands, with no condition after it that can undo the match. A label that is a word is
  read in any letter case, and an id of hex groups must hold a hex digit. Google's project is
  cut in "in project N", where a permission names it as a resource, and by shape alone in a
  resource path.
- **An upstream's message told to a caller is at most 2,000 characters,** shortened after its
  names and its links are cut, at its last whole sentence or else its last whole word. The
  record keeps what the upstream said.
- **A message that is nothing but a cut name says nothing,** and the failure is told as one
  with no message is. A name cut alone takes with it the one space it would leave doubled or
  standing before a closing mark; nothing else of the sentence is mended.
- **A thrown value that is no SDK error is the one thing told in general:** its code, its status
  and "Internal error". It was not written for a caller and can hold anything: a query, a key, a
  path. That holds for whatever threw it, the motty, a plugin or an adapter, and after it has
  crossed the host contract as facts.
- **A thrown value that throws again while it is read is told and recorded as that same plain
  failure, quoting nothing:** a `message` that throws when read, a proxy. Cause: it left the
  request with no last event and no record, against the rule that running never throws.
- **What a service of the host throws that is no SDK error reaches the motty as an SDK error
  that names the service, with nothing of the thrown value:** storage, decisions, the function
  that supplies the models, a model adapter. Of a model call it says that the call to that
  model failed, as `internal` and not retryable. The report holds the thrown facts under
  `failed`, added on the host's side, so they never pass through the bundle. An SDK error
  passes as it is.
- **A timeout or an abort a host's service throws is a stop only once the signal that governs
  it has fired:** the call's own for a model or a decision call, the request's for storage and
  the function that supplies the models. Otherwise it is that service's failure, sealed and
  listed under `failed`; an adapter that means a timeout raises the SDK's own. Cause: a key
  service or a store that timed out by itself was told as the request timing out, retryable,
  and the host was told nothing. What a model call throws after its own signal fired, or after
  its stream was closed, is no failure of the service and is never listed.
- **What the auth adapter throws ends the request before the motty runs, and still makes a
  report:** outcome failed, the thrown facts under `failed`. A refusal the adapter raised as an
  SDK error makes none.
- **The host gets the full error.** The record holds the error's own message and the message of
  its cause, and for a thrown value that is not an SDK error, its message and stack. Cause: an author's mistake, such as a
  handler that returned nothing, was shown to nobody. The caller rightly saw a general message, and
  the author saw the same.

### The host contract

How whatever runs a motty, `serve` or the Hub, calls it. Both sides are written against it.

- **A motty is recognised by a mark, not its shape or class.** The mark is a well-known symbol on
  the motty, and the contract is the value behind it. Rejected: `instanceof`, since bundle and host
  each hold their own SDK copy. Also rejected: a string key. Standard Schema chose one for how
  TypeScript and editors treat a symbol key that authors write; authors never write this key.
- **A host runs a motty by calling one function behind the mark:** a decoded request and the host
  in, one stream out. The stream holds progress, the answer's events, and exactly one terminal
  event. Nothing is read from the environment or shared between the two SDK copies.
- **The contract has its own version number, a whole number starting at one.** It goes up only when
  a change to the request, the events or what the host supplies would break a host. A host reads
  the number first, at load, and refuses a number it does not know. Rejected: the SDK's major
  version. Before 1.0 it is always zero, and later it would go up for changes that affect no host.
- **The decoded request and the events are the contract, and the codecs stay with the host.**
  Rejected: a bundle that is an HTTP handler with the codecs inside. It is larger, and a codec fix
  would need every author to rebuild.
- **Every event in the stream is plain JSON data,** so a host can send it across a process or
  network boundary as bytes.
- **The host may pass one function to receive the record.** The core calls it once per request,
  after the after-response work has finished. The record holds: the outcome; the error, when the
  request failed or was stopped; `path`; every entry that ran, reroutes included; the part that
  answered early or threw; every model call, with the code of its failure and what it said when
  it failed or was cancelled, and the upstream's id for it when it finished; the usage totals;
  under `time`, how long the answer took and how
  long the whole request took; and the after-response hooks that failed, and apart from each
  other those the time limit left no time for, as `skipped`, and those not run because a value
  they are typed to read was never made, as `unreached`. Cause: with one list for both, a host
  could not alert on the first, since every early answer listed a skip.
- **The error is in the record because the stream may not deliver it.** A caller who left gets no
  terminal event, so the record is the only place the host can read why the request ended.
- **Rejected ways to deliver those facts.** On the terminal event: a caller who left never gets
  that event, and it is sent before the after-response work, so it cannot report that work. As a
  promise returned beside the stream: every host would have to handle a second return value. In
  two calls, one when the answer ends and one later: model calls made in after-response work would
  make the two disagree.
- **The record also tells the host that the request is over.** A serverless host is stopped by its
  platform soon after the response ends, so it must ask the platform to wait until the record
  arrives. Platforms limit that wait, so the host sets `limits.afterResponse` below the
  platform's limit.
- **Running never throws.** A mistake in what the host supplied, such as a limit that is not a
  whole number, comes back as a stream with one error and a record, like any failed request. So a
  host handles failure in one place.
- **Events are checked where they enter the core.** An event from the host's model call, or from a
  stream an author made by hand, must be of a known kind with fields of the right types, or the
  call fails. Progress is refused there, so it cannot be forged as part of an answer, and so is a
  terminal event in a stream an author made by hand: the answer ends when the stream does. A
  provider's own data inside an event, and any field the SDK does not know, is passed on
  unchecked. Copying only the known fields cost about thirty nanoseconds on every event, and a
  host must guard how it encodes an event anyway, because provider data is open.
- **What the host supplies is read-only to the motty by type, at every depth.** The core does not
  copy or freeze the request, the caller or the settings: what a host hands to more than one
  request is the host's to freeze.
- **A host must read the stream to its end or close it.** If it does neither, the request never
  finishes: the after-response work does not run and no record is sent.

## Plugins

First-party plugins, written with the same builder as anyone's and shipped apart from the core. The
core stays what every motty uses, and a plugin is proven possible by being written outside it.

- **Plugins are open source and run on any host.** A self-host configures what they need in its
  host options, such as the key set that proves a caller. On the Hub they work with nothing
  configured.
- **Anyone may publish a plugin, and every host runs it like ours.** A plugin is compiled into the
  motty's bundle and reaches the host only through the core, so a host needs to know nothing of it.

- **A value an operator may change without a release is a setting.** `settings(groups)` returns a
  part that adds typed `settings`. Rejected: an imported value read like `store`, unseen in a chain.
- **Settings are defined in code, with their defaults.** Each group is a Standard Schema accepting
  `{}`, or the motty fails at load. So the types check every setting a motty reads.
- **The definition in the code is the only one.** A host that shows settings to an owner reads
  them from the code, and no copy is kept anywhere else.
- **The host supplies overrides; the motty never fetches them** nor reads the environment. They are
  checked when the host supplies them, which may be per request. Rejected: values compiled into the
  bundle, a version per retuning, and overrides in `store`, which only a request can write.
- **Settings are frozen at every depth of plain data,** the defaults once when loaded and an
  override when merged, so a write throws in the motty that makes it. Cause: the defaults were
  one object handed to every request, and a hook that wrote to it changed what every later
  caller read: measured, a threshold of 0.5 read 99 on the next request.
- **Only bounded values are settings:** a model name if its schema lists the names, never a prompt.
- **One settings part per served motty;** a plugin takes arguments. A caller cannot set them.
- **A second settings definition anywhere in a served motty fails at load,** whether its groups
  are the same or others. Defined once, the part is shared by the root and every module that reads
  it. Cause: two of the same groups were taken as one, so the second's schemas were never checked
  and its types were a lie; two of other groups both ran, the later hiding the earlier.
- **Every settings part is grown from one motty,** so the core's own rule for two parts of one name
  refuses them and the core knows nothing of settings. Rejected: a part that marks itself as
  defined once, a core option for one plugin. Rejected: refusing any two parts made apart under
  one name, which `auth()` called by the root and by a module is. Rejected: a type error where the
  second is used, which needs the chain's type to carry every part's name.
- **The motty says it needs a caller; the host says how one is proven.** `auth()` holds no key and
  no check: it throws `Unauthenticated`, 401, when the host knows no caller, else adds `caller`.
- **`caller.id` is extracted and validated, never read raw.** The motty never sees the key or token.
- **Without `auth()` a motty is open** to whoever reaches its host.
- **`store` is a thin layer over one key-value database:** `get`, `set` with `{ ttl }`,
  `delete`, and `increment`. It adds a key prefix only: one call is one command, no cache, no
  batching.
- **`increment(key, by, { ttl })` adds to a number in one step of the database and returns the
  new value.** A key that is absent starts from zero, and the time to live is set when the key
  is made, not on each addition. A value that is no number fails the call. Cause: a counter kept
  with `get` and `set` lost additions whenever two requests of one caller ran at once, which is
  when a limit matters. Rejected: transactions or compare-and-set, a second API for the one
  thing a counter needs.
- **Keys are namespaced per served motty,** by the host's `namespace` option or, where the host
  states none, the root's `name`. The host adds that prefix before it hands the storage over,
  since a part cannot see the root it is used under. Cause: a name is the author's to choose,
  so a host that serves two authors' motties of one name had them reading each other's keys,
  and only the host knows the two apart.
- **The namespace is stated per mount, never per request.** A mount serves one motty and is
  cheap to make, so a host that keeps tenants apart makes a mount for each. Rejected: storage
  or a prefix chosen per request, a second way to say what a mount already says.
- **Two namespaces never share a stored key, whatever they hold.** In the namespace a
  colon and a percent sign are written percent-encoded, so the first colon of a stored key always
  ends the namespace. Every other name is stored as written, `acme/coder` too. Cause: a name is
  any string, and the motty `a` writing `b:x` reached the key `x` of the motty `a:b`. Rejected:
  refusing a colon in a name at load, which forbids every part a character for the sake of the
  root's storage and breaks motties that load today. Rejected: the name's length ahead of it, or
  the whole name encoded, which changes every key already stored and which no person reads.
- **Anything past key-value is the author's code,** a package the SDK neither wraps nor forbids.
- **A decision model returns calibrated probabilities, not text,** in under half a second:
  TypeSafe's Jev, the open Laya.
  `jev.decide(opening, { software: noul({ instructions: ABOUT_SOFTWARE }) })` sends a `state`,
  text or structured JSON, and a map of named questions.
- **Decision models follow the Jev API, in names too.** The SDK adds no vocabulary over the API the
  models already share. Rejected: friendlier names such as a yes/no helper, one thing named twice.
- **Exactly three question kinds, because the model class defines exactly three.** `choice`, `score`
  and `noul` each take `{ instructions, criteria }`: for `choice`, up to 255 options, `criteria`
  maps each option to its description; for `score` it is the ordered list of levels, up to ten; for
  `noul`, yes or no, it is optional and describes what a yes and a no mean. Rejected: describing questions with a general schema, or passing free-form
  JSON through. The models accept neither, and have no free-form question.
- **A request with no question, and a choice with no option, are refused before any call,** as a
  question past its limits is. Cause: Jev refuses both.
- **Laya is not Jev in every respect, and the SDK does not paper over it.** The request and the
  answer have one shape. The limits differ: Laya takes 100 options a choice, 32 levels, 64
  questions and 50,000 characters of state; Jev 255 options and ten levels. So do the statuses
  for one mistake, and the reading of the model's name: Laya answers a name it does not know
  with a checkpoint of its own choosing and no error, which the adapter tells as a failure.
  The plugin's limits stay Jev's, the API the rule above names. Rejected: limits per server in
  the plugin, which would make the plugin know its host.
- **Results are typed from the questions, in the API's field names.** A choice has `choice`,
  `probabilities` per option and `confidence`; a score has `score`, `probabilities` per level and
  `confidence`; a noul has `noul`, the probability of yes. Thresholds go on probabilities: Jev
  and Laya differ on confidence, which on Laya is another measure, normalised entropy.
- **A score's answer is held to its question:** a probability for each level, and a finite score
  within the levels. Confidence is only required to be finite, the two servers measuring it
  differently.
- **What Laya adds to an answer is typed as optional, under Laya's names:** on every answer its
  confidence in the answer and the probability it would act; on a noul its own confidence; on a
  choice and a score Jev's confidence formula computed from the same probabilities, the one
  figure comparable across the two servers. Where the host set Laya's confidence floor, each
  answer also says whether it passed or abstained and at what threshold, and one that fell
  below is marked so. A field that is there is checked as typed; Jev sends none of them, and
  Laya none in its strict mode. Rejected: converting one server's confidence into the other's
  in the SDK.
- **It is not a chat model:** `decision(name)` has `decide`, not `complete`, and no combinators.
- **Otherwise a model call:** named, resolved by an adapter that sets its time limit, following
  `signal`, counted in `calls` and `limits.calls`. Laya serves the same request and answer
  locally, which is what the adapter's local-server option is for.
- **A decision call crosses the host contract through its own optional function,** beside the one
  for chat calls. It carries the decision API's input and output as JSON the core never reads: the
  vocabulary belongs to the plugin and the adapter, so a new question kind changes neither the core
  nor the contract. The model's name travels beside the input, as for a chat call, and the adapter
  writes the provider's own name into the request. Rejected: tunnelling it through the chat call
  as a prompt holding JSON, which every host and the test kit then had to parse back out.
- **The function is optional, so the contract's version did not change.** A host written before it
  still runs every motty that asks no decision model, and one that does fails only that call.
- **For now a decision model is only called from inside a motty.** A motty that serves the decision
  API to its own caller is another kind of motty, and comes later.

## Testing

```ts
test("an off-topic opening gets a canned reply and no route", async () => {
  const models = fake(on(jev, { software: 0.02 }));

  const { route, answer } = await run(
    coder,
    { text: "What should I cook tonight?" },
    { models: [models] },
  );

  expect(route).toBeUndefined();
  expect(await answer.text()).toBe("I only answer questions about software and codebases.");
});
```

- **The test kit is its own package, used with the author's runner.** Rejected: helpers for case
  tables or repeats, and a harness object: those are the runner's.
- **`run(motty, request, options)` is the whole lifecycle without the wire.** The request is plain
  data (`text` or `messages`, `model`, `tools`, `options`, `headers`, `output`, `signal`), the rest
  defaulted. It resolves with `route`, `path`, `answer`, `calls` and `thoughts`, the progress really
  sent, or rejects with what was thrown. It resolves once the record has arrived, so after-response
  work has finished and a test can assert on its effects. Rejected: testing through `serve` and
  `fetch`, which asserts on untyped JSON and tests our codec.
- **`run` is a host, and does a host's steps with the code `serve` does them with.** It differs
  only where a test must: no wire, test defaults, a result to assert on. Cause: written a second
  time in the kit, the steps already disagreed with `serve` on the storage prefix.
- **The answer `run` returns is the one the caller got:** every chunk, the finish reason, and the
  usage of the whole request. Cause: an answer rebuilt from the chunks alone always ended in
  `stop` with no usage, so a tool call could not be asserted on.
- **That answer names the model that answered, as the motty saw it.** The name is held beside
  the finish the core sends and never in it, so it is read only where the test kit shares the
  core's copy.
- **Host options are optional, each with a test default:** no models, everyone admitted as
  `tester` unless an `auth` adapter is passed, no limits, in-memory storage per run unless a
  `memory()` is passed. With an `auth` adapter the credential is read from `authorization`.
- **`memory()` refuses what `redis` refuses.** A time to live that is not a positive, whole
  number of milliseconds is rejected by both with the same message. Cause: the test store read
  zero as already gone and infinity as forever, so a motty passed its tests and failed on a real
  store.
- **`memory()` holds what JSON text reads back as:** negative zero is zero, and a number that is
  not finite is null. `increment` adds only to a JSON number, in both stores.
- **A test declares no types of its own;** SDK types may be imported. A scripted reply is typed by
  the kind of model it is for.
- **A failed run rejects with an SDK error rebuilt from the facts that crossed the contract.**
  `instanceof` holds for it, for an author's own class as for the SDK's.
- **Models are scripted by value** with `on(model, reply)`. A chat reply is text, a JSON object,
  an error, a function of the prompt, or a list of chunks that may end with a finish event stating
  the finish reason and the usage. The function may be async and the chunks an async sequence,
  each given the call's stop signal, so a reply that comes late or stalls is plain code: a time
  limit is tested with the runner's own timers, and the kit adds no word for a delay. A decision
  reply is a probability for a `noul`, a probability per option for a `choice`, a number for a
  `score`, fractional as the API's may be. One model's entries answer in order; the last
  repeats.
- **A scripted decision is one the API could give.** A probability outside zero to one, or a
  `choice` with no option scripted, counts as not scripted. A scripted `choice` sums to one: the
  options a script leaves out share evenly what it leaves over, and a script summing above one,
  or naming every option and missing one by more than a rounding, counts as not scripted, with
  the sum in the error. Cause: an option left out was given no chance, so a script built an
  answer no API gives, and a threshold passed in a test that production would fail. Rejected:
  an exact sum, since Laya rounds each number on its own and a real answer of its summed to
  0.9999; scaling the script to one, which would hide the slip. A `score` legend holds each level as
  the question gave it, text or structured, as the API's own schema allows. `confidence` follows
  the formulas TypeSafe publishes for Jev.
- **A call nobody scripted fails the run,** recovered or not, with the kit's own error,
  `Unscripted`. `run` serves every name no adapter took with that error, and a script that cannot
  answer what it was asked fails with the same. Rejected: `UnknownModel` for it. A real upstream
  reports that code too, so an eval failed on a model the motty had recovered from, and `fallback`
  past an unknown model could not be tested. `sent(model)` returns its prompts.
- **Any part runs alone:** a module as it is, a middleware with a handler added in the test.
- **A real adapter in the same options makes an eval,** which asserts a rate over repeated runs,
  never one outcome. The SDK depends on no eval or container tool.

## Host side

### Host options, adapters and serving

```ts
export default serve(coder, ({ OPENAI_KEY, ANTHROPIC_KEY, TYPESAFE_KEY, REDIS_URL, JWKS_URL }) => ({
  models: [
    openai({ key: OPENAI_KEY }),
    anthropic({ key: ANTHROPIC_KEY }),
    typesafe({ key: TYPESAFE_KEY }),
  ],
  storage: redis({ url: REDIS_URL }),
  auth: jwt({ jwks: JWKS_URL }),
  limits: { duration: 120_000, calls: 10, afterResponse: 30_000 },
  report: (record) => console.log(JSON.stringify(record)),
}));
```

- **Adapters appear only in host options,** which `serve`, `mount` and the test `run` take. Plain
  objects.
- **A model adapter says which names it serves and carries a chat call, a decision call or both.**
  The first adapter that serves a name and carries the kind of call asked for takes it, so a chat
  provider and a decision provider may share a prefix. A name nobody serves is `UnknownModel`.
- **`models` is a list, read once, or a function asked once per request;** every other option
  is read once. The function is given the request as the host holds it, credential included,
  and the caller. What it throws fails that request's calls, told as any other service's
  failure is. Cause: a key valid for one request could not be used on a self-host.
- **What the host's steps hand to more than one request is frozen:** the overrides copied and
  frozen once, the limits frozen, the caller handed over as a frozen copy. Overrides that
  cannot be copied as plain data fail when the options are read, named by group, without the
  value. Cause: a motty that wrote into the shared overrides changed them for every later
  request.
- **A model adapter's `address` is the API's base with its version segment,** as in
  `https://api.typesafe.ai/v1` or a local Laya's `http://localhost:8000/v1`; every path is relative
  to it and a trailing slash is accepted. Cause: one adapter took the root and two the versioned base.
- **A provider that speaks Chat Completions with additions of its own gets its own adapter,**
  which names its address, its prefix and its dialect: the field of an assistant turn that takes
  reasoning back, whether continuity data comes and goes beside it, and what a request asks for
  reasoning with. `openrouter` and `deepseek` are the first two. OpenAI's own dialect adds
  nothing, so `openai` sends what it sent before. Cause: through `openai` at another address a
  signature was dropped silently, reasoning never went back in a tool loop, which one provider
  refuses, and a budget could not turn thinking on. Rejected: more options on `openai`, where
  every host had to know each provider's additions; guessing the dialect from the address, wrong
  behind any proxy; sending every provider's fields to every upstream, because OpenAI refuses a
  field it does not know.
- **The open-weight providers each have an adapter:** `deepseek`, `moonshot` for Kimi, `zai` for
  GLM, `dashscope` for Qwen, `minimax`, `groq`, `mistral`, `together`, `fireworks`, and
  `ollama`; `local` is for a server the host runs itself, LM Studio, vLLM or llama.cpp, whose
  dialect the host states, since it chose it when it started the server. Through `openrouter` the same models need none: live, thirty
  pairs of model and provider all answered in the router's one shape. Cause: live and by each
  provider's reference, the same model reasons under another field, is told to stop under
  another word and takes another form of schema at each provider.
- **A dialect says how thinking is turned off and how a budget is given,** in the provider's own
  field: a `thinking` type, an `enable_thinking` flag with its budget, a flag inside the
  reasoning object, a template argument, or the effort `none`. An order not to reason and a
  budget are sent so; where the dialect has no word for one, it is left out and reported, as
  for a model with an effort and no flag, or with neither. Cause: these models think unless
  told, and an order not to reason reached none of them.
- **A dialect may say that reasoning comes as a typed chunk of a content that is then a list.**
  The codec reads the thinking chunk as reasoning and the text chunk as text, and writes an
  assistant turn's reasoning back as one thinking chunk before its text, with what signed it.
  Which reader a stream gets is chosen once, when it opens, so an upstream that sends a string
  pays nothing. Cause: Mistral's content is a list while the model thinks and a string after,
  and its reference asks for the thinking back.
- **Mistral's request holds only the fields it lists, and that is the adapter's, not the
  codec's:** usage comes unasked, the seed goes under its own name, an end user is left out and
  reported. Rejected: a dialect word for each.
- **On Together, reasoning goes back under the name the model sent it by.** On Fireworks it is
  read from its field or from the text and goes back in the field alone, and a budget is not
  translated, being a cap on one model and a scale on another. Together's 403 is
  `ContextTooLong` only with Together's own error object carrying a message, and any other 403
  falls to the family's reading; Fireworks' 412 is `UpstreamRefused`, by its reference.
  Fireworks answers a wrong key as it answers an unknown model, so it is `UnknownModel`:
  nothing in the body tells them apart.
- **A dialect may say that reasoning comes inside the answer's text, between think tags.** The
  codec then reads what is between the tags as reasoning, a tag cut across two chunks included,
  and writes an assistant turn's reasoning back the same way. The tags are read only where
  these servers write them: an opening tag before the reply's first words, and one closing tag.
  After it everything is the answer, a tag the model wrote in its text or in an example
  included. A dialect may also say that the reply begins inside the thinking, for a server whose
  template opens it and sends only the closing tag. Cause: several providers and
  every local server send it so by default, and a caller was shown the model's thinking as its
  answer.
- **A dialect says which form of structured output its upstream takes.** Where it takes any JSON
  object and no schema, a schema is asked for as an object and reported, and the reply is still
  validated by the schema where the author gave one that validates. Cause: live, three
  providers ignored a schema without a word and two refused it.
- **An adapter built from a provider's reference alone says so in its tests.** The providers
  whose own API no key was held for are tested against bodies taken from their references and
  from the same models through a router; a live file is added when a key is.
- **A dialect's continuity data belongs to the Chat Completions family.** A Chat Completions
  caller is sent it and sends it back. A caller of another API is shown the reasoning text, and
  the rest is left out and reported. An upstream whose dialect has no field for it is sent the
  text, where it takes text, and the rest is reported. Rejected: a family per provider, which
  fails a caller's own history as soon as a route changes provider.
- **A request field two dialects name differently is sent under the upstream's name,** and one
  only some have is left out and reported for the others. Where a provider takes an effort or a
  budget and refuses both, the effort is sent and the budget reported, as that provider does
  when it translates the two itself.
- **An upstream's failure is recorded under the name of the provider that answered.**
- **A model adapter that speaks a chat API takes `headers` and `body` beside its key and
  address,** the same two on every one: headers for every request of the connection, and body fields in the provider's own names, as plain JSON. Cause: a
  host could state nothing else of a connection, so a beta header, a router's app headers, an
  organization, a service tier and a routing preference had no place, and the SDK guessed what a
  host that knows its model could say. Rejected: typed options per provider for each known field,
  stale with every API release, and a surface the SDK would have to know whole.
- **A connection's header adds and replaces nothing.** The credential and the headers the API
  needs are set after it, by name in any letter case. `anthropic-version` is one of them: the
  codec speaks that version, and another version is another wire. A key or a header no request
  can carry fails when the adapter is made, in the adapter's words and without the value.
- **A prefix, an `api` and a bearer's caller id are checked when the adapter is made too.**
  Cause: an empty prefix served names that began with a slash.
- **A connection's body field is a default, and the request's own field replaces it whole.** What
  a caller sent in the upstream's format, what the author set on the call and what a neutral
  option translates to are all the request's. Top-level only: a request's `thinking` replaces the
  connection's, and nothing inside is merged. Rejected: merging by depth, which no author can
  predict; a connection that wins over the request, since a host that wants to force a field can
  do it in the motty, and silently overriding what a caller asked is what the fidelity rules
  exist to prevent.
- **A connection default fills only what the request left unsaid, and never changes how a
  request's field is translated.** A request that says nothing of reasoning is sent the
  connection's reasoning fields as stated; one that says an effort, a budget or a mute is sent
  the SDK's translation of it, the same with any connection, and the connection's fields for
  reasoning are not sent. A request with no output limit takes the connection's. A default is
  replaced by the request's field of the same meaning under whichever name the dialect gives it.
  Cause: a connection's `thinking` took the form and the display from a motty that had asked an
  effort, and showed reasoning a caller had muted, with no word of either. Rejected: asking the
  connection wherever the SDK guesses a form, which is that: a host's setting reaching into what
  the motty said.
- **What an author says in the upstream's own words is sent as said.** It wins over a neutral
  option that would write the same field, and the neutral option's part that was not sent is
  reported. A hint that is not sent is reported too. Cause: an author's own `thinking` was
  overwritten by an effort stated beside it, and a hinted one dropped, both silently.
- **A connection default is the host's own statement.** It is no warning and is not checked
  against the table; a field the upstream refuses is the upstream's own error.
- **An adapter says what each of its models takes of the neutral options that differ by model:**
  the sampling settings, each with its range or the one value the model allows, and a reasoning
  effort, as every level, none, or the levels the model has a word for. It is a rule over the model's name and whether the request reasons, written once per
  provider, and a connection may state its own in its place. A provider reached through `openai`
  at another address has no rule unless the connection states one, and is sent everything.
- **The host states prices, and a call's cost is then the host's figure.** `price` in host
  options is a function of a call's model and usage that returns its cost, in the host's own
  unit. It is asked for every call that reports usage, a decision call and a stopped one too,
  and what it returns replaces a cost the upstream reported; where it returns nothing, or what
  is no cost, a figure below zero or no finite number, the upstream's stands. A price that
  throws does not fail the call: the usage goes on as the upstream reported it, and the throw
  is listed under `failed` as `price`. Cause: only a router reported a cost, so a motty that
  limited spend saw part of the bill; and where a price that threw failed the call, the tokens
  were spent and the record said none were. Rejected: a price list in the SDK, out of date
  with every release; prices on
  each model adapter, where a host that sells inference at its own rate would state them once
  per provider.
- **What the answer is read by is not a default's to change:** the model, the conversation, the
  stream and the usage in it, and `store` on Responses, where no state is held.
- **A chat connection takes no time limit.** Retry and time limits are the motty's combinators,
  and a second pair underneath would multiply them.
- **A stream that said its last event is read to the end of its body, so its connection is
  kept.** The reading goes on behind the call, for 65,536 bytes or one second at the most. A
  call stopped before its last event is cancelled as before, and a signal fired after it stops
  nothing, since whoever ends a request fires it for every call that request made. Cause: an
  upstream that ends its body in a later write than its last event was left before that end,
  which cost the connection, and 350 calls in a row opened 303 of them where a body passed
  through whole opened 2. On the Workers runtime every call opened one, and behind a local
  Workers runtime a call to a real provider reached its first byte about 300 ms sooner once the
  connection was kept. Rejected:
  cancelling at the last event, which pays for a new connection on every call; holding the last
  event until the body ends, where an upstream that holds its body open would hold the answer;
  and reading on with no bound, which an upstream that never ends its body would leak.
- **A decision server's own request fields are the host's to state, on the adapter, never the
  author's on a call.** `typesafe` takes them as `body`, beside `headers`, in the server's own
  names. Laya takes controls Jev refuses outright, a longer state limit, a confidence floor, a
  language hint: Jev answers any field it does not list with a 400. A call's own state,
  questions and model always win over them. Rejected: passing them per call from the motty,
  which would break the same motty on the other server.
- **A name Laya did not take is `UnknownModel`, unless the host says its server routes by
  itself.** Laya answers a name it does not know with a checkpoint its router chose and a 200,
  and only then says what the router detected in the state; an alias or another casing it
  honours says nothing there. The adapter's `routes` skips the check, so a motty that names a
  Jev model runs on a local Laya. Cause: a misspelt Laya model was answered by another
  checkpoint, unseen. Rejected: reading the router's reason, free text Laya may reword; a table
  of Laya's names in the SDK; the option on a call, the server being the host's to know. Not
  caught: a misspelt name sent with a language or a task hint, or to a server in strict mode.
- **A decision call's default limit is two seconds, for a hosted server and a local one alike.**
  Measured from a client that opens a new connection each time, Jev answers in 270 to 450 ms
  and a warm, local Laya in 10 to 250. A Laya checkpoint that is not preloaded took 14.6 s on
  its first call, which the limit ends as a timeout: the host preloads its checkpoints or
  raises `timeout`. Rejected: a longer default for a local server, which would hide a server
  that is not ready behind a wait no route can afford. A `timeout` that is no finite number
  of zero or more fails when the adapter is made.
- **What a router's provider said is told after the router's own message.** A router may say only
  that its provider refused and put the provider's words beside that; the most specific message
  there is, is the one a caller can act on.
- **The types of host options and adapters, the choice of adapter and a host's steps are in the
  core's host import.** `serve` and the test kit both take host options and must act on them
  alike, and neither may depend on the other. Rejected: a package of their own, one more for three
  types and two functions; and keeping them in `serve`, which a test would then install with its
  codecs.
- **A host's steps are one function, which every host that takes host options calls.** Given the
  motty and the options once, it checks the contract version, sends each call to its adapter and
  puts the namespace ahead of every storage key. Given a request, it removes the credential,
  asks the auth adapter who the caller is unless the host has said, makes the stop signal from
  the caller's own signal and
  the duration limit, and adds the request id and the setting overrides to the report. `serve`
  keeps only the wire, and `run` only its test defaults and its result.
- **Given a request's headers and no request, the same function says who the caller is and does
  nothing else.** The credential is read and the auth adapter asked exactly as for a request,
  and what the adapter throws is reported the same. Cause: the edge learned the caller of a
  model list by letting in an empty chat request, so a host that gives its models per request
  was asked for them, and a time limit was started, for a request that calls no model.
  Rejected: the edge reading the credential itself, a second reading that would drift from the
  first; a step of its own beside the function, the same.
- **The wire API says which headers carry the credential; the auth adapter only verifies a
  token.** Each codec lists its credential headers in the order they are tried: `authorization`
  and `api-key`, the header Azure's clients send, for the two OpenAI APIs; `x-api-key` and
  `authorization` for Anthropic Messages. Only the request's own API's headers are tried, and
  the first whose token the auth adapter knows signs the caller in; the host removes those of
  every API the edge serves. Cause: the adapter named the headers, so
  an Anthropic caller, whose client sends `x-api-key`, could not sign in, and with no adapter
  the credential reached the motty; and an Anthropic client that sent a placeholder `x-api-key`
  with the real token in `authorization` was not signed in.
- **A bearer token is read as RFC 6750 says,** the scheme in any case and then exactly one token,
  the way Elysia's bearer plugin reads it. A key header's value is the token as it is. With no
  token the adapter is not asked, and there is no caller unless the host stated one.
- **Auth is the host's own to write: the `auth` option takes any object with a `verify`
  function,** which is given the token and answers the caller or nothing, at once or later. A
  lookup in the host's own table of keys is one; `jwt` and `bearer` are two ready-made ones and
  nothing more. Cause: how a caller is proven differs with every host, and a self-host exists to
  be fitted to its own. Rejected: a helper that makes an adapter, a name for a plain object.
- **A signed token is verified by `jwt`,** which is `jose` and supports what `jose` supports: a
  key set, a public key or a shared secret, exactly one of them, returning `sub` as the caller's id
  with no `store` and no lookup. Unlike Elysia's jwt plugin, the key sits with the host, never in
  the motty.
- **Every check of a signed token beyond its signature is the host's to name.** Beside the way of
  verifying, `jwt` takes the checks `jose` takes, all of them optional and handed on as given:
  the issuers, the audiences, the algorithms, a tolerance for clocks, the claims a token must
  state, its longest age, and what else the library has. A check that is named is held, and one
  that is not is not made; the times a token itself states are always held. Cause: whose tokens
  a host takes, for whom and for how long is its own business. Rejected: requiring an issuer, an
  audience and an expiry of every host, which was tried: it refused hosts whose tokens are their
  own business and made the ready-made adapter useless to them. Rejected: a list of checks of
  our own, a copy that falls behind the library's.
- **A signed token with no expiry is accepted.** Whether tokens expire is the issuer's decision,
  and a long-lived service token is a real case; one that states an expiry is held to it, and a
  host that wants one of every token names it among the claims a token must state. Rejected:
  requiring `exp`, which refuses tokens the host's own issuer chose to make.
- **`jwt` names no algorithms of its own.** Cause: with none named, `jose` takes only a signature
  of the kind the key is for. A public key verifies no HMAC signature, so the classic forgery, a
  token signed with the public key as a secret, signs nobody in; a shared secret verifies no
  asymmetric one; a key set offers no key for an HMAC one; an unsigned token is never taken.
  Rejected: algorithms fixed by the kind of key, a second guard over one the library holds, and
  one the host could not change.
- **A key set that cannot be read is the host's failure and is thrown,** not told as no caller,
  which would tell a caller with a valid token to sign in again. Its message never holds the
  address, and what the runtime threw while fetching is not kept with it: an address may carry a
  token in its query, the thrown message is in the record the host's `report` is handed, and a
  runtime may write the address into its own failure. What the verifying library says of an
  answer it could not use is kept as the cause. The address is held to the rule of every
  adapter's address: one that holds a name or a password, or is no address, fails when the
  adapter is made, in words without it.
- **A plain bearer secret is verified by `bearer`,** which gives the caller the id the host
  named. The secret must itself be a token a header can carry, and it is compared in a time
  that does not depend on what was sent.
- **With no `auth` adapter there is nothing to verify against,** so `auth()` rejects the request
  unless the host stated the caller itself.
- **A host that authenticated the request itself states the caller as an argument, in process.**
  The handler a mount returns takes a third argument to `fetch`, whose `caller` is who is
  asking. The auth adapter is then not asked, and the credential headers are removed as
  always. Cause: a host with a server of its own has already proven the caller by its own
  means, and had to prove it a second time through an adapter. Rejected: a header the host
  trusts, which a client forges unless every hop strips it and which the motty would read;
  a wider auth adapter, which still starts from a token the host may not have.
- **One storage adapter, not a driver collection.** `redis` speaks the Redis protocol, tested on
  Valkey, and is Bun's built-in client. Its server must keep a key's expiry on a plain write:
  Redis 6 or any Valkey. Rejected: an adapter per provider, redoing its client.
- **The server behind it is Valkey 9, hosted with its I/O threads on.** It is the one the adapter
  is tested on, and the fastest maintained one on a motty's mix of reads, writes and increments.
  The threads change its speed and not its answers, so a test run may leave them off.
  Any server that passes the adapter's tests still works. Rejected: Dragonfly, whose script call
  is ten times slower on one connection and whose licence is not open; Redis 8, as fast, but
  AGPL or source-available; KeyDB, fast, but with no release since Redis 6; Garnet, whose
  increment overwrites a list instead of failing; Kvrocks, which falls behind under many
  connections.
- **`increment` is the same IEEE double addition in every store.** `redis` adds in its own
  script and writes the total in seventeen digits, in place of the server's float increment,
  and a total that is not finite is refused by both stores with the same message. Cause: the
  server adds in a wider float and prints a rounded decimal, so 0.1 + 0.2 read 0.3 on a real
  store and 0.30000000000000004 on the test store.
- **`limits` caps a request's duration, its model calls, its after-response work and its body.**
  The host enforces the duration by firing the stop signal; the bundle enforces the calls and
  the after-response work; the edge enforces the body, which no other host has.
- **Every time is milliseconds and every size is bytes, so no name carries a unit.** The limits
  are `duration`, `afterResponse`, `body` and `calls`, the edge's times `keepAlive`, `drain` and
  `receive`, a stored value's time to live `ttl`, a decision adapter's `timeout`, the `first`
  and `stall` of `timeout`, and an error's `retryAfter`. Cause: the names had three conventions
  at once, bare milliseconds in the limits and the edge, an `Ms` suffix in the adapters, the
  errors and `timeout`, and seconds in `store`. Rejected: a suffix on every name, which says
  the same thing in each of them once there is one unit.
- **`settings` overrides the motty's defaults,** any subset, typed. Rejected: mapping environment
  variables onto settings by name: flat strings onto typed groups, and a second way to set a value.
- **The overrides are typed by the motty they are given with:** any of the groups its settings
  part declares, each with any of its values. A wrong group name or value type does not compile.
  A motty held without its types takes any overrides. The values are still checked per request by
  the motty's own schemas, which the host cannot reach: the description carries no settings.
- **`report` receives one record per request:** the record the contract delivers, to which the
  host adds the request id, the setting overrides in effect, as `warnings` what the edge left
  out of the reply it wrote, and as `failed` what a service of the host threw. What an upstream
  call left out is in that call's entry.
- **`report` may return a promise, and the SDK's part in a record ends when that promise
  settles.** Settling says the host's report has finished with the record, not that it
  succeeded, which only the host's own code can know and tell. A rejection is caught, since
  nobody is left to tell. Cause: a host that writes its records to a database or a queue had no
  way to keep its process alive until one was written.
- **A mount hands the host the delivery of each record through `waitUntil`,** a field of the
  third argument to `fetch`. It is called once for every request that was let in, before the
  reply is returned, with work that settles when the host's report has finished with that
  request's record and never rejects. A request refused before it was let in has no record and hands over nothing.
  The argument has the shape of a Workers execution context, so a mount can be a Workers
  module's default export and its records are waited for with no code of the host's. A
  `waitUntil` that throws costs the host its wait and nothing else, so the request still runs.
  Rejected: the delivery as a second value returned from `fetch`, which breaks the plain shape
  every runtime expects and is the promise beside the stream the contract already rejected;
  a record fetched later by id, or sent to a webhook, the awkward part of other gateways.
- **`close` waits for the records still being delivered, within the `drain` it already had.**
  It is the same work `waitUntil` is handed, so there is one mechanism and not two. Cause: a
  server that shut down after its last reply lost the records still on their way.
- **The edge keeps the stream alive, notices a caller who left, and drains at shutdown.**
- **A request stopped at shutdown ends with the error a new request is refused with then,**
  `Overloaded`, and the caller and the record are both told the server is shutting down. Cause:
  stopped with no reason, a caller still connected was told it had left; told by code alone, it
  read that an upstream was overloaded.
- **`mount` is the edge alone; `serve` is `mount` and the process.** `mount(motty, options)`
  returns `fetch` and `close` for a host that has a server of its own. It installs no signal
  handler and stops no listener. `serve` is for a serve file, whose default export Bun starts: it
  also drains on a stop signal, stops the listener and ends the process. Cause: with one function
  for both, a host that mounted two motties lost its own shutdown to ours.
- **`mount` runs wherever the web-standard APIs and the async context do; `serve` stays Bun's.**
  A host on a runtime with no environment to read states its options from what it holds. On
  the Workers runtime the host turns the request signal flag on: without it a caller who left
  is never seen, and the request runs to its end. Cause: `mount` read the environment by Bun's
  own name, so on any other runtime it threw before a request arrived.
- **In development a serve file is reloaded by Bun's own `--watch`,** which starts the process
  again when the motty or a file it imports changes; the SDK adds nothing for it. Rejected:
  `--hot`, which evaluates the file again in the same process, so the handlers of earlier
  evaluations pile up and a Ctrl-C no longer drains the requests in flight: after 31 reloads
  there were 31 SIGINT handlers, and a request in flight was reset on Ctrl-C. Rejected: a
  watcher of the SDK's own, a copy of what the runtime has.
- **A server passed to `fetch` means one thing:** this request is taken off its idle timeout,
  once its body has arrived whole. Until then the server's idle timeout stands.
- **A body has a time to arrive in, the edge's own `receive`, sixty seconds unless the host
  says otherwise.** It is counted from the request's arrival to the body's last byte, under `serve`
  and under `mount` alike, and a body that is late is answered 408 and the connection closed.
  Cause: a socket that sent the headers of a chat request with a length of 1000, nine bytes
  and then nothing was still open after 12 s on a server whose idle timeout was 2 s and whose
  duration limit was 3 s, with no credential: the request had been taken off the idle timeout
  before its body was read, and the duration limit starts only once a request is decoded. The
  same socket on a path that reads no body was closed at 4 s. Sixty seconds is nginx's wait
  for a body and Node's for the headers; Node gives the whole request 300 s. Rejected: the
  idle timeout alone, which a byte sent now and then never trips and which a mounted edge
  does not have; starting the duration limit at arrival, since that limit is optional and is
  the time the motty may run, which a slow upload would then spend. A path that is not chat
  reads no body, so the server's own timeout is all that holds its socket.
- **A body is at most `limits.body`, 32 MB unless the host says otherwise.** A stated
  length over the limit is refused before a byte is read; the bytes are counted as they are
  read as well, so a body with no stated length, or more of it than was stated, ends at the
  limit. The answer is a 413 in the API's own error shape, `request_too_large` on Messages,
  and the connection is closed. Cause: an anonymous 64 MB request to a motty that asks for a
  caller was read and parsed whole, about 131 MB of resident memory, before its 401. The
  default is from what the upstreams take: Anthropic refuses a Messages request over 32 MB,
  OpenAI takes files of 50 MB together and states 512 MB for a request of images, and a
  request holds its images and files as base64. Of the gateways, LiteLLM's limit is unset
  unless the host sets one, Vercel's functions take 4.5 MB, and Bun's own server stops at
  128 MB; no limit was found stated for Portkey or for Vercel's AI gateway. So the default is
  the smallest limit an upstream served here has: what is over it one of the three refuses
  anyway, and a host that sends more to another raises it. Rejected: a megabyte or a few, the
  proxy's habit, which refuses one photograph; no default, which is the defect.
- **Every limit and every time of the edge is checked once, when the host is made,** in words
  that name the option: a time is a finite number of zero or more, the body limit and the call
  limit whole numbers of zero or more. Cause: a body limit that was no number refused nothing,
  with no word of it; and only the body limit and the time to receive were checked there, the
  call limit and the after-response time on each request, and the duration and the edge's
  other two times never, so a mistake in one of those was told to a caller or to nobody.
  Rejected: reading such a value as the default, which hides the host's mistake. A host that
  speaks the contract without these steps is still checked by the bundle, on each request, for
  the two limits the bundle enforces.
- **What the headers alone settle is settled before the body is read:** that the server is
  shutting down, the content type, and the stated length. Whether a caller is needed is not
  among them. A motty says it needs a caller with a part in its chain, which may stand on one
  route only, and the route is chosen from the decoded request: so the edge cannot refuse an
  anonymous request without it, and bounds what one can cost by the two limits above instead.
  Proving the token first would refuse nobody either, since an unknown token is no caller and
  only the motty says whether that matters. Rejected: refusing at the edge whenever the motty
  has `auth()` somewhere, which closes a route the author left open.
- **The model list is shown as a chat request would be let in.** Where the motty has `auth()`
  anywhere in it, the list and each model in it are answered only to a caller the host's
  adapter knows, by the same reading of the same headers, and anyone else gets the 401 a chat
  request gets. A motty with no `auth()` lists to anyone, as it answers anyone. Cause: the
  list answered with no credential on a motty that needs a caller, so who serves what could
  be read by anyone who reached the host. Stricter than chat where `auth()` stands on one
  route only: a list has no route to choose by. Chat still answers to any model name.
- **Every reply to a request that was let in carries its id, the one on the host's report,**
  in the header the API's own clients read it from: `x-request-id` on the two OpenAI APIs,
  `request-id` on Messages, whose error body holds it as `request_id` too, as Anthropic's
  does. A whole answer, a stream and a failure carry it alike. Cause: only an answer that
  succeeded held the id, inside its body, so a caller who reported a failure had nothing to
  match it to a record by. A request refused before it was let in, for its body or its path,
  has no record and so no id. A request the auth adapter threw on has one where the host was
  told of it, a model list's too: what was thrown that is no SDK error is on a report, and
  the reply carries that report's id.
- **A host may state its own id for a request, and it then stands wherever the SDK's would.**
  It is the `id` of the third argument to `fetch`, and it is the id the motty reads on the
  request, the one in the reply's header and in the ids of the reply's body, and the one on
  the report. Cause: a host that already numbers its requests had two ids for each and a
  table to join them by. It is 1 to 128 characters of letters, digits, `_`, `.`, `~` and `-`,
  being written into a header and into ids in a body. Any other id makes `fetch` reject before
  the request is looked at, since it is a mistake in the host's own code and a reply would hide
  it from the host. Rejected: putting a made id in its place, which breaks the host's matching
  with no word of it.
- **The edge has the last boundary.** Whatever is thrown while a request is taken in is answered
  in the format of the path, and a path that cannot be read is the caller's mistake, a 400. Cause:
  such a path was answered with the server's own error page.
- **A path nothing is served at is a 404 in an API's error shape, never plain text.** The shape
  is that of the API whose paths it lies under; under none, Messages for a request that sends
  `anthropic-version`, as only that API's clients do, and the OpenAI shape for any other. Cause:
  a client whose base address lacked `/v1` was answered `Not found` as text, which its library
  could not read as an error.
- **A missing field is worded the same on every API.** Cause: a body with no model was told
  "The body needs a model" on two APIs and "model must be a string" on the third, and neither
  is an upstream's own wording, so nothing was kept by the difference.
- **Caller headers are not forwarded upstream, but for the ones that say what the body may
  hold.** Such a header is the request's own as a body field is: it is read among its family's
  hints under its own name, and written back as a header to an upstream of the same API. As a
  hint it reaches no upstream of another API, and an author names one among a call's hints the
  same way. A request's header replaces a connection's of that name whole, as a body field does.
  - Anthropic Messages: every `anthropic-*` header but the version, which the codec speaks one
    of. The rule is the API's own names and no list of them, as Claude Code's gateway guide
    asks: the betas change with each release, and a list would leave out the next.
  - OpenRouter: `x-anthropic-beta`, from a hint or an option only.
  - The two OpenAI APIs and the other providers document no such header, so they have none.
  Cause: a body's own fields travelled without the header that turns them on, so the first
  request of Claude Code was refused upstream for `context_management`. Rejected: sending on
  every header but a denied list. A token for a service the motty calls is sent in a header no
  API names a credential, and a list cannot know it, so it would reach the model provider; a
  header left out fails aloud, and a secret sent on is never seen.
- **A call may state headers, and a connection forwards none of them unless the host names
  them.** `forwardHeaders` lists the names, or is `true` for a host that trusts its motty with
  every header outside a fixed set. Cause: a drop-in endpoint was wanted for harnesses whose headers the SDK
  cannot know. No denied list is complete, and letting the connection win protects only the
  names the host stated, so a gateway that acts on a header the host never set, one that
  names where a request goes on or which account pays, would send the host's credential where
  an untrusted motty chose. Rejected: a denied list alone as the default.
- **The connection's own headers, credentials, cookies and the headers that describe the
  caller's body are never sent under either form, and the connection's and the API's own
  headers win over a call's.** Whatever the call's `Connection` header names is never sent
  either. The common headers that say where a request came from are left out unless the host
  names them, since a host may front its own gateway. What is left out is a warning on the
  call, by name and never by value. The test kit applies the same rules for what a call may
  state and holds no headers of its own. Cause: live, a forwarded host was refused by both
  providers, and one harness header turned a working request into a refusal when it travelled
  with a body it did not match.
- **A header no request can carry fails the call as the motty's own mistake, and a stated value
  is not cut from an upstream's failure.** A caller's relayed header already crossed HTTP, so
  a malformed one is the motty's. A header that would be sent and is stated in two letter cases
  fails the same way, since a request carries a name once and the order the two were written in
  would choose the value; one that is left out anyway stays a single warning. The cut keeps
  the host's credentials out of an error, and a call's headers are already held by the motty
  and its caller; cut, a provider's sentence naming the beta value it refused came back
  without it. Rejected: answering the caller with a 400; cutting a stated value as a
  connection's is.

### Wire fidelity

- **Three chat APIs:** OpenAI Chat Completions, OpenAI Responses, Anthropic Messages,
  caller-facing and upstream. One codec each, outside the core; a fourth is an SDK change.
- **A message is an ordered list of parts:** text, image, file, audio, reasoning, tool call, tool
  result, citation, refusal, and opaque provider-specific parts. `text` is the shorthand.
- **Inside one family nothing is lost:** reasoning signatures, logprobs, metadata, and a cache
  marker where the upstream takes one.
- **A reply's likelihoods are never dropped:** where no text came for them, they are told on an
  empty text before the reply ends.
- **JSON nested deeper than 512 levels is not read.** A caller's body that deep is
  `InvalidRequest`, saying so; an upstream's event that deep is one that cannot be read, and
  its failure body that deep is told by its status. Cause: a body a hundred thousand levels
  deep was answered with a bare server error.
- **What only one family reads is carried in two maps.** `provider` holds what changes the meaning:
  an upstream whose family the map has no entry for fails the call with `Unsupported`. `hints`
  holds what may be dropped. A refusal names the fields it could not carry, never their
  values. Cause: an author could not tell what to strip.
- **What a call to one of the caller's own tools holds for another family alone never refuses
  the call.** It is encoded as if it held none, and a hosted call, a result and every other
  part keep the refusal. Cause: an author who built history from an answer's chunks copied
  `provider` onto the part, and the next call to a model of another family, as in a
  `fallback` across families, failed with `Unsupported`. Rejected: leaving it to each
  encoder, under which Chat Completions encoded such a call and the other two refused it.
- **A `provider` map with an entry for each family it may reach is sent to each its own.** An
  entry for another family was never this API's to carry, and an empty entry says the author
  has nothing to add for this one. Cause: a map with entries for two families failed on both,
  so no prompt with provider options could be given to a `fallback` across families. Rejected:
  one map, where an adapter had to know every family's vocabulary to tell them apart, and a
  flat map of unknown options, which reached whatever upstream the request was routed to.
- **A provider with two APIs has one more key, which both read.** `openai` is read beside
  `openai.chat` and `openai.responses` in a request's options, and for a hint on a message or
  a part: the entry an upstream is sent is the shared one merged with its API's own, and
  either one, even empty, is an entry for it. The merge is shallow: a field under an API's own
  key replaces the shared key's whole field, however deep either goes. For a tool, a tool
  choice, and what a message or a part says in `provider`, the shared key is no entry: the two
  APIs share no shape there, so only an API's own key is one, and without it the call fails
  with `Unsupported`.
  Cause: which OpenAI API is spoken is the host's choice, so an author who wrote
  `openai.responses` had to know the host. Rejected: flat prefixed names, which work only where
  an unread field is ignored and lose the empty entry; one switch that requires every option to
  be taken; letting an option pick the API, which is the host's to choose.
- **Under the shared key, a field only the other API has is not sent.** As an option it fails
  the call with `Unsupported`, naming the field, so a `fallback` moves on; as a hint it is left
  out and reported. One that says nothing, a null, an empty list or an empty object, fails no
  call and is not sent. A field both have, or neither is known to have, is sent as said, and a
  refusal is the upstream's own error, so a list gone stale never drops a field. Each OpenAI
  codec names the fields it refuses, from OpenAI's reference, and none it writes itself. A
  field under an API's own key is the author addressing that API, sent unchecked; a caller's
  unknown fields are still decoded under the key of the API it spoke. Cause: every comparable
  SDK that shares one key drops such a field silently.
- **Across families the common set is translated:** messages, tools and tool choice, structured
  output, reasoning effort, stop, max tokens, sampling, finish reason, usage.
- **Nothing that changes the meaning is dropped.** It fails that call with `Unsupported`, so
  `fallback` moves on. A hint, such as a cache marker, is left out, or nothing could cross families.
- **Nothing is left out silently.** Encoding a prompt returns, beside the request, what the API
  had no field for. The transport puts that on the call's finish event as `warnings`, after any
  the upstream sent itself. The core keeps them with the call, so an author reads them in `calls`
  and the host in the record. Cause: a seed, a reasoning budget and a tool's failure flag were left
  out and nothing said so; the finish event had the field and no codec wrote it. A call that fails
  carries none: its error is what there is to know.
- **Each option is classed once, for all three APIs.** One table says, for every neutral option
  and part kind, which APIs have no field for it and whether it is a meaning or a hint. Every
  encoder asks the table and is tested against it. Cause: the two OpenAI codecs shared a list and
  the Anthropic one kept its own, so a message's name failed one call and was dropped from
  another. A name tells speakers of one role apart, which changes the meaning, so it fails both.
  A penalty of zero asks for nothing, on every API.
- **What is sent changed is reported as what is left out is.** An effort the API has no level
  for goes as the nearest one, and an instruction the API takes only elsewhere is moved there;
  each is a warning.
- **A limit that differs by model is the upstream's, except for sampling and a reasoning
  effort.** The codec fails only what the API itself has no form for. What one model takes and
  another refuses is sent, and the upstream's own error is passed on as such: a reasoning
  budget, a forced tool choice.
- **A user identifier longer than 64 characters is left out of a request to the Responses API
  and reported, never a failed call.** One within the limit is sent as said, and Chat
  Completions is sent one of any length. Cause: Claude Code names its caller in 150 characters
  on every request and the Responses API refuses more than 64, so no session of it ran on an
  OpenAI model; Chat Completions took the same 150 from OpenAI and from a router. The limit
  applies to whichever identifier would be sent, the caller's or the host's. Rejected: cutting
  the identifier short, or sending one said with less weight in its place, either of which
  would name a different caller.
- **A sampling setting or a reasoning effort the model does not take is left out and reported,
  never a failed call.** A value outside the model's range is sent as the nearest one inside it,
  and reported; it is never rescaled, since one means the model's own distribution on every API.
  A value equal to the one a model allows asks for nothing and is neither sent nor reported.
  Where two settings may not be sent together, the temperature goes. Cause: live, nine of
  thirteen current Claude models refuse any temperature but one and most OpenAI reasoning models
  refuse it unless told not to reason, while nearly every OpenAI-style client sends one; and a
  panel that asked every seat for an effort failed on the seat that cannot reason.
- **A reasoning effort is a ladder, and a rule says which levels a model has a word for.** A
  level the model lacks goes as the nearest it has, the higher of two equally near, and is
  reported. An order not to reason goes to a model with no word for it as its lowest level.
  The levels are asked of the model before the API translates anything, so what is sampled
  follows the level that is sent. Cause: live, of 13 Claude and 37 OpenAI models no two
  generations took the same levels, OpenAI's two APIs differed for one model, and a rule that
  said only whether a model takes an effort sent the rest to a 400. Each model names its levels
  in its own refusal, and the lists are those. Rejected: reading the levels from a refusal and
  sending again, a second request for every first call to a model.
- **A rule says whether a Claude model may be left to set its own thinking.** An effort alone
  turns that on only where the model takes it. A model that thinks only on a budget is sent
  the effort with no thinking, and thinking a caller hinted that way is left out, each
  reported. Thinking said in Anthropic's own words is sent as said. Cause: Opus 4.5 takes an
  effort and refuses adaptive thinking, so every effort from an OpenAI-style caller failed, and
  a Messages caller a motty sent to an older Haiku failed the same way. Rejected: a budget made
  up from the effort, a number no caller said.
- **The rule names the closed set of older models and holds the rest to the newest behaviour.**
  A model released after the SDK is then treated as the latest known one, and a rule is wrong
  only for a provider that goes back on a change. Rejected: a table of every model, out of date
  with every release; sending again without the option after a refusal, a second paid request
  and a refusal one provider tells only in prose.
- **OpenAI's rule names two closed sets:** the models that always sample, and the exact names
  that sample unless told to reason. Every other name is held to the newest behaviour, sampling
  only beside an order not to reason, and a name that only starts like an exact one is not
  listed. A model that never samples is not named: each one refuses the order not to reason as
  well, so the newest behaviour leaves its sampling out of every request it accepts. A search
  model neither samples nor takes an effort. A model that can reason is sent no top-p of zero,
  which Chat Completions refuses: the nearest value is sent and reported. The effort levels are
  closed lists of exact names too, and a name not listed is held to the newest, which has every
  level and no order not to reason. Chat Completions has a rule of its own: it has no word for
  the highest level, and takes one level more from the o-series.
- **A router that drops what a model does not take is given the rule of the model's own
  provider,** by the prefix of its name, so what would be dropped silently is left out here and
  reported.
- **A request's sampling setting replaces the connection's of the same meaning,** also where
  the rule then leaves the request's out: what a connection states is a default, never what is
  sent in place of what was asked.
- **A dialect says whether its upstream takes top-k,** which OpenAI's own Chat Completions has no
  field for and a router and several providers have.
- **Every sampling setting is a hint.** Top-k and the penalties are left out and reported where
  an API has no field for them, as a seed is. Cause: they failed the call on the APIs without
  the field while a temperature the model refused was to be left out, two answers to one case.
- **A setting said in the upstream's own words is outside the rule.** It is sent as said, and a
  refusal is the upstream's own error.
- **Media goes in the form it was given in:** by address, by bytes or by an id the provider gave,
  each where the API has that form, and the call fails where it has not. Rejected: fetching an
  address to send its bytes, and uploading bytes to get an id, each a request or a stored file
  made for the caller that nobody asked for; transcoding, a codec per format.
- **Bytes of no named media type are never given one.** They go where the API takes bare bytes, a
  file on the two OpenAI APIs, and fail the call elsewhere. Cause: one codec sent such an image as
  PNG and the other two failed it. Rejected: guessing the commonest type, which mislabels the
  rest; failing a file too, which refuses the bare `file_data` both OpenAI references describe.
- **A kind of media the API's reference rules out fails the call:** a file that is no PDF in Chat
  Completions, one that is neither a PDF nor plain text in Anthropic Messages, an image type its
  schema does not list, sound that is neither wav nor mp3. What the reference leaves to the model
  is sent.
- **A video is a file of a video type.** One dialect has a part for it and none of the three APIs
  has, so elsewhere it fails as a file of that type does. Rejected: a neutral part kind for what
  one provider reads.
- **A dialect says which media a message takes** beside OpenAI's: a file of any type or by
  address, or a picture alone; sound of any format, or none; a video; media in a tool message;
  the field pictures a model made come in and go back in. Cause: one provider's file part took an
  address and another's was a picture with no object around it, and both were sent OpenAI's.
- **An unknown field of a Chat Completions media part is kept by where it sat:** inside the
  part's object it is a hint; beside it, provider data, as an unknown field of a message is. Each
  goes back to the same place.
- **An image's `detail` is held under one key that both OpenAI codecs read.** It changes cost and
  accuracy, and Chat Completions and Responses both have the field, so it crosses between them; to
  Anthropic Messages, which has none, it is a hint of another family and is dropped. Rejected: a
  field on the neutral image part, for what one vendor reads; a hint per API, which lost it between
  two APIs that both take it.
- **A cache marker is written to an OpenAI API only where the connection says the upstream takes
  one.** A dialect of Chat Completions says so, and the Responses codec is made with the same
  word; the `openai` adapter takes that word from the host, for either API. Unsaid, the marker
  is left out and reported, as for OpenAI's own models. Cause: most of OpenAI's own models answer
  400 to `prompt_cache_breakpoint`, so a hint failed the call, and they cache by themselves.
  Rejected: writing it always, which is that; never, which lost explicit caching through a router
  that honours it.
- **A router's `cache_control` on a Chat Completions content part is the neutral cache marker,**
  lifetime included, as the API's own breakpoint is. Cause: it was kept as a hint of that API, so
  it reached no Anthropic upstream and nothing said so.
- **A dialect says which marker its upstream takes,** OpenAI's breakpoint or a router's
  `cache_control`, and the second is written with its lifetime. Cause: a marker read with its
  lifetime from a caller was written to the same router without it.
- **Which marker a router takes differs by its API.** OpenRouter's Responses API takes OpenAI's
  breakpoint, gives it no lifetime and ignores a `cache_control` on a content part; its Chat
  Completions takes `cache_control` with one. Cause: measured there, a part's `cache_control`
  wrote and read 0 tokens and the breakpoint 9,129.
- **A JSON schema is held as strictly as its caller's API holds it.** Left unsaid, Chat
  Completions takes a schema loosely and Responses strictly, and Anthropic Messages always
  constrains: each decoder writes its API's default, and both OpenAI encoders always say `strict`.
  A schema strict mode refuses is the upstream's own error. To Anthropic a loose schema is sent
  constrained and reported. Cause: a loose schema failed on Responses, and a strict one went loose
  to Chat Completions. Rejected: leaving it unsaid, which means a different thing on each API.
- **A prompt with no strictness said asks for none,** on both OpenAI APIs alike. Cause: live, a
  schema with an optional key, as a schema library writes one, is refused by strict mode on both
  APIs and by a router that leaves strictness unsaid. An author who wants the guarantee says so.
- **Results of tools answered one turn each go to Anthropic Messages in one user turn.** Adjacent
  turns that hold only tool results are joined in order, each result with its own fields and
  marker; a turn with fields of its own stays apart. Cause: the two OpenAI APIs send a message or
  an item per result, and Anthropic asks for all results of one assistant turn together.
- **A tool call an Anthropic upstream ends with no input text is told as `{}` arguments, and
  empty arguments a caller of an OpenAI API echoes are read as an empty input.** Cause: such a
  call reached those callers as an empty string, which no client parses and OpenAI itself never
  sends, and the echoed turn was then refused, so every loop with a tool that takes no
  arguments ended on its second turn.
- **A custom tool call is told by the upstream's mark or by the custom tools the caller
  declared,** so it is written as custom whichever API answered. Cause: one a Responses
  upstream answered was written to a Chat Completions caller as a function call whose
  arguments were not JSON.
- **Free-form input is a custom tool's, whoever declared the tool.** A call an upstream marked
  custom is written as custom, and one echoed in a caller's history with text for input goes
  back as custom, with no tool list consulted. Cause: Codex declares its tools inside an input
  item for some models, so the request named no custom tool, and its shell call came back as a
  function call and went up again with its input quoted as JSON. Towards Anthropic Messages,
  which takes only an object, such a call is refused. Cause: it was written there as a string,
  which that API rejects.
- **What an upstream says of a tool call beyond what a codec reads reaches the caller, and what
  the caller echoes of it goes back.** On the way down it rides on the call's chunk as its
  family's own; in a caller's history it is a hint, so an upstream of the same family is sent
  it and another is not. A codec carries every such field and names none, so the next one a
  provider adds is kept. What a codec writes of a call itself is never taken from what is
  carried. Cause: a call to a tool in a namespace reached Codex without its namespace, which
  Codex then could not route, so no subagent started through a motty; a signature a provider
  put on a call was lost the same way on Chat Completions, and the next turn refused.
  Rejected: an echoed call's fields as what changes the meaning, with which a conversation
  begun on one family failed on its first turn with another.
- **A `tool_call` chunk may say that its call has ended, and a Responses caller is written the
  call done then, otherwise when the reply ends.** A reader says so only where the upstream
  showed the call whole, so an item marked incomplete, or the last block of an Anthropic
  reply, which a length limit may have cut, ends with the reply. Cause: Codex records calls
  only from done events, in the order they come, and every call was written done at the end
  of the reply, after items the upstream sent later. No chunk said a call was whole, since
  pieces of calls made together may interleave and a motty may reorder them. Rejected: ending
  a call when an item of another kind opened, which could write a cut free-text call as whole.
- **What a Chat Completions tool definition holds beyond what is read is a hint of that API,**
  where the Responses and Messages codecs keep a definition's unread fields as provider data.
  Cause: provider data of one family is refused by an upstream of another, so a chat caller's
  extra field on a tool would fail the whole call on every other family, and Chat Completions
  is the API every router and many providers speak with extras of their own. Rejected:
  provider data, for that reason. The cost is that a hint is left out towards another family
  with no refusal, so a router's `cache_control` on a tool definition reaches no Anthropic
  upstream.
- **What a Responses or an Anthropic upstream says of its reply as a whole beyond what is read goes
  back to a caller of the same API, and never in place of what the writer states.** Nor are the
  counts taken from it, which are the SDK's and which a motty may have changed. Of a Responses
  response only what tells the outcome goes back, `end_turn` and the reason an ending was
  incomplete, because the rest of that object echoes the request the upstream was sent and not
  the one the caller made. Cause: Codex reads `end_turn` to decide whether to ask again.
  Rejected: carrying every field but a listed few, with which a motty relayed its upstream's
  cache key and safety identifier to its caller.
- **A block passed whole is told when it ends, when the next block starts, or when the stream
  fails.** So blocks are told in the order they came, and one whose input was cut is told as
  failed input, never as a complete block with empty input. Cause: the input of a tool the
  upstream ran for an MCP server comes in pieces after the block opens, so a block told at
  its opening reached the caller with empty input.
- **A function tool with no parameters decodes to an empty object schema, on both OpenAI APIs.**
- **A citation's title is its own `title` when that is text, otherwise the document's,** whole
  and streamed alike.
- **File bytes of a named type that came with no name are given one for an OpenAI API:**
  `file.pdf`, from the type. Cause: both refuse `file_data` with no `filename`, and an Anthropic
  document has no title to give. Bytes of no named type are given none.
- **An order not to reason goes to Anthropic Messages as the lowest effort, and is reported.**
  No one form turns thinking off: live, each current model took a different one or none, and
  the lowest effort is the one request every current model takes. An author who knows the model
  says its form in the upstream's own words. Rejected: `disabled`, which failed the call on most
  current models; sending nothing, which leaves a model at its default effort.
- **A Chat Completions stream that reaches its done mark finished.** With no reason said it
  stopped; one that ends with no mark was cut. Cause: a router's reply of sound alone says no
  reason, so a complete reply ended as a failure worth another, paid, try.
- **A Chat Completions stream chunk whose `error` is a sentence is a failure with that message,**
  as a failed response is. Cause: a cut answer was recorded and delivered as complete, and no
  retry or fallback saw a failure.
- **A dialect may say that the reason an ending is told apart by is the provider's own.** A stop
  sequence is then kept as the upstream's word for the ending, which an Anthropic Messages caller
  is written back; where a dialect cannot tell it from a stop, nothing changes.
- **A dialect states its own words for an ending, and whether cached tokens come at the top of
  usage.** OpenAI's listed reasons are read first, and a reason neither lists is `other`, as
  every unlisted reason is to the plain dialect.
- **A provider's own ending is the nearest shared reason, with its word kept beside it, and no
  reason of its own.** Mistral lists five finish reasons and defines none; two are its own.
  `model_length` is the length ending. `error` is a failure, as an ending an upstream tells as
  one is: the call fails as `UpstreamFailed` and may be retried. Cause: `error` was read as an
  unlisted ending, which a Chat Completions caller is told as a normal stop. Rejected: passing a
  provider's word through as the reason, which would make every caller and every fallback
  handle unknown words.
- **Reasoning a caller asked for is shown.** To Anthropic Messages an effort goes as adaptive
  thinking and a token budget as manual thinking, each with its summary asked for, or left out
  when the caller muted reasoning. The caller picks the form its model takes by what it asks, and
  a model that refuses the form answers with its own error. A caller of Anthropic Messages said
  its own form, which is sent as said: an effort sent alone stays alone. Cause: current models
  keep the summary back unless asked, so a caller who asked for reasoning saw none and nothing
  said so. Rejected: sending the effort alone, which is that; choosing the form by model name,
  the table per model already rejected.
- **A hint addressed to another family is not reported.** The `hints` map is keyed by who reads
  it, so an entry for another family was never this API's to carry. Rejected: a warning for each,
  which every call across families would carry and nobody could act on.
- **A reply never answers as if content it cannot hold was not there.** What the caller's API has
  a form for is written in that form: an inline image the model made is an image generation item
  in Responses, and an image by bytes or by address an entry of `images` in Chat Completions.
  Content that is the answer and has no form ends the reply the way that API ends a failed one,
  with `unsupported`: a file that is no image in Chat Completions, any file in Anthropic Messages,
  a result of a tool the upstream ran, a provider part of another family. A citation with no form is left out,
  because it annotates the answer and is not the answer. Cause: such a reply was a 200 with
  nothing in it. Rejected: a text note in its place, words the model did not say. An author who
  wants such an answer sent anyway rewrites it without that content.
- **A picture a Responses upstream made is the same neutral file a Chat Completions upstream's
  is,** with its item kept as that family's own: a Responses caller gets the item unchanged and a
  Chat Completions caller the picture. Cause: read as an opaque item, it failed the reply to a
  caller of another API after the image was paid for.
- **A picture a Responses upstream made with no format named is of the type its own bytes begin
  as:** PNG, JPEG, GIF or WebP. The type is read, not guessed: bytes that begin as none of
  these are given no type, and the item stays that family's and fails elsewhere. A format the
  upstream names is not checked against the bytes. Bytes a caller sent with no type named are
  still never given one.
- **A picture a model made is written to every Chat Completions caller in `images`,** one
  dialect's field, as reasoning is written under the names two dialects read. OpenAI's own API
  returns no picture, so its clients are sent nothing they must read. Rejected: failing the
  reply, which kept a generated image from every caller of this API.
- **What a model goes on from its reasoning with is not the answer.** A signature, an encrypted
  reasoning item and redacted thinking reach a caller of the same family unchanged. To a caller
  whose API has no form for them they are left out and reported as a warning, whole and streamed
  alike. So a tool loop from a caller of one family to a model of another loses the model's
  reasoning between turns, and the report says so each time. Cause: one kind of data was treated
  three ways, two dropped silently and one failing the reply. Rejected: failing the reply, which
  threw away a complete answer over data the caller could not have used.
- **Reasoning is written to Responses as a summary,** whole and streamed alike, whichever API the
  model answered in. Thinking from Anthropic Messages is a summary that API made. A Responses
  upstream's own item is passed on as it came. Cause: written
  as `reasoning_text` content, it was shown by one of four client libraries tried live; OpenAI's
  own API writes only summaries, and those are what clients read. Rejected: content for a
  model's own words from Chat Completions, the more exact name, which most clients never show
  to a caller who asked to see reasoning.
- **A reply's content is classed as a request's is.** What fails a call when sent to an upstream
  of another API ends a reply to a caller of another API: a hosted tool call, a provider part.
- **The codec writes the honest reply; the edge tells the request.** The edge stops the request
  with the same `unsupported` error, so the upstream call ends and the record says why. What it
  left out of a reply is on the report as `warnings`. Rejected: the edge alone holding the rule,
  which left a codec used by another host able to write the empty reply.
- **A call's cost is carried in usage, as information:** the figure the host's prices give, or
  else the one the upstream itself reports, in its own unit, US dollars from OpenRouter, per call
  and added up where usage is. The SDK holds no price and decides nothing by a cost: no limit,
  no routing, no billing. A motty may: it reads the figure with the usage of its own calls, and
  what it does by it is its own logic. Only the total is carried; a breakdown stays its
  source's. Rejected: leaving it out as the Hub's, which threw away a figure already worked out.
- **A reported cost is written to the caller in every wire format, under the name the upstream
  gave it,** and is absent when no call reported one. None of the three APIs has the field; the
  router that reports it adds it to the usage of all three alike, and a client that does not know
  it ignores it. Rejected: writing it only to a caller of the upstream's own family, since a total
  over calls has no one family; a warning when it is left out, for what the caller never sent.
- **The model-list endpoint is answered. The rest is rejected with a clear error:** embeddings,
  images, audio, batches, files, realtime; `n > 1`; server-held Responses state.
- **Token counting is not served yet.** A count depends on the model, which is unknown before
  routing, and clients fall back to an estimate. When served, it is each format's own endpoint.

### The Hub

- **`serve` is for a self-host; the Hub brings everything itself.** A motty on the Hub has no serve
  file: the Hub supplies the same things through the same contract, with nothing configured by the
  author.
- **The SDK owes the Hub three things:** a motty describes itself when loaded, the bundle is
  reproducible, and every model call goes through one path the host supplies and counts.
- **On the Hub a call's usage and cost are the Hub's figures,** said where the call ends, a
  stopped call's too. So a motty that limits spend limits what its request is billed.
- **The model catalog is outside the SDK:** its data changes without an SDK release. The SDK owes it
  only that a name worked out during a request can be called.
- **A bundle needs only web-standard APIs and the async context.** At load it builds its chain
  and does nothing else: no network, no timers.

## Packaging

| Package | Kind | Holds |
| --- | --- | --- |
| `@mottyjs/core` | Core | `motty`, `model`, `fallback`, `race`, `retry`, `timeout`, `answer`, `reroute`, `think`, error classes, types |
| `@mottyjs/store` | Plugin | `store` |
| `@mottyjs/decision` | Plugin | `decision`, and the questions `choice`, `score`, `noul` |
| `@mottyjs/auth` | Plugin | `auth()` |
| `@mottyjs/settings` | Plugin | `settings(groups)`, and the type `Settings` |
| `@mottyjs/test` | Test kit | `run`, `fake`, `on`, `memory`, `Unscripted` |
| `@mottyjs/serve` | Host side | `serve(motty, options)`, `mount(motty, options)` and the three codecs. Never in a bundle |
| `@mottyjs/adapters/*` | Host side | Model providers (`openai`, `anthropic`, `openrouter`, `deepseek`, `moonshot`, `zai`, `dashscope`, `minimax`, `groq`, `mistral`, `together`, `fireworks`, `ollama`, `local`, `typesafe`), storage (`redis`), auth (`jwt`) |

- **One package per row, all under the npm org `@mottyjs`.** Only the core has no dependencies,
  and plugins compile into the motty's bundle.

- **The bundle is one JavaScript file whose default export is the motty,** built reproducibly.
- **The bundle is not minified, and a script in the package's manifest builds it** into a `dist`
  folder beside that manifest. The size is capped, and the size gate measures the file that
  ships. Cause: minifying renamed the error classes, so an error's `name` was two letters, and a
  stack named no function; it saved a seventh of the compressed size and no measurable load
  time. Rejected: removing whitespace only, which keeps names and loses lines; a source map,
  five times the bundle and holding the author's sources.
  Also rejected: a build file in every package, a second place for what the CLI will own.
- **Bun only for now.** `serve`, the adapters, the bundler and the test runner are Bun's. A
  motty's own code uses web-standard APIs and the async context, so it runs on the Hub too. No
  other runtime is promised.
- **A published package holds its sources and, beside them, their declaration files. Bun runs the
  sources; a consumer's compiler reads only the declarations.** Cause: a compiler checks every
  source it is led to under the consumer's own flags, and skipping library checks skips
  declaration files only. Measured on a project installed from the packed packages, with sources
  alone: under Bun's recommended config, which leaves exact optional properties off, 7 errors,
  all in the host side; under a config that also does not allow an import path ending in `.ts`,
  358 more, one for every such import. With declarations the same project gave none under either
  config, with library checks on and off, on TypeScript 5.9 and 7.0. Rejected: making the sources
  pass under looser flags, which is every import rewritten, still one consumer flag from the next
  error, and every consumer paying to check the SDK's sources. Also rejected: compiling to
  JavaScript, a second artefact beside the code the tests ran, for a runtime that needs none.
- **The declarations are built when a package is packed, from the one shared compiler config.**
  They are never committed. Rejected: a build config in every package, as the layout rules
  reject a compiler config in every package.
- **Inside the workspace a package is always read as its sources,** through an export condition
  that only the workspace's compiler config names. Cause: once a pack had left declarations
  behind, the workspace's own type check read them in place of the sources and failed, and the
  type-cost gate would have measured them. Rejected: deleting them after every pack, which one
  failed pack defeats.
- **The served motty is the default export of the file `main` names.** A named export is a part.
- **Identity comes from `package.json`:** `@acme/coder` is `acme/coder`. A release changes one file.
- **No manifest file.** Behind the mark is a description collected at load, never by parsing source.
  It holds the SDK's version, the root's `name`, and the name of every part used. A host that
  states no `namespace` uses the root's name as the `store` namespace.
- **The description does not list models yet.** `model(name)` runs when a file loads and is not
  tied to a motty, so a list would hold the names of every motty loaded in the process. It could
  never hold a name worked out during a request. The host sees each name when it is called.
- **The description does not carry settings.** They are defined in code and checked by the types. A
  second copy in the description could disagree with the code.
- **The chain is assembled once, not per request.** Hooks, routes and parts are flattened into one
  chain when the host first reads the mark. Rejected: generating it as code at run time: the bundle
  stays free of run-time code generation, so stricter runtimes stay possible. The build may generate
  it.
- **Accepted on purpose.** No filesystem, native modules or run-time code generation. A bundle size
  cap. A host's time limit per request: a job that outlasts it is a service a motty calls.

## Author's file layout

A root file, default-exporting the motty; a models file; a settings file; a serve file; a middleware
folder, one file each; a modules folder, one folder each; a test folder; an evals folder.

- **Files follow the request, not a pattern.** In a module's folder one file declares the chain; the
  plain functions it calls sit beside it in files named for the step they serve. Rejected: MVC
  roles, a `service` and a `schema` file per module: no data layer gives a schema file its job, and
  a service file mixed choosing with answering. Also rejected: one flat file per part, mixing both.

## Deliverables

1. **The core**: the Core category with the contract a part and a host are written against: what a
   host supplies, the mark, the function behind it. Done when every Core rule has a test
   driven through that contract with a stub host, under strict types, and the measurements exist.
2. **The test kit and the four first-party plugins.** Done when the example's offline tests pass.
3. **Host side**: codecs, streaming and cancellation at the edge, `serve`, the adapters, on Bun.
4. **Packaging**: the bundle; the example runs on Bun from it. The Hub follows.

## Deliberately out

- A `transform` hook: it is `beforeHandle`. An exact tokenizer: providers differ, and none is small.
- Decision questions answered by a chat model: structured output covers it; later, an adapter.
- Rate limiting and spend budgets in the SDK: the host's job, or a motty's own logic. Validating the host's environment: theirs too.
- Recording real replies to replay: a second way to script. A telemetry client: `report` is enough.
- Response caching, a memory plugin: `answer()` and `store` cover them. List-by-prefix: no use yet.
- Setting the response status and headers: what a caller sees of routing is the host's to decide.
- The Hub's side, its keys, publishing, settings page and billing: decided with the Hub, not here.
- Secrets for hooks: the host's business, the Hub's or a self-hoster's. No SDK mechanism.
- A price list: prices are the host's, stated as a function or counted by the Hub. The SDK
  counts tokens and latency, and carries the cost a host or an upstream gives.
- Performance and execution-time limits: defined by the Hub.
- A CLI: later. Until then the bundle is made with Bun's bundler.
