# Motty SDK — Core plan

How `@mottyjs/core` is cut into scopes and in what order they are built. What the core does is
decided in the architecture document; this one decides only its inside.

## Layout rules

- **One package per packaging row, in one Bun workspace.** One shared strict compiler config, one
  version catalog. Rejected: a config per package, as in miniapp-sdk, where one drifted unchecked.
- **One folder per layer, one kebab-case file per scope.** The contract, the host options and the
  two entry files sit above the folders: they are what code outside the package is written against.
  No folder file re-exports its neighbours: an import names the file it needs, so the layer it
  reaches into shows in its path. Rejected: a flat folder, where twenty files hid the layers, and
  tma.js's folder per feature, four files each, for a core this size.
- **A file past 300 lines is two concepts.** Split it by concept, never into a part one and two.
  Rejected by example: Elysia's 8,000-line builder, the AI SDK's 3,500-line stream file.
- **Types live with the scope that owns them.** No shared types file, no utilities file.
- **What two codecs share lives in one shared place, and no codec imports another.** Cause: three
  copies of the number reader, and a codec reading another's internals.
- **A layer imports only layers listed above it in the scopes table, and no import forms a cycle.**
  Checked by lint.
- **Two hand-written entry files, one for authors and one for hosts, with named exports only.** A
  test holds the exported names of each as sorted lists, values and types apart, so the public
  surface changes only on purpose. Types do not exist at run time, so the test reads them from the
  entry file's text. Rejected: re-exporting everything.
- **Tests sit in their own folder, laid out as the source, one file per scope, same name.** Every
  test goes through the host contract with a stub host; type tests are checked by the compiler,
  not the runner.
- **No dependencies, no side effects on import.** The package is marked free of side effects.

## Scopes

Each layer imports only from the layers above it in this table.

| Layer | Scope | Owns | Does not own |
| --- | --- | --- | --- |
| Data | `message` | Parts, messages, the request, the prompt | Any wire format |
| Data | `errors` | The base class, `define`, the known classes, facts for the host and for the caller, the stop's error | Where an error lands |
| Data | `event` | The stream event union, usage, finish reason | Buffering |
| Contract | `contract` | The mark, the version, what the host supplies, the description, the record | Running anything |
| Request | `context` | The async context, the two phases' signals, `calls`, `limits`, opening and counting a call, what the host supplied | What runs in a phase, its time limit |
| Request | `wait` | Every wait on code the core does not control, the core's own signals and how one follows another, running a step under a signal, the timer every time limit uses | Which signal is in force, the stop's error |
| Request | `structured-output` | Telling a Standard Schema, parsing and validating JSON | Buffering |
| Request | `replay` | One reader's pass over an answer's buffer, left when that reader's signal fires | Buffering |
| Request | `answer` | The buffered, re-readable answer and `answer()` | Model calls |
| Request | `output-schema` | A Standard Schema as the JSON Schema sent upstream | Validating a reply |
| Request | `model` | `model(name)`, the one call path to the host, how a stopped call ends | Counting a call, switching models |
| Request | `switching` | `fallback`, `race`, abandoning a call | Clocks |
| Request | `retry` | `retry`, its waits between tries | Provider knowledge |
| Request | `timeout` | `timeout`, the limit on a first chunk and on a silence between chunks | Provider knowledge |
| Request | `think` | Offering progress to the edge | Writing the stream |
| Chain | `builder` | The chain's types, what they refuse, and the message for each refusal | Building |
| Chain | `assemble` | Flattening a chain once, deduplication, the description | Per-request work |
| Chain | `route` | The table, `reroute`, `path`, the entry boundary, the loop check | Hooks |
| Chain | `delivery` | The stream the host reads: progress, the answer, the one terminal event | Phases |
| Chain | `record` | What a request did, collected only for a host that asked, and its one delivery | Running anything |
| Chain | `after-response` | The after-response hooks, their time limit, what failed or was not run | The phases before the answer |
| Chain | `run` | The phases, early answers, error boundaries and the last one | Routing |
| Chain | `motty` | `motty()`, part identity, the checks at load, freezing, the mark on each motty | Assembling or running |
| Host | `host-options` | Host options typed by the motty they are for, the adapter shapes, sending a call to the adapter that serves its name, a host's steps for one request | Any provider, the wire, running a request |

