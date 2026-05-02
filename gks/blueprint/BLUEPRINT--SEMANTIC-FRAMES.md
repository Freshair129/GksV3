---
id: BLUEPRINT--SEMANTIC-FRAMES
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Per-turn semantic_frames inferrer
crosslinks: {"parent_adr":["ADR--SEMANTIC-FRAMES"],"parent_concept":["CONCEPT--SEMANTIC-FRAMES"]}
linked_symbols:
  - {"file":"src/memory/semantic-frames.ts","fn":"createHeuristicSemanticFramesInferrer"}
  - {"file":"src/memory/semantic-frames.ts","fn":"createLlmSemanticFramesInferrer"}
  - {"file":"src/memory/session.ts","fn":"writeEpisodicV2"}
  - {"file":"src/memory/episodic-v2.ts","fn":"EpisodicLayerV2.patchTurnFrames"}
created_at: 2026-05-02T13:34:42.256Z
---

# BLUEPRINT — Per-turn semantic_frames inferrer

```yaml
metadata:
  title: "Per-turn semantic_frames at endSession"
  status: draft

architectural_pattern: |
  New module `semantic-frames.ts` exports two factories matching the
  SemanticFramesInferrer signature. EpisodicLayerV2 gains
  `patchTurnFrames(sessionId, framesPerTurn)` — atomic rewrite of
  `turns.jsonl` that stamps frames onto each turn in order.
  session.ts.writeEpisodicV2 calls the inferrer once after appending
  all turns, then patches.

data_logic: |
  createHeuristicSemanticFramesInferrer():
    return async (trace) => {
      const out = trace.map(step => heuristicForStep(step))
      return { frames: out }
    }

  heuristicForStep(step):
    const text = (step.content ?? '').toLowerCase()
    if step.kind === 'user':
      if /\?\s*$/.test(text) return ['question']
      if /^\s*(please|can you|could you|would you|make|build|create|fix|update|run)\b/.test(text)
        return ['request']
      return ['statement']
    if step.kind === 'agent':
      if /```/.test(step.content ?? '') return ['explanation', 'demonstration']
      return ['explanation']
    if step.kind === 'tool': return ['action']
    if step.kind === 'system': return ['system_event']
    if step.kind === 'memory' || step.kind === 'brain': return ['recall']
    return undefined  // unknown kind

  createLlmSemanticFramesInferrer({ client, fallback?, maxTurnsInPrompt? }):
    return async (trace) => {
      if trace.length > (maxTurnsInPrompt ?? 200): return fallback(trace)
      const prompt = buildPrompt(trace)
      try:
        const raw = await client.generate({ system: SYSTEM_PROMPT, user: prompt, maxTokens: 1024 })
        const parsed = parseFramesResponse(raw, trace.length)
        if parsed.length === trace.length: return { frames: parsed }
        return fallback(trace)  // shape mismatch
      catch err:
        log.warn('llm frames inferrer failed, falling back', {err})
        return fallback(trace)
    }

  EpisodicLayerV2.patchTurnFrames(sessionId, framesPerTurn):
    const turns = await this.listTurns(sessionId)
    if (turns.length !== framesPerTurn.length): throw // mismatch
    const updated = turns.map((t, i) => {
      const f = framesPerTurn[i]
      if (!f || f.length === 0) return t
      return { ...t, semantic_frames: f }
    })
    await this.rewriteTurns(sessionId, updated)   // single fs.writeFile

  writeEpisodicV2 (extended):
    ... existing append-turns code ...
    if (opts.semanticFrames && opts.semanticFrames !== false) {
      const inferrer = opts.semanticFrames
      const { frames } = await inferrer(trace)
      await store.episodicV2.patchTurnFrames(session.id, frames)
    }

geography:
  - "src/memory/semantic-frames.ts"        # NEW
  - "src/memory/episodic-v2.ts"             # add patchTurnFrames + rewriteTurns
  - "src/memory/session.ts"                 # wire opts.semanticFrames
  - "src/memory/index.ts"                   # public re-exports
  - "test/memory/semantic-frames.test.ts"   # NEW

api_contracts:
  - name: "SemanticFramesInferrer"
    file: "src/memory/semantic-frames.ts"
    shape: |
      type SemanticFramesInferrer = (
        trace: TraceStep[],
      ) => Promise<{ frames: (string[] | undefined)[] }>

  - name: "Factories"
    file: "src/memory/semantic-frames.ts"
    shape: |
      function createHeuristicSemanticFramesInferrer(): SemanticFramesInferrer
      interface LlmSemanticFramesOptions {
        client: LlmClient
        fallback?: SemanticFramesInferrer       // default = heuristic
        maxTurnsInPrompt?: number               // default 200
        maxTokens?: number                      // default 1024
      }
      function createLlmSemanticFramesInferrer(opts: LlmSemanticFramesOptions): SemanticFramesInferrer

  - name: "EpisodicLayerV2.patchTurnFrames"
    file: "src/memory/episodic-v2.ts"
    shape: |
      patchTurnFrames(
        sessionId: string,
        framesPerTurn: (string[] | undefined)[],
      ): Promise<void>

  - name: "EndSessionOptions extension"
    file: "src/memory/session.ts"
    shape: |
      interface EndSessionOptions {
        // existing …
        semanticFrames?: false | SemanticFramesInferrer
      }

verification_plan:
  - id: V1-heuristic-question-vs-request
    description: |
      Heuristic returns ['question'] for "What is X?" and ['request']
      for "Please make X." and ['statement'] for "X is good."
  - id: V2-heuristic-tool-and-system
    description: |
      Heuristic returns ['action'] for kind='tool' and ['system_event']
      for kind='system' regardless of content.
  - id: V3-llm-success
    description: |
      Mock LlmClient returns 3 frame arrays for a 3-turn trace.
      patchTurnFrames stamps them onto turns.jsonl in order.
  - id: V4-llm-shape-mismatch-fallback
    description: |
      LLM returns 2 arrays for a 3-turn trace → fallback to heuristic.
      Each turn gets the heuristic value.
  - id: V5-llm-throws-fallback
    description: |
      LLM throws → same fallback as V4.
  - id: V6-too-long-trace-uses-fallback
    description: |
      Trace > maxTurnsInPrompt → LLM not called; result is fallback.
  - id: V7-end-to-end-via-endSession
    description: |
      endSession({ semanticFrames: heuristic-inferrer }) writes turns
      with semantic_frames populated. listTurns returns them.

implementation_steps:
  - 1. Build src/memory/semantic-frames.ts: heuristic + LLM factories +
       parseFramesResponse + buildPrompt + SYSTEM_PROMPT.
  - 2. Add EpisodicLayerV2.patchTurnFrames + rewriteTurns helper.
  - 3. Wire opts.semanticFrames into session.ts.writeEpisodicV2 after
       turn appends, before finaliseSession.
  - 4. Re-export from src/memory/index.ts.
  - 5. Tests V1-V7 with mock LlmClient. Heuristic tests are
       deterministic; LLM tests use fixedClient(...) helpers.
```
