#!/usr/bin/env bash
# GKS full-flow runner — guided P1→P6 walkthrough for a new feature.
#
# Composes the existing primitives:
#   gks recall          — duplicate check (P0)
#   gks new-feature     — scaffold CONCEPT/ADR/FEAT/BLUEPRINT into inbound
#   gks inbound promote — move each candidate into gks/<type>/
#   gks verify-flow     — gate the chain before code generation
#
# Run interactively (default — pauses for $EDITOR review of each candidate)
# or with --auto-promote for headless / CI use. The runner is a CONVENIENCE
# wrapper; the underlying primitives are still the right interface for
# agents and CI.

set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  run-feature.sh SLUG --title "TITLE" [--files "src/a.ts,src/b.ts"]
                 [--auto-promote] [--gks-bin "npx tsx bin/gks.ts"]

Flags:
  --title          required; one-line title shared by all four atoms
  --files          comma-separated file paths the BLUEPRINT will govern
  --auto-promote   skip the editor pause; promote every candidate as-is
  --gks-bin        override how to invoke the gks CLI (default: npx tsx bin/gks.ts)
USAGE
}

SLUG="${1:-}"; shift || true
TITLE=""
FILES=""
AUTO_PROMOTE=0
GKS_BIN="npx tsx bin/gks.ts"

while [ $# -gt 0 ]; do
  case "$1" in
    --title)         TITLE="$2"; shift 2 ;;
    --title=*)       TITLE="${1#--title=}"; shift ;;
    --files)         FILES="$2"; shift 2 ;;
    --files=*)       FILES="${1#--files=}"; shift ;;
    --auto-promote)  AUTO_PROMOTE=1; shift ;;
    --gks-bin)       GKS_BIN="$2"; shift 2 ;;
    --gks-bin=*)     GKS_BIN="${1#--gks-bin=}"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$SLUG" ] || [ -z "$TITLE" ]; then
  usage; exit 1
fi

slug_upper=$(echo "$SLUG" | tr '[:lower:]-' '[:upper:]_' | tr '_' '-')

# --- 0. ensure gks is initialised in cwd -------------------------------------
if [ ! -d gks ] || [ ! -d .brain ]; then
  echo "gks/ or .brain/ missing — running 'gks init'"
  $GKS_BIN init
fi

# --- 1. P0: recall duplicates -------------------------------------------------
echo "[P0] checking for prior atoms named '$TITLE'..."
hits_json=$($GKS_BIN recall "$TITLE" --top-k=3 --json 2>/dev/null || echo '{}')
# `grep -o` returns 1 when no matches; tolerate that under `set -e`.
hit_count=$(printf '%s' "$hits_json" | grep -oE '"id":"[A-Z][^"]*"' | wc -l | tr -d ' ' || true)
hit_count=${hit_count:-0}
if [ "$hit_count" -gt 0 ]; then
  echo "  $hit_count possibly-related atom(s):"
  printf '%s' "$hits_json" | grep -oE '"id":"[A-Z][^"]*"' | sed 's/^/    /'
  if [ $AUTO_PROMOTE -eq 0 ]; then
    read -r -p "  continue anyway? (y/N) " ans
    case "$ans" in y|Y) ;; *) echo "abort."; exit 1 ;; esac
  fi
fi

# --- 2. P1-P3: scaffold ------------------------------------------------------
echo "[P1-P3] scaffolding 4 candidates into inbound..."
new_args="$slug_upper --title \"$TITLE\""
if [ -n "$FILES" ]; then
  IFS=',' read -ra _files <<< "$FILES"
  for f in "${_files[@]}"; do
    new_args="$new_args --blueprint-file=\"$f\""
  done
fi
eval "$GKS_BIN new-feature $new_args"

# --- 3. review pause ---------------------------------------------------------
if [ $AUTO_PROMOTE -eq 0 ]; then
  echo
  echo "candidates landed in .brain/msp/projects/evaAI/inbound/"
  echo "edit them now, then press Enter to continue..."
  if [ -n "${EDITOR:-}" ]; then
    inbound_dir=".brain/msp/projects/evaAI/inbound"
    for id in "CONCEPT--$slug_upper" "ADR--$slug_upper" "FEAT--$slug_upper" "BLUEPRINT--$slug_upper"; do
      f=$(ls "$inbound_dir"/${id}.*.md 2>/dev/null | head -1 || true)
      if [ -n "$f" ]; then "$EDITOR" "$f"; fi
    done
  else
    read -r _
  fi
fi

# --- 4. promote in dependency order -----------------------------------------
echo "[P1-P3] promoting CONCEPT → ADR → FEAT → BLUEPRINT"
for id in "CONCEPT--$slug_upper" "ADR--$slug_upper" "FEAT--$slug_upper" "BLUEPRINT--$slug_upper"; do
  if ! $GKS_BIN inbound promote "$id"; then
    echo "  ✗ promote failed at $id"
    exit 1
  fi
done

# --- 5. reindex --------------------------------------------------------------
npm run msp:index >/dev/null

# --- 6. gate -----------------------------------------------------------------
echo "[gate] verify-flow FEAT--$slug_upper"
if ! $GKS_BIN verify-flow "FEAT--$slug_upper" --root=.; then
  echo "✗ chain integrity failed — fix atoms before coding"
  exit 1
fi

# --- 7. summary --------------------------------------------------------------
echo
echo "ready to implement. blueprint geography:"
if [ -n "$FILES" ]; then
  IFS=',' read -ra _files <<< "$FILES"
  for f in "${_files[@]}"; do echo "  - $f"; done
fi
echo
echo "next steps:"
echo "  - write the code in those paths"
echo "  - 'gks lookup-by-symbol <path>' confirms reverse citations land"
echo "  - after merge, propose AUDIT--$slug_upper to close the loop"