## Seams

- **The Data layer imports nothing outside itself.** It is plain types and the error classes, so the test kit,
  the codecs and the adapters build on it without pulling the runtime in.
- **A model call is one function type: a prompt in, an event stream out.** Non-streaming is the
  same stream collected. Rejected: the AI SDK's twin generate and stream methods, two paths to keep
  in step. Combinators are functions over that type and know no provider.
- **A stream has exactly one terminal event, finish or error.** Rejected by example: 1flowbase
  carries files of terminal recovery because its stream does not promise one.
- **An answer buffers its events once and replays them to each reader.** Rejected: the AI SDK's
  tee per accessor, which buffers without bound when a branch goes unread.
- **Only the stream's semantic events are in the stream.** Raw wire observation is the host's
  report. Rejected by example: 1flowbase's diagnostics inside the answer stream.
- **The bundle does everything itself; a host may also enforce limits of its own.** The host
  contract is an abstraction over the runtime. Against the barest host, one that only holds keys,
  makes the calls it is asked for and translates the wire, the bundle alone handles retries,
  fallbacks, a time limit per call, call counts, error boundaries and what the caller is told when
  nothing recovered. A fuller host, the Hub, enforces its own time limits, call limits and keys on
  top. Rejected: a core that relies on the host for any of it, which would make a self-host a lesser
  runtime.
- **A host's enforcement reaches the motty through the same contract,** as the stop signal or a
  failed call's facts, never a side channel. So a motty is written once and cannot tell the hosts
  apart, and its boundaries still get the last word on what the caller sees.
- **No SDK class instance crosses the host contract.** Bundle and host hold separate SDK copies, so
  `instanceof` would fail across them. The request and the events are plain data, apart from two
  standard web objects: the caller's headers and the stop signal. A failed call crosses as facts:
  a code, a status, a message, a retry hint. The core raises it as its own class, so `instanceof` works for
  the author. A request that fails crosses back the same way, as facts the host only formats.
- **Facts say when what was thrown was no SDK error, and the mark stays when they are raised
  again.** It is what keeps such a message from a caller. Rejected: telling by the code, which a
  base error raised on purpose shares; by the stack, which does not cross.
- **Progress crosses in the answer's own stream, as an event type of its own, ahead of the first
  chunk.** It is not a chunk, so it can never be part of an answer or of a model call's output, and
  an edge that does not know the type ignores it. Rejected: a reasoning chunk with a flag, which a
  consumer that ignores the flag reads as the model's words. Also rejected: a second stream, as the
  AI SDK had and removed. Reading two streams at once loses the order between them, and cost about
  three times as much per event on Bun.
- **The record is built only when the host passes a function to receive it.** It is delivered
  once, after the after-response work, and names any hook that failed there. The stream has ended
  by then and is never changed by it.
- **One contract version, a whole number of its own.** Rejected: the AI SDK's type tree per spec
  version with proxy adapters between them, and 1flowbase's version inside each capability name.
- **The host is reached through one second import path of the core, `@mottyjs/core/host`.** Plugins,
  the test kit and `serve` use it; an author's motty never does. The main entry stays the one-page
  API. Through it a plugin's hook reads what the host supplied for the running request and the
  signal now in force: `auth` reads the caller, `store` the storage, `settings` the overrides. The
  path is public: anyone's plugin may use it.
- **A plugin's own call takes the path a model call takes.** One place opens a call under the
  call limit, the signal and the record, and counts it when it ends. `model` and the function a
  plugin calls both use it. So the decision plugin needs no counting of its own. The request's
  state is not exported. Rejected: exporting it, with which a plugin could leave a call open for
  good. What a plugin reports for its call is taken as given: a plugin is the author's own code.
- **The host entry carries every type the contract's signatures use,** so a codec names any of
  them from one import. The author entry carries what a motty is written with.
- **Host options are no part of the contract.** The contract is what crosses between a bundle and
  its host; host options are how a self-host and a test describe a host before one exists.
