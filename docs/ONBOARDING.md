# Onboarding — adopting GKS in an existing project

A pragmatic, **incremental** path to bring GKS into a project that already has
code and (probably) scattered docs in Notion / Confluence / Slack threads.

> **Golden rule.** Don't migrate everything on day one. Migrate what you'll
> touch again. Empty atoms are worse than no atoms — they fool readers into
> thinking the SSOT is complete when it isn't.

---

## Prerequisites

- Node 20+
- A git repository (GKS audit + drift hooks assume one)
- Optional: Postgres with pgvector, or Qdrant — only when atoms exceed ~100
  and you need semantic recall

You do **not** need an LLM API key to start. The Three-Gate Consolidator and
embeddings are pluggable; file backends work for everything else.

---

## Phase 0 — Install + bootstrap (5 minutes)

```sh
cd my-existing-project
npm install @gks/core
npx gks init
```

`gks init` creates:

```
gks/                       ← atom folders, flat layout (ADR-013)
  adr/  concept/  feat/  frame/  blueprint/
  issues/  runbook/  inc/  ...
.brain/default/            ← storage (audit, atomic_index, vectors)
gks.config.json            ← namespace + backends
scripts/msp/re-indexer.ts  ← walks gks/**/*.md → atomic_index.jsonl
```

Default config uses **file backends** — no external services needed:

```jsonc
{ "namespace": "default",
  "backends": { "vector": "file", "graph": "file" },
  "audit":    { "enabled": true } }
```

Add to `.gitignore` (the init step does this for you):

```gitignore
.brain/**/audit/
.brain/**/vectors/
```

`atomic_index.jsonl` **is** committed — it's deterministic and reviewable.

---

## Phase 1 — Capture 3 decisions you've already made

The single highest-ROI step. Pick three decisions that your team has
**already made** but never wrote down — usually they live in Slack, in
someone's head, or in a closed PR description.

Examples:

- *"Why Postgres over MongoDB?"*
- *"Why JWT instead of session cookies?"*
- *"Why BullMQ instead of SQS?"*

Each becomes one ADR:

```sh
cp examples/atom-templates/ADR.md gks/_inbound/ADR--POSTGRES-CHOICE.md
# fill in frontmatter + body

gks inbound list
gks inbound promote ADR--POSTGRES-CHOICE
```

Or via CLI directly:

```sh
gks propose-inbound \
  --type adr \
  --id ADR--POSTGRES-CHOICE \
  --title "Postgres over MongoDB for tenancy isolation" \
  --file ./draft.md

gks inbound promote ADR--POSTGRES-CHOICE
```

Stop here for the day. Three ADRs is a working SSOT.

---

## Phase 2 — Link atoms to existing code (`linked_symbols`)

Pick 5–10 **hot files** — code that's edited often, breaks often, or is
load-bearing. Add `linked_symbols:` to the atoms that govern them.

```yaml
# gks/adr/ADR--POSTGRES-CHOICE.md
---
id: ADR--POSTGRES-CHOICE
linked_symbols:
  - { file: "src/db/client.ts" }
  - { file: "src/db/migrations/0001_init.sql" }
---
```

Re-index:

```sh
npm run msp:reindex
```

Verify the reverse lookup works:

```sh
gks lookup-by-symbol src/db/client.ts
# → ADR--POSTGRES-CHOICE   adr   "Postgres over MongoDB ..."
```

---

## Phase 3 — Migrate existing docs (incrementally)

**Rule of thumb:** migrate a doc only if you'll edit it again in the next
month. Read-only reference material can stay where it is.

| Existing doc                    | → atom type                       |
|---------------------------------|-----------------------------------|
| `README.md` § Architecture      | `FRAME--SYSTEM-OVERVIEW`          |
| `docs/api.md`                   | one `API--<endpoint>` per surface |
| `docs/runbooks/db-failover.md`  | `RUNBOOK--DB-FAILOVER`            |
| Slack thread — "decision X"     | `ADR--X`                          |
| Confluence FAQ (read-only)      | ❌ leave it                       |

Templates live in `examples/atom-templates/` — one starter per prefix.

The full taxonomy (30+ prefixes, 4 clusters) is in
[`docs/KNOWLEDGE-TYPES.md`](./KNOWLEDGE-TYPES.md).

---

## Phase 4 — Wire drift detection (real ROI starts here)

```sh
cp examples/drift-detection/pre-push.sh .git/hooks/pre-push
chmod +x .git/hooks/pre-push
```

