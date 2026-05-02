Pretty-print a v2 episodic session — header, episodes, and (optionally) all turns.

$ARGUMENTS should be a session id (e.g. `MSP-SESS-2605025F58`).
Optional flag: `--full` to include every turn in the response.

If $ARGUMENTS is empty, ask: "Which session id should I show? (or run /episodic-list to see all sessions)"

Call the `gks_episodic_show` MCP tool with:
- `sessionId`: the parsed session id
- `full`: true if `--full` was passed; otherwise omit

Format the response:
- If `ok: false`: report the reason and suggest `/episodic-migrate <id>` if the user has a v1 markdown.
- Otherwise show:
  - `Session: <session_id>`
  - `  schema_version: <v>`
  - `  started_at → ended_at`
  - `  episodes: <count>, total turns: <sum>`
  - `  summary:` (if present)
  - For each episode: `  · <episode_id> [<episode_type>] turns=<turn_count>`
  - With `--full`, append turns: `    <turn_id> [<episode_id>] <speaker>: <text excerpt>`