- **Host options are the last layer, and only the host entry imports them.** They are written in
  the contract's types and in the type of a motty, which types the setting overrides. Of the chain
  they import that type and nothing that runs. Rejected: keeping them in the contract layer and
  working the overrides out in `serve` and in the test kit, the same type twice.
- **Turning host options into what the contract takes is done in one place.** The version check,
  the choice of adapter, the storage prefix, the caller, the stop signal and the report are steps
  every host that takes host options owes. They sit beside the choice of adapter for the same
  reason: `serve` and the test kit must do them alike and neither may depend on the other. It is
  host-entry code, so it is in no bundle. Rejected: each host doing them itself. They had drifted.
- **The host entry also gives a host the buffered answer a model call returns.** A host that hands
  the events of a request back as an answer builds it with the core's own code.
- **Every wait on code the core does not control goes through one scope that also watches the
  signal,** in two forms: one promise, and a stream for its whole life. The wait belongs to
  whoever waits, so an answer made outside a request is still watched by the request that sends
  it. Rejected: a check at each place, which left the hooks and hand-made streams unwatched.
- **The builder produces data, the runner consumes it.** A chain is an immutable list of steps;
  nothing in the builder knows how a request runs. This is what keeps it out of one giant file.
- **Two different parts of one name and seed are refused over the whole motty, a route's entries
  included, when the route is added.** Cause: a module routed to was checked only within itself,
  so the second part was dropped on that path without a word. Two entries never on one path are
  refused too, since the core cannot tell a part meant to be defined once from any other. Parts
  of one name made by separate `motty()` calls are each their own. The refusal says what to do:
  use one part everywhere, or make each from its own `motty()` call. Rejected: checking when the chain is
  assembled, which is later and has no line of the author's in its stack.
- **The chain's type has two accumulators: the context and the route table.** Rejected: Elysia's
  eight generics and an overload per scope, the source of its unreadable errors.

## The model seam

One model call crosses the contract once. The core's side is the `model` scope; the other side is
a model adapter, host code written against the contract.

- **In: a model name, the prompt, the stop signal. Out: an event stream.** The prompt carries the
  options the SDK knows as typed fields and the ones it does not in two maps it never reads: one
  for options that change the meaning, which reach the provider or fail the call, and one for
  hints, which may be left out.
- **A finish event's warnings stay with the call.** An adapter says there what it left out of
  the prompt; the core copies them into the call's entry in `calls`, which is also the record's.
  Cause: the answer kept the event but showed only its reason, so a warning reached nobody.
  Rejected: a reader on the answer, a second place for what `calls` already holds per call.
- **The core knows names, never providers.** It owns counting in `calls`, the limits, the signal
  and the combinators. No endpoint, header, wire format or stream parser is in a bundle.
- **An adapter owns one provider family end to end:** which names it serves, the endpoint, the
  credential, the provider's headers, encoding the prompt, parsing the stream into events,
  saying what each model takes, and naming a failure by its neutral code. A new family is a new
  adapter, not a core change.
- **A host says whose failure a failed call is.** One an adapter raised before the request left
  the process is its own and is recorded so; any other is the upstream's. Cause: every error
  that came from a host was marked the upstream's, a refusal to encode included.
- **Storage's `increment` is optional on the contract.** A host without it fails the call that
  asks for it, so the contract's version stands.
- **An adapter is a wire codec plus a transport.** A provider that speaks an existing wire format
  is that codec with another address; only a new wire format needs a new codec.
- **An adapter takes a credential and an address, and the address defaults to the provider's own.**
  A self-host passes its own real key and nothing else. A host that proxies passes its proxy's
  address and whatever credential the proxy accepts. Same adapter, same code path.
- **What a host supplies, it supplies per request.** So a credential may live as long as one
  request, and an adapter is a plain object cheap enough to make each time.
- **A credential never enters the motty's code.** It stays inside the adapter the host made.
- **Nothing of the Hub is in the SDK.** The Hub is one more host built on this contract and these
  adapter options; whatever else it has is its own code. Rejected: a Hub adapter or a Hub
  mode here, which would tie an open SDK's releases to one service.

