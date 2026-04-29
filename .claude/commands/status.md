Show the current GKS health snapshot.

Run these in parallel:
1. Call `gks_hotfix_list` with root `.` — open hotfixes
2. Call `gks_validate_links` with root `.` — link integrity
3. Read `gks/00_index/atomic_index.jsonl` and count lines — total atoms

Display as:

## GKS Status

**Atoms:** <count> total

**Links:** ✓ All valid  /  ⚠ <N> broken links

**Open hotfixes:** <count>  
<list each with sha + reason + time remaining>

**Pending inbound:** run `gks inbound list --root=.` to see queue

If everything is healthy: "✓ Ready to commit."
