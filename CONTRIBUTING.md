# Contributing

## Setup

The repository is a Bun workspace. Install Bun at the version `package.json` names, then:

```sh
bun install
```

## The checks

A pull request passes all of them:

```sh
bun run lint
bun run typecheck
bun test
```

The storage adapter's tests need a server: `podman compose up -d --wait`, or the same with
`docker`, and `REDIS_URL=redis://127.0.0.1:6379`. The gates under `gates/` run with `bun test` and
hold the SDK's size, type-check cost and time per call within a recorded baseline. Live tests make
real calls, need provider keys in `.env`, and are not part of a pull request's checks.

## Code rules

- **Plain functions, no classes.** The error classes are the one exception. Files are split by
  concern and named for the step they serve.
- **Strict types.** No `any`, no casts, no non-null assertions. Types are inferred from the code
  and not written by hand beside it.
- **Tests are plain `bun:test`,** each named with a sentence that says what holds. No test DSL:
  cases and tables are the runner's.
- **A comment says why, never what.** A document never points into the code by path, symbol or
  line.
- **One way to do each thing.** A new name in the API has to earn its place.
- **Nothing that grows the bundle or slows a call without a reason.** The gates measure both.

## Design changes

A change to how the SDK behaves is a decision, and goes into [ARCHITECTURE.md](ARCHITECTURE.md)
in the same pull request: the rule in bold, its cause, and what was rejected. A change to the
core's own plan goes into [CORE.md](CORE.md) the same way.

## Commits and pull requests

- Commits follow Conventional Commits with a gitmoji after the type, in the form
  `fix(serve): :bug: fail a call whose upstream ends it with an error ending`.
- Work happens on a short-lived `<type>/<description>` branch off `main`.
- A pull request targets `main` and is squashed when its checks pass.

## Releases

- All packages carry one version. A release bumps it in every package in one pull request, with
  `bun run bump X.Y.Z`, which also brings the lockfile along. A package is packed with the versions
  the lockfile records, so a lockfile left behind fails the checks.
- A release is an annotated `vX.Y.Z` tag on `main`, or `vX.Y.Z-rc.N` for a pre-release. A tag is
  never moved. The release workflow refuses a tag that is lightweight or of neither form.
- Pushing the tag runs the checks on it and packs the packages once. After a maintainer approves,
  those same tarballs are published to npm and attached to the GitHub release. A pre-release goes
  under the `next` tag, any other under `latest`.
- No token is stored. npm trusts the release workflow by its identity, and the job that publishes
  runs no code of the repository.

## Licence

Contributions are accepted under the [Apache-2.0](LICENSE) licence of the repository.