## Performance

- **Assembly does the work once.** Hooks flatten into one array per phase with flags for the phases
  a motty has, so an absent phase costs nothing per request. Taken from Elysia 2's route
  descriptor; its generated handlers are excluded by the ban on run-time code generation.
- **One async-context entry per request,** never per hook. Measured on Node,
  entering the context costs about 140 nanoseconds and reading it about 6, and
  entering once per hook made ten hooks 3.4 times slower. On Bun both cost under 10 nanoseconds.
- **A chain is assembled when a host first reads its mark, not when it is built.** Every builder
  call returns a new motty, so assembling each one would repeat the work: measured on Bun, 4.6
  times the cost at load. A motty used only as a part is never assembled.
- **Part identity is the name and the seed in canonical form, a map key,** merged upward on `.use`,
  as in Elysia. Rejected: a hash. The core has no dependency to supply a good one, and a weak one
  adds collisions.
- **A signal follows another by one listener, removed when its owner ends.** Rejected:
  `AbortSignal.any`. Measured on Node against one long-lived host signal, each call cost one to
  three microseconds and the heap grew with every request; a listener added and removed cost about
  a tenth of a microsecond. A request whose stream is neither read to its end nor closed is still
  held for as long as the host's signal lives: its one listener must stay to stop it.
- **A request that ends normally constructs no error.** An SDK error captures a stack: about a
  quarter of a microsecond on Bun and over two on Node. Ending a phase stops what is still open
  without one; the error is made only where a wait turns the stop into a throw.
- **A stream is watched by one listener for its whole life, not one per event.** Measured, a wait
  made per event cost about 150 nanoseconds an event, most of what a 200-chunk answer cost.
- **Nothing is adopted unmeasured.** Two choices are settled by benchmark before their scope is
  built: async iteration against web streams for the event stream, and a synchronous lane that
  turns async only on a real promise, which Elysia reports faster on Bun.
- **The event stream is an async iterable.** Measured on Bun against web streams, it was ahead on
  every path the core uses: about 1.5 to 1.8 times end to end, 3 to 4.5 times through a transform,
  which every hook that rewrites an answer pays again, and 1.3 to 1.9 times replaying a buffer to
  two readers. Rejected: web streams inside the core, cheaper only at the edge, where the bridge to
  a body is paid once per response. Not measured: V8, backpressure, cancellation.
- **Hooks are always awaited; there is no synchronous lane.** Measured on Bun with one awaited
  handler after the hooks, as every request has, the lane saved at most a quarter of a microsecond
  on fifteen hooks that await nothing, and cost up to 150 nanoseconds when an early hook was async.
  Rejected: a second code path through every phase for a gain that only shows when nothing at all is
  awaited. Not measured: V8, an early answer, thrown errors.
- **A chunk's events are read into a list, not yielded through a generator of their own.**
  Measured on Bun decoding a Chat Completions stream, a generator inside the stream's async
  generator cost about 210 nanoseconds an event of 950. What a dialect adds is still chosen
  once per stream.
- **What a reply says of itself is kept in a record of fixed shape.** Rebuilt from a spread on
  every chunk, it cost about 130 nanoseconds an event.
- **Parsed JSON is taken as JSON, unwalked.** A parser returns nothing JSON does not have, and a
  key named as the prototype is an own key; the walk that let the type say so cost about 110
  nanoseconds an event against the 180 parsing took. A copy is made from entries, so that key
  stays a key. Depth is counted in the text, outside strings, and only in text longer than
  1,024 characters, which a plain event never is: about 0.4 microseconds for a 2 kB body.
  Rejected: counting it by that walk of every parsed value.
- **The event-stream reader makes the three line breaks one, once per network chunk, and then
  searches for line feeds only in what came with that chunk,** so a line of any length is read
  once. Cause: searching all it held again for every chunk, 8 MB in one line took 150
  milliseconds; it takes under 2. A regular-expression split per chunk, a replace per line and
  a join per event cost about 50 nanoseconds an event more. The reader stays an async generator: a
  generator layer costs about 52 nanoseconds an item and a hand-written iterator 24. Rejected:
  an iterator written by hand, which about half a microsecond on a 20-chunk answer does not pay
  for. Together with the three rules above, decoding fell from about 0.95 to 0.42 microseconds an event.
  Not measured: V8, a real network.
