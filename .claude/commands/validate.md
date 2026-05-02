Validate ALL crosslinks across the entire GKS atom tree.

Call the `gks_validate_links` MCP tool with:
- `root`: `.`

This is the same check that runs before every commit (Agent Rule §6.3).

If all links valid: "✓ All links valid — safe to commit."
If broken links found: list every broken link with the source atom and missing target.