Now any push that changes a cited symbol blocks until atoms are reviewed:

```
$ git push
Pushing to origin/feat-jwt-rotation...
─ ADR--JWT-AUTH cites src/auth/jwt.ts:verify
─ verify() was modified; ADR--JWT-AUTH not updated
exit 1 — review atoms before pushing
```

Override with `git push --no-verify` only when the atom is genuinely
unaffected — and even then, prefer updating the atom.

---

## Phase 5 — Connect AI agents (Claude Code / Cursor / OpenAI)

Add an MCP server entry. For Claude Code, edit `~/.config/claude-code/mcp.json`:

```jsonc
{ "mcpServers": {
    "gks": {
      "command": "npx",
      "args":    ["@gks/core", "mcp"],
      "cwd":     "/path/to/my-existing-project"
} } }
```

Restart the agent. It now has 8 stdio tools:

- `gks_recall` — semantic + lexical retrieval
- `gks_lookup` / `gks_lookup_by_symbol` — exact-id / reverse-citation
- `gks_propose_inbound` — agents can suggest atoms (review still required)
- `gks_retain` / `gks_reflect` / `gks_recall_cross_namespace`

The agent will start calling `gks_recall` before generating code that
duplicates an existing decision — the duplication-prevention loop closes here.

---

## Phase 6 — Self-hosted issue tracker (optional)

Skip if Linear / Jira is working for you. If you want to stop paying for
those, ISSUE-- ships out of the box (light tier — direct write, no inbound
queue):

```sh
gks issue create --title "Add 2FA flow" --priority high --label auth
gks issue list --status open
gks issue comment ISSUE--ADD-2FA "blocked on TOTP library choice"
gks issue close ISSUE--ADD-2FA --reason "shipped in v1.4"
```

Issues get the same audit trail and bi-temporal versioning as everything else.

---

## Phase 7 — Vector backend (when atoms > ~100)

Lexical recall is fine for a few dozen atoms. Beyond that, switch on a
real vector store:

```jsonc
// gks.config.json
{ "backends": {
    "vector":   { "type": "pgvector", "url": "$DATABASE_URL" },
    "embedder": { "type": "openai", "model": "text-embedding-3-small" }
} }
```

Migrate the existing index:

```sh
gks reindex --rebuild-vectors
```

`gks recall` now blends semantic + lexical with rerank. Cost tracking is
on by default — check `.brain/default/cost.jsonl`.

---

## Anti-patterns

| Don't                                          | Do                                              |
|------------------------------------------------|-------------------------------------------------|
| Migrate every doc on day one                   | Start with 3 ADRs you've already decided        |
| Write an ADR for every commit                  | ADR = a decision someone will ask "why?" about  |
| Skip inbound review to move faster             | The review **is** the SSOT guarantee            |
| Add `linked_symbols` everywhere                | Only for atoms that actually govern code        |
| Wait for "enough" atoms before drift detection | Turn it on now — it works with whatever exists  |
| Treat empty atom shells as progress            | Better to have 5 real atoms than 50 stubs       |

---

## A realistic timeline

| Week    | Work                                       | Payoff                                   |
|---------|--------------------------------------------|------------------------------------------|
| 1       | install · 3 ADRs · `linked_symbols`        | team has somewhere to record decisions   |
| 2       | drift pre-push hook · 5–10 more atoms      | first drift caught before merge          |
| 3–4     | MCP server · agents call `gks_recall`      | agents stop duplicating prior decisions  |
| 1–2 mo  | runbooks · incident → post-mortem ADRs     | ops loop closes                          |
| 3 mo    | vector backend · cross-namespace recall    | scales to org-wide use                   |

---

## Where to go next

- [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) — internals + data flow diagrams
- [`docs/TECHNICAL-OVERVIEW.md`](./TECHNICAL-OVERVIEW.md) — full reference
- [`docs/KNOWLEDGE-TYPES.md`](./KNOWLEDGE-TYPES.md) — atom taxonomy (30+ prefixes)
- [`docs/MSP_RELATIONSHIP.md`](./MSP_RELATIONSHIP.md) — where MSP / Memory OS sits
- [`docs/adr/`](./adr/) — every architectural decision behind GKS itself
- [`examples/`](../examples/) — drift detection, GitNexus cache, Memory OS POC

If you get stuck, file an `ISSUE--` against the GKS repo itself — we eat our
own dog food.
