List every v2 episodic session from `_index.jsonl`.

No arguments needed. Call the `gks_episodic_list` MCP tool with `{}`.

Format each row as:
- `<session_id>  episodes=<N>  turns=<M>  <started_at>` (and `→ <ended_at>` if set, otherwise `(active)`).

If `sessions[]` is empty: "No v2 sessions yet — run a session through endSession to populate, or use /episodic-migrate to lift v1 markdown sessions."
