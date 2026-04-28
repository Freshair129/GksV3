#!/usr/bin/env bash
# Hotfix backfill gate (master-spec §6.4, ADR-014).
#
# Install (alongside pre-push-hook.sh):
#   cp examples/drift-detection/hotfix-gate.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Behaviour:
#   1. Lists files staged in this commit.
#   2. Runs `gks hotfix check --file=…` to find overdue HOTFIX-- atoms
#      whose linked_symbols overlap with the staged files.
#   3. If any overdue hotfix matches, exits non-zero — the operator must
#      either close the hotfix (write CONCEPT/ADR/BLUEPRINT then
#      `gks hotfix close HOTFIX--XXXXXXX --resolved-by=ADR-...`) or amend
#      the commit so it doesn't touch those files.
#
# Hotfixes within the 48-hour backfill window do NOT block — the gate
# only triggers once `valid_to` has passed.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"

STAGED="$(git diff --name-only --cached --diff-filter=ACMR || true)"
if [ -z "${STAGED}" ]; then exit 0; fi

FILE_ARGS=()
while IFS= read -r f; do
  [ -n "${f}" ] && FILE_ARGS+=("--file=${f}")
done <<< "${STAGED}"

if [ ${#FILE_ARGS[@]} -eq 0 ]; then exit 0; fi

npx tsx "${REPO_ROOT}/bin/gks.ts" hotfix check \
  --root="${REPO_ROOT}" \
  "${FILE_ARGS[@]}"
