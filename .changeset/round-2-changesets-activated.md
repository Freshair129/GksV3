---
'@evaai/gks': patch
---

Activate Changesets for release management (Phase 6 R.1).

`@changesets/cli` is now a devDependency; `.github/workflows/release.yml`
runs on every push to `main`, opens a "Version Packages" PR when
`.changeset/*.md` files are pending, and publishes to npm when that PR
is merged. See `docs/adr/016-changesets-for-release.md` for the
decision record.

Maintainer one-time setup before the first publish:

1. Set `NPM_TOKEN` GitHub repo secret (npm token with publish access
   to `@evaai/gks`).
2. (Optional) Set `RELEASE_BOT_TOKEN` to a PAT so version-bump
   commits don't retrigger the workflow.

After the first release, the workflow takes over: contributors run
`npx changeset` per PR, the bot consolidates them, and publishes
happen on merge.
