Look up a GKS atom by its exact ID.

$ARGUMENTS should be an atom ID like: ADR--FLAT-ATOM-LAYOUT or FEAT--ISSUE-TRACKER

Call the `gks_lookup` MCP tool with:
- `id`: $ARGUMENTS
- `root`: `.`

Display the full atom content — title, body, status, links.

If the atom is not found, suggest: "Try /recall <keywords> to search by content."
