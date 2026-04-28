#!/usr/bin/env bash
# GKS Full-flow Runner (P1-P6)
# Guided walkthrough for adding a new feature.

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}GKS v3 Full-flow Runner${NC}"
echo "---------------------------"

# 1. Parse Arguments
SLUG=$1
TITLE=""
FILES=""

while [[ "$#" -gt 0 ]]; do
    case $1 in
        --title) TITLE="$2"; shift ;;
        --files) FILES="$2"; shift ;;
    esac
    shift
done

if [ -z "$SLUG" ] || [ -z "$TITLE" ]; then
    echo -e "${RED}Usage: $0 SLUG --title \"TITLE\" [--files \"file1,file2\"]${NC}"
    exit 1
fi

# 2. Check GKS Init
if [ ! -d "gks" ] || [ ! -d ".brain" ]; then
    echo -e "${YELLOW}GKS not initialized in this directory.${NC}"
    read -p "Run 'gks init'? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        npx tsx bin/gks.ts init
    else
        echo "Aborting."
        exit 1
    fi
fi

# 3. Duplicate Check
echo -e "\n${BLUE}[P1] Checking for duplicates...${NC}"
HITS=$(npx tsx bin/gks.ts recall "$TITLE" --top-k=3)
if [[ $HITS == *"hits: []"* ]]; then
    echo "No obvious duplicates found."
else
    echo -e "${YELLOW}Potential duplicates found:${NC}"
    echo "$HITS"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 4. Scaffold
echo -e "\n${BLUE}[P1-P3] Scaffolding candidates...${NC}"
npx tsx bin/gks.ts new-feature "$SLUG" --title "$TITLE" --blueprint-file="$FILES"

# 5. Pause for Edit
echo -e "\n${YELLOW}Candidates dropped into .brain/msp/projects/evaAI/inbound/${NC}"
echo "Edit the candidates to define the CONCEPT, ADR, and BLUEPRINT."
read -p "Press Enter to continue after editing..."

# 6. Commit Atoms (Mock for script)
echo -e "\n${BLUE}[P1-P3] Promoting candidates to stable atoms...${NC}"
echo "In a real flow, you would run 'gks retain' or move files to gks/ and reindex."
echo "Running reindex now..."
npm run msp:reindex

# 7. Pre-code Gate
echo -e "\n${BLUE}[Gate] Running verify-flow before code generation...${NC}"
if npx tsx bin/gks.ts verify-flow "FEAT--$SLUG" --root=.; then
    echo -e "${GREEN}Gate passed! You are cleared to generate code.${NC}"
else
    echo -e "${RED}Gate FAILED. Fix the atom statuses/links before coding.${NC}"
    exit 1
fi

# 8. Success
echo -e "\n${GREEN}Feature flow initialized successfully.${NC}"
echo "Follow the BLUEPRINT to implement the feature in your codebase."
