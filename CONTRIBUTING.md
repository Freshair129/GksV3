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

## Keeping `summary_tldr` fields fresh

Atoms can carry an optional `summary_tldr` field (see [`ADR--SUMMARY-TLDR`](./gks/adr/ADR--SUMMARY-TLDR.md)). When the body of an atom changes, its TL;DR drifts — `gks validate --tldr-staleness` flags the mismatch. To regenerate on demand:

```bash
# Single atom
npx tsx bin/gks.ts tldr regenerate FEAT--YOUR-FEATURE

# Every atom whose body has drifted from its stored TL;DR hash
npx tsx bin/gks.ts tldr regenerate --all-stale

# Preview what would change without writing
npx tsx bin/gks.ts tldr regenerate --all-stale --dry-run
```

Generator selection is automatic and follows the same env precedence as `gks inbound promote --generate-tldr`:

| env                    | generator                                    |
| ---------------------- | -------------------------------------------- |
| `GKS_LLM_BASE_URL`     | OpenAI-compatible local SLM (Ollama, etc.)   |
| `ANTHROPIC_API_KEY`    | Anthropic Messages API                        |
| (none)                 | Heuristic — deterministic, zero LLM cost     |

### Pre-commit hook integration (optional)

To keep TL;DRs fresh automatically, drop a hook into `.git/hooks/pre-commit`:

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit — regenerate TL;DRs for staged atoms
set -euo pipefail

# Which staged files are atoms? (gks/<type>/<id>.md)
mapfile -t staged_atoms < <(git diff --cached --name-only --diff-filter=AM | \
  grep -E '^gks/(concept|adr|blueprint|feat|frame|insight|fact|rule|hotfix)/.+\.md$' || true)

if [[ ${#staged_atoms[@]} -eq 0 ]]; then
  exit 0
fi

# Map each path → atomic id (strip extension + leading dirs)
ids=()
for f in "${staged_atoms[@]}"; do
  ids+=("$(basename "$f" .md)")
done

# Regenerate. Heuristic by default; export GKS_LLM_BASE_URL to use a
# local SLM (~5s/atom) or ANTHROPIC_API_KEY for cloud.
npx tsx bin/gks.ts tldr regenerate "${ids[@]}"
npm run msp:index
git add "${staged_atoms[@]}" gks/00_index/atomic_index.jsonl
```

The hook is intentionally **not** installed automatically — keeping TL;DRs perfectly fresh is a developer preference, not a hard correctness gate (the CI gate is `validate --tldr-staleness`, which can run as a soft warning rather than a blocker).
