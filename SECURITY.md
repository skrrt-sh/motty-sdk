# Security

## Reporting a vulnerability

Report it privately, through GitHub's private vulnerability reporting: on this repository open the
**Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request
for it. Say what is affected, how to reproduce it, and what a motty, a caller or another origin
came to hold that it should not.

The packages are pre-release, at version `0.0.0`. A fix is made on `main`; no older version is
maintained.

## In scope

- The packages under `packages/`: the core, the plugins, the test kit, `serve` and the adapters.
- A credential or a caller's token that reaches a motty's code, a caller or another origin against
  the stance below.
- A request that is let in, or told who its caller is, wrongly.

Out of scope: the three examples as deployed services, a provider's own API, and the hosted Hub,
which is not in this repository.

## The stance

The decisions are in [ARCHITECTURE.md](ARCHITECTURE.md), with their causes. In short:

- **A motty's code is not trusted with a credential.** A provider key stays inside the adapter the
  host made. It never enters the motty's code and never reaches a caller.
- **The credential headers a caller sent are removed before a motty sees the request:** those of
  every API the edge serves, every occurrence, whatever one holds, with an auth adapter or
  without one. So a motty never sees the key or token that proves who the caller is to the host.
- **An adapter's secrets are cut from all an upstream said in a failure,** before any of it is
  shortened: the message, a router's raw text, and every field's name and value. A connection
  header's value is a secret too.
- **A refusal of the host's own key or bill is told in the SDK's words,** not the upstream's, and
  what names the host's account is cut from the message the caller and the motty are told.
- **An adapter address that holds a name or a password fails when the adapter is made,** in words
  that do not hold it.
- **Caller headers are not forwarded upstream,** but for an API's own that say what the body may
  hold: every `anthropic-*` header but the version, to an upstream that speaks Anthropic
  Messages. No credential is sent in one, and every other header stays with the host.
- **A guard test plants a marked secret in every adapter the package exports** and fails if a
  motty, its caller or another origin comes to hold it.

## Not guarded, by decision

No cut can know these, so the SDK does not claim them:

- A key an upstream echoes encoded or in another letter case. The cut matches a secret's own text.
- A key inside an answer that succeeded. Only what an upstream said in a failure is cut.
- A connection's body fields. A body is no place for a secret: an upstream may quote the request.
- A token a caller sends in a header no API names a credential. Every other header the caller sent
  is the motty's to read, and that is how a token for a service the motty calls is sent.
- The process itself. The SDK hands a motty no credential; what code can read of the process it
  runs in is the host's to control.
