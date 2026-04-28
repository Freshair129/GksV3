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

Every Pull Request runs the following checks (see `.github/workflows/gks-gates.yml`):

1.  **Index Integrity**: `npm run msp:index` must not produce any changes. Commit the updated `atomic_index.jsonl` whenever you add or move atoms.
2.  **Link Validation**: Every `crosslinks.*` reference in the index must resolve to an existing atom.
3.  **Flow Verification**: For every `FEAT--` atom, the walker asserts that the entire chain (`FEAT → BLUEPRINT → ADR → CONCEPT`) is `stable`.

## Local Enforcement

Install the example git hooks once so your machine catches drift before the
CI does:

```bash
cp examples/drift-detection/pre-push-hook.sh   .git/hooks/pre-push
cp examples/drift-detection/hotfix-gate.sh     .git/hooks/pre-commit
chmod +x .git/hooks/pre-push .git/hooks/pre-commit
```

Run the same gates locally any time:

```bash
npm run msp:index
git diff --exit-code -- gks/00_index/atomic_index.jsonl
npx tsx bin/gks.ts validate --links
npx tsx bin/gks.ts verify-flow FEAT--YOUR-FEATURE
```

## Hotfixes (Escape Hatch)

If you need to land an urgent fix without writing the full chain of atoms immediately, open a **Hotfix Hatch**:

1.  Tag the commit message with `HOTFIX` (or pass `--hotfix` to the gate hook), and open the atom:

    ```bash
    npx tsx bin/gks.ts hotfix open "$(git rev-parse HEAD)" \
      --title "Urgent fix" \
      --file=src/affected.ts
    ```

2.  Within **48 hours**, backfill the missing atoms (`CONCEPT`, `ADR`, `BLUEPRINT`) referencing the hotfix in `crosslinks.resolves`, then close it:

    ```bash
    npx tsx bin/gks.ts hotfix close HOTFIX--<short-sha> \
      --resolved-by=ADR--BACKFILL --resolved-by=BLUEPRINT--BACKFILL
    ```

Failure to close the hotfix within 48 hours blocks any further commit on the
affected files (`gks hotfix check`) and the CI gate.
