# GKS Full-flow Runner Example

This example demonstrates the end-to-end **Doc-to-Code lifecycle** (P1-P6) as enforced by ADR-014.

## Purpose

The `run-feature.sh` script is a convenience wrapper that guides a contributor through:
1.  **Duplicate check**: Ensuring the feature hasn't been discussed or implemented.
2.  **Scaffolding**: Generating the initial Concept, ADR, Feature, and Blueprint candidates.
3.  **Gate Check**: Running `verify-flow` to ensure the documentation chain is stable before code is generated.

## Prerequisites

- Node.js 22+
- `npm install` has been run in the repo root.

## Usage

From the repo root:

```bash
./examples/full-flow/run-feature.sh MY-FEATURE --title "Implement Rate Limiting" --files "src/middleware/rate-limit.ts"
```

## How it works

The script uses the GKS CLI (`bin/gks.ts`) to perform its operations. In a real environment (like Claude Code or Cursor), these operations would be performed via the **MCP Tools** (`gks_new_feature`, `gks_verify_flow`, etc.).

## File Structure

- `run-feature.sh`: The interactive driver.
- `fixtures/`: A skeleton directory structure for testing the flow without polluting your main repo.
