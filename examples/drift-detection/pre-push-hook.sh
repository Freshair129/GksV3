#!/usr/bin/env bash
# Example pre-push hook wiring drift detection.
#
# Install:
#   cp examples/drift-detection/pre-push-hook.sh .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
#
# Or via husky:
#   npx husky add .husky/pre-push "$(cat examples/drift-detection/pre-push-hook.sh)"
#
# Behaviour:
#   • Lists code paths changed since the upstream branch (or main).
#   • Pipes them into check-drift.ts.
#   • Aborts the push (exit 1) if any HIGH or MEDIUM citation exists,
#     so the developer reviews the affected docs first. Override with
#     `git push --no-verify`.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
GRAPH="${GKS_DRIFT_GRAPH:-${REPO_ROOT}/.brain/msp/projects/evaAI/graph/code.jsonl}"
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo 'main')"

CHANGED="$(git diff --name-only "${UPSTREAM}"...HEAD -- 'src/**/*.ts' '*.ts' 2>/dev/null || true)"
if [ -z "${CHANGED}" ]; then
  echo "[drift] no source changes vs ${UPSTREAM}; skipping check"
  exit 0
fi

GRAPH_ARG=()
if [ -f "${GRAPH}" ]; then GRAPH_ARG=("--graph=${GRAPH}"); fi

echo "${CHANGED}" | npx tsx "${REPO_ROOT}/examples/drift-detection/check-drift.ts" \
  --stdin --root="${REPO_ROOT}" "${GRAPH_ARG[@]}"
