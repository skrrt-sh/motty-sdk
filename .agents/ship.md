<!-- skrrt:policy -->
<!-- skrrt:strategy:github-flow -->
# Ship workflow — GitHub Flow

- Protected branch: `main`. It is the only long-lived branch and must stay deployable.
- Work base: `main`. Use short-lived `<type>/<description>` branches.
- PR target: `main`. Rebase unpublished work onto `origin/main`; rewriting a published branch
  requires explicit approval and `--force-with-lease`.
- Merge: squash after required checks pass. Do not commit or merge directly to `main`.
- Releases: tag commits on `main` with immutable annotated `vX.Y.Z` production tags or
  `vX.Y.Z-rc.N` pre-production tags. Merges may deploy to development without tags.
- Build once and promote the same artifact by content identity.
<!-- /skrrt:policy -->
