Re-emit a v1 markdown session into the v2 three-document layout.

$ARGUMENTS should be a session id (e.g. `MSP-SESS-2604301F00`).
Optional flag: `--force` to overwrite an existing v2 session directory.

If $ARGUMENTS is empty, ask: "Which session id should I migrate? (run /episodic-list to see ids first)"

Call the `gks_episodic_migrate` MCP tool with:
- `sessionId`: the parsed session id
- `force`: true if `--force` was passed; otherwise omit

Format the response:
- If `ok: false`: report the reason. If it's "v2 session already exists", suggest `--force`.
- Otherwise: `✓ Migrated <session_id> → 1 episode (<turn_count> turns)` and include the `episode_id`.
