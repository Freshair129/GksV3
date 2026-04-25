# GKS v3 — Schema Migrations

GKS persistent stores carry a `schema_version` field. The runtime checks
it on `load()` and refuses to read an incompatible store rather than
silently corrupting data. This page documents the policy, the current
version, and how to roll forward.

## Versioning policy

Versions are semver-shaped (`MAJOR.MINOR.PATCH`).

| On-disk vs runtime | Action on `load()` |
|---|---|
| same | proceed silently |
| same major, lower minor | proceed; log info that the schema will be rewritten on the next manifest write |
| same major, lower patch | proceed silently (doc / typo / clarification fixes only) |
| **different major** | **refuse** — caller must run `npm run gks-migrate -- --apply` |
| on-disk newer than runtime | refuse — upgrade GKS or pass an explicit `--force` admin flag |
| unparseable | log + treat as `unknown`; proceed best-effort |

Stores written before this scheme (no `schema_version` field at all)
are treated as `1.0.0` for back-compat.

## Current version

`CURRENT_SCHEMA_VERSION` lives in `src/lib/schema-version.ts`. As of
this commit, every store ships at:

> **1.0.0** — original Phase 1 layout

A migration is only required when this version's MAJOR or MINOR digit
changes. PATCH bumps require no migration.

## When to bump the version

| Change | Bump |
|---|---|
| Added an optional field that older readers can ignore | PATCH (silent) |
| Added a required field with a sensible default | MINOR (auto-rewrite on first write) |
| Renamed a field, dropped a field, changed a field's serialization | MAJOR (write a migration) |
| Re-keyed by a different ID | MAJOR |
| Changed the JSONL format (e.g. introduced a frame header) | MAJOR |

Bump policy is enforced by code review — no automation. The simplify
review pattern from earlier cleanups applies: when in doubt, bump
higher.

## Authoring a migration

1. Edit `src/lib/schema-version.ts`:
   ```ts
   export const CURRENT_SCHEMA_VERSION = '1.1.0'  // was 1.0.0
   ```
2. Add a migration entry to `MIGRATIONS` in
   `scripts/msp/gks-migrate.ts`:
   ```ts
   {
     from: '1.0.0',
     to: '1.1.0',
     async apply({ vectorDir }) {
       // walk *.jsonl files in vectorDir, rewrite each row, sync
     },
   }
   ```
3. Cover with a test:
   - construct a store at the old version,
   - run the migration,
   - `load()` should return v1.1.0-shaped data.
4. Document the change here under "Migration history".

## Running migrations

```sh
# Dry-run: show the plan without touching disk.
npm run gks-migrate

# Apply.
npm run gks-migrate -- --apply

# Custom vector directory:
npm run gks-migrate -- --apply --vector-dir=/abs/path/.brain/.../vector
```

The runner is idempotent — re-running on an already-current store is a
no-op that just confirms the version. Failed runs leave the store at the
last successfully-applied step (per-step manifest commit), so resuming
is just running the command again.

## pgvector parity

The Postgres backend's manifest table (`gks_vector_manifest`) carries a
`schema_version int NOT NULL DEFAULT 1` column. When the JSONL schema
version bumps to a major boundary, the corresponding pgvector schema
needs an `ALTER TABLE`-style migration on top of the JSONL one — those
live in `scripts/msp/pg-migrate.ts` (split by `--from`/`--to` flags).

## Migration history

| From | To | Date | Summary |
|---|---|---|---|
| (none) | 1.0.0 | 2026-04-25 | Introduced `schema_version` field; pre-existing stores treated as 1.0.0 going forward. |
