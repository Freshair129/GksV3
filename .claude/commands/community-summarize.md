Synthesise a single narrative across a community of related atoms.

$ARGUMENTS should be one or more seed atom ids (e.g. `FEAT--MY-FEATURE` or `FEAT--A FEAT--B`).

Optional flags within $ARGUMENTS (parse them out before calling the tool):
- `--hops=N` (default 1, max 3) — crosslink walk depth
- `--mode=structural|semantic|hybrid` (default `structural`)
- `--include-bodies` — use atom bodies instead of pre-computed `summary_tldr`
- `--max-members=N` (default 30)
- `--edges=a,b,c` — restrict to specific crosslink predicates

If $ARGUMENTS is empty, ask: "Which atom(s) should I summarise the community for? (e.g. FEAT--MY-FEATURE)"

Call the `gks_community_summarize` MCP tool with the parsed args (`seed`, `hops`, `mode`, `includeBodies`, `maxMembers`, `edges`, `semanticThreshold`, `semanticTopK`).

Format the response:
- Header: `Community summary (<members.length> member(s)<, truncated if applicable>)`
- `members:` (one per line)
- `synthesis:` (the `summary` field, indented)
- If `membership_breakdown` is present (mode!=structural), show source counts: `structural=N`, `semantic=M`, `overlap=K`
