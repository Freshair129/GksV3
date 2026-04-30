# ADR 016 — Changesets for release management (Phase 6 R.1)

- **Status:** accepted (scaffolded; not yet wired into CI)
- **Date:** 2026-04-30
- **Deciders:** core
- **Context tag:** release, tooling, phase-6, changelog

## Context

`docs/ULTRAPLAN.md` § Phase 6 R.1 calls for "semver + changelog
automation" with `changesets` as the candidate tool. Until now the
project has carried a hand-edited `CHANGELOG.md` keyed off PR titles
and shipped releases manually via `git tag` + `gh release`. That works
for a 0–1 maintainer cadence but doesn't scale: every release requires
a human to read the diff, infer the bump type, and write the changelog
entry by hand. Two nuisances surface in practice:

1. PR titles drift away from "what users care about" as scope evolves
   during review; the changelog entry derived from them is often
   off-target by merge time.
2. The version in `package.json` falls out of sync with git tags
   (we are at `package.json: 3.5.5` while remote tags include `v3.6.0`
   and `v3.5.6`) — the manual cycle has no source of truth.

Three release-tooling shapes were on the table:

- **Changesets** — per-PR `.changeset/*.md` files declaring bump +
  summary; aggregator runs at release time. Used by Vercel, Astro,
  React community libraries.
- **release-please** (Google) — derives release from Conventional
  Commits messages. Less flexible than Changesets when a commit's
  user-visible meaning differs from its commit message.
- **Continue manual** — keep doing what we do.

## Decision

Adopt **Changesets** for Phase 6 R.1, but **scaffold without
activating yet.** Concretely:

1. `.changeset/config.json` and `.changeset/README.md` land in this
   PR, baseBranch `main`, public access.
2. `@changesets/cli` is **not** added to `devDependencies` here. The
   maintainer activates the tool with one `npm install --save-dev
   @changesets/cli` when ready to commit to the cadence.
3. No CI workflow file (`.github/workflows/release.yml`) is shipped
   yet. Authoring a release workflow couples to:
   - which branch is the release source (`main`? a `release/*` line?)
   - whether release commits should be auto-merged or open as PRs
   - npm publish credentials (org-level secret)
   These are operational decisions the maintainer should make, not
   tooling decisions to bake in upfront.

The scaffolding makes it a one-command flip-the-switch when those
operational decisions are made.

## Consequences

**Positive**

- **Per-PR semantic intent** — contributors declare bump + summary at
  commit time, not at release time. Reduces "what did we ship" research
  cost at release.
- **Single source of truth for version** — `package.json` and
  `CHANGELOG.md` stay aligned because Changesets writes both.
- **No coupling to commit-message conventions** — Changesets reads
  `.changeset/*.md` files, not commit titles. We don't have to enforce
  Conventional Commits to use it.
- **Public-access default** — config is set up for `npm publish
  --access=public` matching the `@evaaai/gks` package convention.

**Negative**

- **Two-step adoption** — scaffolding ≠ activation. There's a gap where
  the folder exists and contributors might (wrongly) think they need to
  add changesets per PR. Mitigated by the explicit "Status: not yet
  wired" note in `.changeset/README.md`.
- **Maintainer must pick the activation moment** — the tool is here,
  but flipping it on isn't free (CI job, npm token, branch protection).
  Documented in the README; not blocking this PR.
- **Changesets is a JS-ecosystem tool** — locks the workflow into
  JS/npm. Not a real concern here since the repo is npm-published, but
  noting it as tradeoff.

## Alternatives considered

1. **release-please.** *Rejected.* Forces Conventional Commits as the
   semantic spine, and we don't enforce that; trying to retrofit it
   would create a two-vocabulary problem.
2. **Continue manual releases.** *Rejected* on long-term grounds.
   Acceptable for the next 1–2 releases; not acceptable as a long-term
   answer once external contributors land. Phase 6 R.1 explicitly
   targets this gap.
3. **Auto-install + auto-wire CI in this PR.** *Rejected* — see
   "negative" above. Activation is a maintainer decision, not a
   contributor one. This PR's job is to remove all the decision-shaped
   friction so activation is one command.

## What activates the tool

```sh
npm install --save-dev @changesets/cli                  # 1. install
echo "release: '@changesets/changelog-github'" >> .changeset/config.json   # optional: GitHub-flavoured changelog
# add .github/workflows/release.yml that runs:
#   - changesets/action@v1 with publish: npm run release
```

## References

- `docs/ULTRAPLAN.md` § Phase 6 R.1 — the promise this ADR fulfils
- `.changeset/README.md` — operator-facing activation guide
- `CHANGELOG.md` — the file this tool will eventually maintain
- https://github.com/changesets/changesets — upstream tool
