Regenerate the `summary_tldr` field on one or more atoms (or every stale atom) so recall snippets stay fresh.

$ARGUMENTS may be:
- One or more atom ids (e.g. `FEAT--MY-FEATURE`)
- The literal string `--all-stale` to regenerate every atom whose body has drifted from its stored `summary_tldr_body_hash`
- Empty — in which case ask: "Which atom(s) should I regenerate? Or pass --all-stale."

Call the `gks_tldr_regenerate` MCP tool with:
- `ids`: array of atom ids (if any explicit ids passed)
- `allStale`: true (if `--all-stale` was passed; otherwise omit)

Format the response:
- For each `regenerated[]` entry: `✓ <id> → <path>`
- For each `errors[]` entry: `✗ <id> — <reason>`
- If nothing was stale and no ids passed: "No stale atoms — nothing to do."

Remind the user to run `npm run msp:index` if they want the new TLDR fields to flow into `atomic_index.jsonl`.