- **A read that an adapter's stream rejects is told by the core in its own words, and asked for
  by the host once, when the stream is closed.** A throw when the adapter is called is told by
  the host's steps. Rejected: a handler on every read in the host's steps, one promise and one
  turn per chunk, about 90 nanoseconds an event.
- **A credential's headers are built once, when an adapter is made, not per call.**
- **The link rule and the cuts are linear in the length of what the upstream said.** Measured,
  a 200 kB rate-limit body of sentence breaks took 686 milliseconds and takes 3.
- **Encoding to Anthropic Messages is linear in the turns and the citations it gathers.**
  Measured, 80,000 consecutive tool messages, a body of 4.3 MB and well inside the body limit,
  held the single-threaded host for 9.5 seconds, and one text with 80,000 citations for 3.6;
  they take 26 and 14 milliseconds.

## Bun by layer

- **Core: none.** Web-standard APIs and the async context only. The async context is the only
  import a bundle of the core has. Bundles target Node, because the browser target replaces the
  async context with an empty module and the bundle then fails at load.
- **The async context stays.** Rejected: passing the request to every call by hand, so that the
  core could run on engines that have no async context. The hosted platforms on those engines end
  a response after two minutes or less, too short for a motty. A replacement for the async
  context, tried on those engines, gave one request another request's answer when two ran at once.
- **Tooling: all of it.** Workspaces, catalogs, isolated installs so a phantom dependency fails;
  the bundler with its metafile for size; the test runner; `tsc` for the published JavaScript,
  the declarations and type cost.
- **`serve` and the Redis adapter: all of it,** decided with that deliverable. `mount` and the
  other adapters are web-standard. The core plan only leaves room: the
  caller's abort signal reaches every upstream call, and the event stream maps onto a direct body.

## Gates

Baselines are recorded at the first milestone; each gate fails a change, not a release.

- **The example itself is measured for size, type cost and reproducibility; time per call keeps a
  chain modelled on it,** its packages replaced by parts of the same shape. That gate is the
  core's. Rejected: timing the example's own chain, which would add its plugins and its schema
  library to the ratio, so a change in either would fail a gate on the core.

- **Size:** the minified core, and the example's bundle, from the bundler's metafile. The bundle
  measured is byte for byte the one the example's own build script writes.
- **Type cost:** compiler instantiation and type counts, measured on the core and the example's
  root file, which leaves its serve file and so the host side out. Five percent over baseline
  fails. Counts, not seconds, which vary by machine. Taken from Elysia 2. The compiler runs with
  one checker: with several, each checks some of the files with its own cache and the counts are
  added up, so renaming a file changed the total. Rejected: measuring the whole project, where
  every new test changed the count.
- **Time per call:** a request through a stub host with no hooks, and with the chain modelled on
  the example. Each is timed against the same subject built from the base commit's core, in one
  process, the two taking turns: where the branch left the main branch, or the parent commit on
  it. Fifteen percent over fails. Cause: a ratio to a baseline recorded on another machine read
  a third to four fifths over with no change, so the gate allowed 75% and passed a real
  regression of 17%. Rejected: a baseline recorded on the CI runner, which still needs a quarter.
  **The reading is the median over a thousand rounds of fifty calls.** Cause: over fifteen rounds
  of five thousand calls, unchanged code read up to 1.21 with every core busy and once failed on
  the runner at 1.153, and a core made 17% slower failed 31 times in 40 on a quiet machine and 15
  in 40 on a busy one. Over the short rounds unchanged code read 0.96 to 1.06 in 120 readings,
  quiet and with every core busy twice over, and the slowed core 1.13 to 1.22, failing 114 times
  in 120. Rejected: measuring again when a reading is over and failing only if both are, under
  which the slowed core failed 27 times in 40 quiet and 6 in 40 busy. Rejected: four times as
  many long rounds, which took four times as long and still let the slowed core pass 19 times in
  40 busy. Rejected: pairs of single calls, as serving is timed, where the same slowdown read 14%
  on the shorter subject.
