Propose a new atom to the GKS inbound queue.

$ARGUMENTS format: <type> "<title>" — e.g. `concept "Caching strategy for vector search"`

Parse $ARGUMENTS:
- First word = type (concept / adr / blueprint / feat / audit / issue)
- Rest (in quotes) = title

Call the `gks_propose_inbound` MCP tool with:
- `type`: parsed type
- `title`: parsed title
- `body`: ask the user for the body content if not provided
- `root`: `.`

After proposing: "✓ Proposed — review with `gks inbound list` or promote with `gks inbound promote <id>`"

If $ARGUMENTS is empty, ask: "What do you want to propose? Format: <type> \"<title>\""
