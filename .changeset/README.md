# Changesets

This folder is the entry point for [Changesets](https://github.com/changesets/changesets) —
the release-management tool flagged in `docs/ULTRAPLAN.md` § Phase 6 R.1.

## Status

Config file is in place; the CLI itself (`@changesets/cli`) is **not yet
installed** as a devDependency. The ADR (`docs/adr/016-changesets-for-release.md`)
captures why this is "scaffolded but not wired."

## Activate

When the maintainer is ready to flip the switch on release automation:

```sh
npm install --save-dev @changesets/cli
npx changeset                    # interactive: choose bump + write summary
npx changeset version            # consume changesets → bump package.json + write CHANGELOG
npx changeset publish            # publish to npm
```

## Contributing a changeset (after activation)

For each non-trivial PR, run `npx changeset` and follow the prompts:

1. Pick the bump type — `major` / `minor` / `patch`.
2. Write a one-line summary that will land in `CHANGELOG.md`.

Commit the resulting `.changeset/<random-name>.md` file alongside the PR.
At release time, `npx changeset version` consolidates pending changesets
into a `CHANGELOG.md` entry + `package.json` bump.

## Why not auto-install yet

See `docs/adr/016-changesets-for-release.md`. Short version: the
release cadence + the npm-publish trigger are maintainer decisions, not
tooling decisions. Scaffolding sits here ready; the maintainer chooses
when to wire it into CI.
