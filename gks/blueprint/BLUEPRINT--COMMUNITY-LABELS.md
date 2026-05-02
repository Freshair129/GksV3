---
id: BLUEPRINT--COMMUNITY-LABELS
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — LLM-labelled communities
crosslinks: {"parent_adr":["ADR--COMMUNITY-LABELS"],"parent_concept":["CONCEPT--COMMUNITY-LABELS"]}
linked_symbols:
  - {"file":"src/memory/community-detect.ts","fn":"detectCommunities"}
  - {"file":"src/memory/community-detect.ts","fn":"heuristicLabel"}
  - {"file":"src/memory/community-detect.ts","fn":"llmLabel"}
  - {"file":"src/memory/index.ts","fn":"MemoryStore.detectCommunities"}
created_at: 2026-05-02T09:29:48.826Z
---

# BLUEPRINT — LLM-labelled communities

```yaml
metadata:
  title: "LLM-labelled communities (opt-in)"
  status: draft

architectural_pattern: |
  Extend DetectedCommunity with optional `label` + `labelSource`.
  Add `withLabels: boolean | { generator?: TldrGenerator }` to
  DetectCommunitiesOptions. When set, post-process every emitted
  cluster: try LLM (if generator) → fall back to heuristic →
  fall back to community_id.

data_logic: |
  detectCommunities runs as today; after grouping members it does:

    if (!opts.withLabels) return result   // unchanged sync path

    for (const c of result.communities):
      if (opts.withLabels === true || !opts.withLabels.generator):
        c.label = heuristicLabel(c.members)
        c.labelSource = 'heuristic'
      else:
        const prompt = buildLabelPrompt(c, atomic)
        try:
          const raw = await generator.summarize(prompt, { type: 'community-label', maxTokens: 24 })
          c.label = sanitizeLabel(raw)
          c.labelSource = 'llm'
        catch:
          c.label = heuristicLabel(c.members) || c.community_id
          c.labelSource = 'heuristic' or 'fallback'

  buildLabelPrompt(cluster, atomic):
    members + their summary_tldrs (or titles), 1 atom per line
    Instruction: "Give a 1-4 word topic name. Plain text only."

  heuristicLabel(memberIds):
    tokens = memberIds.flatMap(id => id.split('--').slice(1).flatMap(s => s.split('-')))
    counts = countTokens(tokens, lowercase)
    common = tokens that appear in ≥ ceil(memberIds.length / 2) members
    return common.join('-').toLowerCase() || ''

  sanitizeLabel(raw):
    raw.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 60)
    Strip trailing punctuation. Reject empty / whitespace-only → ''.

geography:
  - "src/memory/community-detect.ts"      # add label fields + label fns
  - "src/memory/index.ts"                 # plumb through MemoryStore
  - "src/mcp-server/index.ts"             # gks_community_detect input adds withLabels
  - "bin/gks.ts"                          # `gks community detect --labels`
  - "test/memory/community-detect.test.ts" # extend with V1-V7

api_contracts:
  - name: "DetectCommunitiesOptions extension"
    file: "src/memory/community-detect.ts"
    shape: |
      interface DetectCommunitiesOptions {
        edgeKeys?: string[]
        minSize?: number
        // NEW
        withLabels?: boolean | { generator?: TldrGenerator }
      }

  - name: "DetectedCommunity extension"
    file: "src/memory/community-detect.ts"
    shape: |
      interface DetectedCommunity {
        // existing
        community_id: string
        members: string[]
        size: number
        density: number
        // NEW (optional, only when withLabels was requested)
        label?: string
        labelSource?: 'llm' | 'heuristic' | 'fallback'
      }

verification_plan:
  - id: V1-default-no-labels
    description: |
      detectCommunities() without withLabels returns clusters without
      `label`/`labelSource` fields (no behavioural change).
  - id: V2-heuristic-default
    description: |
      withLabels: true (no generator) — every cluster has a heuristic
      label derived from common id tokens. labelSource='heuristic'.
  - id: V3-llm-success
    description: |
      withLabels: { generator: mockLlmGenerator('Local-First Profile') }
      → cluster.label === 'Local-First Profile', labelSource='llm'.
  - id: V4-llm-failure-falls-back
    description: |
      Generator throws or returns empty → cluster falls back to heuristic.
      labelSource='heuristic'.
  - id: V5-fully-empty-falls-back-to-community_id
    description: |
      Heuristic returns '' AND no generator → label = community_id,
      labelSource='fallback'.
  - id: V6-heuristic-stem-extraction
    description: |
      For [CONCEPT--SUMMARY-TLDR, ADR--SUMMARY-TLDR, FEAT--SUMMARY-TLDR]
      heuristicLabel returns 'summary-tldr'.
  - id: V7-prompt-uses-summary_tldr-when-present
    description: |
      buildLabelPrompt uses each member's summary_tldr when available,
      falls back to title/id otherwise. (Verifies via mock generator
      that captures the prompt text.)

implementation_steps:
  - 1. Implement heuristicLabel + sanitizeLabel + buildLabelPrompt in
       community-detect.ts.
  - 2. Refactor detectCommunities to optionally await label generation
       in the post-grouping pass.
  - 3. MemoryStore.detectCommunities forwards opts unchanged (already
       async).
  - 4. Add `--labels` flag to `gks community detect`. When set, choose
       generator the same way `tldr regenerate` does (env precedence:
       GKS_LLM_BASE_URL → ANTHROPIC_API_KEY → heuristic).
  - 5. Add `withLabels` to gks_community_detect MCP input schema.
  - 6. Tests V1-V7.
```
