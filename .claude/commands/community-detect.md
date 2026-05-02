Auto-detect communities (clusters) in the atom crosslink graph using deterministic Louvain-lite.

$ARGUMENTS may include optional flags:
- `--edges=a,b,c` — restrict to specific crosslink predicates (default: all)
- `--min-size=N` — clusters smaller than this go to orphans (default 2)

Call the `gks_community_detect` MCP tool with the parsed args (`edgeKeys`, `minSize`).

Format the response:
- Header: `Detected <communities.length> community(ies) over <total_atoms> atoms (modularity Q=<modularity.toFixed(3)>)`
- For each community: `<community_id> [size=N density=D.DD] members: <ids joined>`
- Orphans (if any): `Orphans: <ids joined>`
- Suggest follow-up: "Run /community-summarize <community_id-members> for a synthesis of any cluster."
