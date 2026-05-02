Manage GKS hotfixes (emergency bypass atoms with 48h backfill window).

$ARGUMENTS format:
- `open <sha> --reason="<why>"` — open a new hotfix
- `list` — show all open hotfixes and countdowns  
- `close <sha>` — mark a hotfix resolved after backfill

Parse $ARGUMENTS to determine the subcommand:

If "list" or empty: call `gks_hotfix_list` with root `.` and display each hotfix with its remaining time.

If starts with "open": call `gks_hotfix_open` with the sha and reason extracted from $ARGUMENTS.

If starts with "close": call `gks_hotfix_close` with the sha extracted from $ARGUMENTS.

After open: "⚠ Hotfix open — you have 48h to write CONCEPT--, ADR--, and BLUEPRINT-- atoms as backfill."
After close: "✓ Hotfix closed."
