# Contributing to GKS

GKS uses **ADR-014 Doc-to-Code Enforcement** to ensure the integrity of the knowledge graph. All contributions that add new features or modify core logic must pass the integrity gates.

## The Doc-to-Code Loop

1.  **Phase 1: Concept** (`CONCEPT--slug.md`)
    Define the "What" and "Why". Status must be `stable` before moving to Phase 2.
2.  **Phase 2: ADR** (`ADR--slug.md`)
    Define the architectural decision. Status must be `stable` before moving to Phase 3.
3.  **Phase 3: Blueprint** (`BLUEPRINT--slug.md`)
    Define the technical implementation plan. Status must be `stable` before Phase 4.
4.  **Phase 4-6: Implementation** (`FEAT--slug.md`)
    Code changes. The `FEAT--` atom must cite the `BLUEPRINT` it implements.

## CI Gates

Every Pull Request runs the following checks:

1.  **Index Integrity**: `npm run msp:reindex` must not produce any changes. You must commit the updated `atomic_index.jsonl` if you added/moved atoms.
2.  **Link Validation**: Every `crosslinks.*` reference in the index must resolve to an existing atom.
3.  **Flow Verification**: For every `FEAT--` atom, the walker asserts that the entire chain (`FEAT -> BLUEPRINT -> ADR -> CONCEPT`) is `stable`.

## Local Verification

Run these commands before pushing:

```bash
# Reindex
npm run msp:reindex

# Validate links
npx tsx bin/gks.ts validate --links

# Verify a specific flow
npx tsx bin/gks.ts verify-flow FEAT--YOUR-FEATURE
```

## Hotfixes (Escape Hatch)

If you need to land an urgent fix without writing the full chain of atoms immediately, you can open a **Hotfix Hatch**:

1.  Open a hotfix: `gks hotfix open --title "Urgent fix"`
2.  Commit your code.
3.  You have **48 hours** to backfill the missing atoms (`CONCEPT`, `ADR`, `BLUEPRINT`) and close the hotfix: `gks hotfix close <ID> --resolvedBy ADR--BACKFILL-ID`.

Failure to close a hotfix within 48 hours will block the CI gates.
