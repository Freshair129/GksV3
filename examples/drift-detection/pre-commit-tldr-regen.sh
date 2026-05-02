#!/usr/bin/env bash
# Pre-commit hook: keep `summary_tldr` fields fresh on staged atom files.
#
# When the developer commits an edit to a `gks/<type>/<id>.md` file, this
# hook re-stamps the file's frontmatter via `gks tldr regenerate <id>` so
# the TLDR matches the new body. Without it, `gks validate
# --tldr-staleness` flags the atom as drifted on the next CI run.
#
# Install:
#   cp examples/drift-detection/pre-commit-tldr-regen.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or via husky:
#   npx husky add .husky/pre-commit "$(cat examples/drift-detection/pre-commit-tldr-regen.sh)"
#
# Generator selection (same as `gks tldr regenerate`):
#   • GKS_LLM_BASE_URL / GKS_LLM_API_KEY  → OpenAI-compatible local SLM
#   • ANTHROPIC_API_KEY                    → Anthropic Messages API
#   • (none)                                → Heuristic (deterministic, no LLM)
#
# Override with `git commit --no-verify` to skip.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

# Atom path pattern: gks/<type>/<id>.md (any of the known type folders).
ATOM_PATTERN='^gks/(concept|adr|blueprint|feat|frame|insight|fact|rule|hotfix|audit|flow|protocol|skill|algo|entity|risk|runbook|slo|guardrail|issue|incident)/[A-Z0-9-]+--[A-Z0-9-]+\.md$'

mapfile -t STAGED_ATOMS < <(git diff --cached --name-only --diff-filter=AM | grep -E "${ATOM_PATTERN}" || true)

if [[ ${#STAGED_ATOMS[@]} -eq 0 ]]; then
  exit 0
fi

# Map paths → atomic ids (filename without extension).
IDS=()
for f in "${STAGED_ATOMS[@]}"; do
  IDS+=("$(basename "$f" .md)")
done

echo "[tldr-regen] regenerating summary_tldr for ${#IDS[@]} staged atom(s):"
for id in "${IDS[@]}"; do
  echo "  • ${id}"
done

if ! npx tsx "${REPO_ROOT}/bin/gks.ts" tldr regenerate "${IDS[@]}" --root="${REPO_ROOT}"; then
  echo "[tldr-regen] regeneration failed — fix the error or commit with --no-verify to skip" >&2
  exit 1
fi

# Rebuild the atomic index so the new TLDR fields flow through.
npx tsx "${REPO_ROOT}/scripts/msp/re-indexer.ts" --root="${REPO_ROOT}" >/dev/null

# Re-stage the rewritten files + index so the commit picks up the fresh
# frontmatter. Without this, the TLDR sits in the working tree but isn't
# part of the commit being created.
git add "${STAGED_ATOMS[@]}" "${REPO_ROOT}/gks/00_index/atomic_index.jsonl"

echo "[tldr-regen] done — staged the regenerated frontmatter."
