Scaffold a new feature through the P1→P6 doc-to-code loop.

Call the `gks_new_feature` MCP tool with:
- `title`: $ARGUMENTS
- `root`: `.`
- `taskTracker`: `local`

After scaffolding, list the 4 atoms created (CONCEPT--, ADR--, BLUEPRINT--, FEAT--) and tell the user:
"Next: review the inbound queue with /propose or promote with `gks inbound promote <id>`"

If $ARGUMENTS is empty, ask: "What feature are you building?"