- **Serving:** a served request on each of the three APIs, streamed, and one whole, each timed
  against the same path built from the base commit, in one process, the two taking turns. A
  quarter over fails, one limit for all: the same code against itself read 0.95 to 1.06, and a
  path made half again slower never read below 1.43. It measures nothing where there is no base
  commit.
- **Rivals:** the same work through motty and through the Vercel AI SDK, Mastra, LangChain JS
  and TanStack AI, on one stubbed upstream, the SDKs taking turns: time per call, cold start
  and bundle size. A rival must take more than 1.1 times motty's time and more than its bytes.
  Rivals are dev dependencies of the workspace alone, never of a package, and no file of a
  package or an example may import one, which is a gate of its own. The tracing switches a
  rival reads from the environment are cleared before a rival loads, so a developer's shell
  cannot slow one. An entry motty does
  not yet lead is marked as expected to fail, so it turns the gate red the day it passes. One
  is so marked: a text call that is not streamed, against LangChain, which parses one body
  where motty always reads a stream.
- **Reproducibility:** two builds of the example give the same hash, on a pinned Bun version.
- **Surface:** the exported names of both entries match the held lists.
- **Imports:** a bundle of the core is built from the core's own files and imports the async
  context and nothing else.
  A bundle of the example is built from its own files, the core, the plugins and its schema
  library: nothing of `serve`, the adapters or the host options is in it.
- **Runtimes:** one set of host cases runs on Bun and on the Workers runtime: a streamed
  answer, a whole one, a refused caller and a caller who leaves, each with its record. The
  example's bundle is loaded as a module beside the host side, byte for byte as its build
  script writes it. Bun is the control, so a case that fails on one runtime alone is that
  runtime's. The `workerd` binary is a dev dependency of the workspace alone. A last case
  holds that a run of streamed requests, each answered by one model, opens far fewer upstream
  connections than it makes calls. An adapter once left a body before its end and paid a
  connection for every call, and no gate saw it, because the other gates put a stub in place
  of `fetch` and this one never counted. Rejected: an emulator of the runtime, a second thing
  to trust where the runtime itself is one file; a test file per runtime, where a case written
  for one is missing for the next; timing a real socket, where a network filter on one
  developer's machine put about 40 ms on every loopback connection, so a time would have
  measured the machine and a count does not.
- **Declarations:** both entries, and a class defined on the base error, emit declaration files.
  A plugin is shipped with them.

## Milestones

Each ends with its scopes tested, through the contract from the milestone that can run a request.
Two and three share no scope and run in parallel.

1. **Workspace and gates.** The workspace, compiler and lint config, and every gate running against
   an empty core. Done when a change over budget fails.
2. **Data and contract.** `message`, `errors`, `event`, `contract`, and the stub host the tests use.
   Done when the stream benchmark has picked the stream primitive.
3. **Chain types.** `builder`, `motty`. Done when the example's chains type-check with route names,
   reroutes and derived values inferred, and the type budget is recorded.
4. **Model calls.** `context`, `structured-output`, `answer`, `output-schema`, `model`, `switching`,
   `retry`, `timeout`, `wait`, `replay`, `think`. Done when every rule under models, answers and progress has a test.
5. **Lifecycle.** `assemble`, `route`, `delivery`, `run`. Done when every rule under lifecycle,
   routing and errors has a test, and the synchronous lane is kept or dropped on its numbers.
6. **Surface.** The two entry files, the mark on the motty, the record, the description, the
   surface and import gates. Done when the first deliverable's own test holds: every Core rule
   tested under strict types, measurements recorded.

## Deliberately out

- A functional library or a result type for the public API: errors are thrown, as decided.
- Build-time generation of the flattened chain: only if a measurement of assembly at first use asks for it.
- A release tool of our own, a custom test helper layer, a benchmark framework beyond one script.
- Splitting the core into more packages: the layers are files, and the bundler drops what is unused.
