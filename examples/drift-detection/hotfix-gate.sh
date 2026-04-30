#!/usr/bin/env bash
# Light-tier backfill / lifecycle gates (master-spec §6.4, ADR-014,
# ADR--ADD-POC-PREFIX).
#
# Install (alongside pre-push-hook.sh):
#   cp examples/drift-detection/hotfix-gate.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Behaviour:
#   1. Lists files staged in this commit.
#   2. Runs `gks hotfix check --file=…` to find overdue HOTFIX-- atoms
#      whose linked_symbols overlap with the staged files.
#   3. Runs `gks poc check --file=…` to find overdue POC-- atoms in the
#      same way (open/running past time_box.deadline).
#   4. If either gate finds a match, exits non-zero — the operator must
#      either close the offending atom (HOTFIX → write
#      CONCEPT/ADR/BLUEPRINT then `gks hotfix close … --resolved-by=…`;
#      POC → `gks poc close … --resolution=validated|invalidated|abandoned`)
#      or amend the commit so it doesn't touch those files.
#
# Atoms within their backfill / time-box window do NOT block — each gate
# only triggers once the deadline has passed.

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

npx tsx "${REPO_ROOT}/bin/gks.ts" poc check \
  --root="${REPO_ROOT}" \
  "${FILE_ARGS[@]}"
