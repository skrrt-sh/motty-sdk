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
  shortened: the message, a router's raw text, and every field's name and value. What counts as a
  secret, and how much of one is cut, has limits, so that ordinary words stay in a message:
  - A key of 20 characters or more is cut where it appears whole, and where an upstream shows it
    masked: 4 or more characters of its beginning or its end standing at the edge of a name, or 8
    or more from anywhere in it.
  - A key under 20 characters is cut only whole, and only where it stands alone: not inside a
    longer run of letters, digits, `-`, `_` or dots between them.
  - A connection header's value is cut only whole, as is each part of it between whitespace, `;`,
    `,` and `=`, and only a value or a part of 16 characters or more.
- **A signed token signs a caller in only if its signature is good under the host's key, in an
  algorithm of the kind that key is for, and the times it states hold:** an expiry that has not
  passed, a start that has come. That is all `jwt` checks unless the host names more: the issuer,
  the audience, the algorithms, the claims a token must state and every other check are the
  host's to name, and a token that states no expiry is accepted unless the host asks for one.
- **The address of a key set is never in a failure's message,** and one that holds a name or a
  password fails when the adapter is made, in words that do not hold it.
- **A refusal of the host's own key or bill is told in the SDK's words,** not the upstream's, and
  what names the host's account is cut from the message the caller and the motty are told.
- **An adapter address that holds a name or a password fails when the adapter is made,** in words
  that do not hold it.
- **Caller headers are not forwarded upstream.**
- **A request's body is bounded in size and in the time it may take to arrive,** for a caller
  with a credential and for one with none, and what its headers alone settle is settled before
  it is read.
- **The model list of a motty that asks for a caller is shown only to a caller the host knows.**
- **A guard test plants a marked secret in every adapter the package exports** and fails if a
  motty, its caller or another origin comes to hold it.

## Not guarded, by decision

No cut can know these, so the SDK does not claim them:

- A key an upstream echoes encoded or in another letter case. The cut matches a secret's own text.
- A key under 20 characters that an upstream echoes masked, in part, or inside a longer run of
  letters, digits, `-`, `_` or dots. Such a key may be an ordinary word, as a local server's
  placeholder is, and cutting its fragments cut words out of messages. Use a key of 20 characters
  or more.
- A fragment of a longer key shorter than the lengths above: under 4 characters of an end, an end
  that does not stand at the edge of a name, or under 8 characters of the middle.
- A connection header's value, or a part of one, under 16 characters, and any fragment of a
  value or a part: a header may hold a flag, a date, a version or a word. Put a secret of 16
  characters or more in a header, standing as a value or a part of its own.
- A key inside an answer that succeeded. Only what an upstream said in a failure is cut.
- A connection's body fields. A body is no place for a secret: an upstream may quote the request.
- A token a caller sends in a header no API names a credential. Every other header the caller sent
  is the motty's to read, and that is how a token for a service the motty calls is sent.
- A signed token made for another application. A host whose identity provider signs tokens for
  several applications with one key set should name the issuer and the audience, or a token made
  for another application signs a caller in.
- The process itself. The SDK hands a motty no credential; what code can read of the process it
  runs in is the host's to control.
