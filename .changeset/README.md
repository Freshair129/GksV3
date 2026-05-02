# Changesets

This folder is the entry point for [Changesets](https://github.com/changesets/changesets) —
the release-management tool for `@evaai/gks` (Phase 6 R.1).

## Status

**Activated.** `@changesets/cli` is installed as a devDependency,
`.github/workflows/release.yml` is wired, and the workflow runs on
every push to `main`. The full activation history is in
`docs/adr/016-changesets-for-release.md`.

The only outstanding maintainer step is setting `NPM_TOKEN` in GitHub
repo secrets — without it, the workflow opens version-bump PRs but
can't publish to npm.

## Adding a changeset (per PR)

For each non-trivial PR, run `npx changeset` and follow the prompts:

1. Pick the bump type — `major` / `minor` / `patch`.
2. Write a one-line summary that will land in `CHANGELOG.md`.

Commit the resulting `.changeset/<random-name>.md` file alongside the PR.
At release time, `npx changeset version` consolidates pending changesets
into a `CHANGELOG.md` entry + `package.json` bump and opens a "Version
Packages" PR. Merging that PR triggers `npx changeset publish`.

## Manual operations (rarely needed)

```sh
npx changeset            # add a changeset interactively
npx changeset status     # what's pending? what's the next version?
npx changeset version    # consume changesets → CHANGELOG + bump (CI does this)
npx changeset publish    # publish to npm (CI does this)
```

## See also

- `docs/adr/016-changesets-for-release.md` — decision record
- `.github/workflows/release.yml` — the CI pipeline
- `CHANGELOG.md` — what Changesets writes

