Verify that all crosslinks in a feature atom chain are intact (doc-to-code enforcement).

$ARGUMENTS should be an atom ID like: FEAT--ISSUE-TRACKER

Call the `gks_verify_flow` MCP tool with:
- `id`: $ARGUMENTS
- `root`: `.`

If all links are valid: "✓ Flow verified — all crosslinks intact."
If broken edges found: list each broken link and tell the user to fix the atom file before committing.

If $ARGUMENTS is empty, ask: "Which atom do you want to verify? (e.g. FEAT--MY-FEATURE)"
