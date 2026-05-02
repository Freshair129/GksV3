---
id: BLUEPRINT--EPISODE-BOUNDARY
phase: 3
type: blueprint
status: stable
vault_id: default
title: BLUEPRINT — Episode boundary detection
crosslinks: {"parent_adr":["ADR--EPISODE-BOUNDARY"],"parent_concept":["CONCEPT--EPISODE-BOUNDARY"]}
linked_symbols:
  - {"file":"src/memory/episode-boundary.ts","fn":"detectEpisodeBoundaries"}
  - {"file":"src/memory/episode-boundary.ts","fn":"detectByTimeGap"}
  - {"file":"src/memory/episode-boundary.ts","fn":"detectBySemantic"}
  - {"file":"src/memory/session.ts","fn":"writeEpisodicV2"}
created_at: 2026-05-02T09:42:41.056Z
---

# BLUEPRINT — Episode boundary detection

```yaml
metadata:
  title: "Episode boundary detection in the v2 endSession path"
  status: draft

architectural_pattern: |
  Three composable signals (time-gap, semantic, explicit), OR-combined
  into a list of EpisodeSegment{start, end, reason, signals}. Default
  detector lives in src/memory/episode-boundary.ts; pluggable so
  orchestrators can supply their own. session.ts.writeEpisodicV2
  loops over segments instead of writing one Episode per session.

data_logic: |
  detectEpisodeBoundaries(trace, opts):
    if trace.length === 0: return []

    boundaries = new Set<number>([0])   // segment starts
    boundaries.add(trace.length)          // virtual end marker

    if opts.timeGap.enabled:
      for i in 1..trace.length-1:
        gapMs = parseTime(trace[i].t) - parseTime(trace[i-1].t)
        if gapMs > opts.timeGap.thresholdMs:
          boundaries.add(i)

    if opts.explicit.enabled:
      for i in 1..trace.length-1:
        s = trace[i]
        if s.kind === 'system' && s.metadata?.episode_boundary === true:
          boundaries.add(i)

    if opts.semantic.enabled:
      const embedder = opts.embedder           // required when enabled
      // Embed each turn's content once.
      const vecs = await embedder.embedBatch(trace.map(t => t.content))
      for i in 1..trace.length-1:
        const cos = cosineSim(vecs[i-1], vecs[i])
        if cos < opts.semantic.similarityFloor:
          boundaries.add(i)

    sorted = [...boundaries].sort((a,b) => a-b)
    segments = []
    for i in 0..sorted.length-2:
      const start = sorted[i]
      const end = sorted[i+1]
      const len = end - start
      if len < (opts.minTurnsPerEpisode ?? 1):
        // merge into previous segment
        if segments.length > 0:
          segments[last].end_index = end
        else:
          segments.push({ start_index: start, end_index: end, reason: 'fallback', signals: {} })
        continue
      segments.push({
        start_index: start,
        end_index: end,
        reason: classifyReason(start, opts, ...recorded reasons during detection),
        signals: ...,
      })

    return segments

  writeEpisodicV2 (updated):
    const segments = await detector(trace)
    if segments.length === 0: emit one fallback episode (existing path)
    for [idx, seg] in segments:
      const episodeId = `E-${session.id}-${pad3(idx + 1)}`
      append episode (with seg.reason, signals stored in provenance)
      for turn in trace.slice(seg.start_index, seg.end_index):
        append turn (episode_id = episodeId)

geography:
  - "src/memory/episode-boundary.ts"          # NEW: detector + helpers
  - "src/memory/session.ts"                   # writeEpisodicV2 loops over segments
  - "src/memory/index.ts"                     # public exports + MemoryStoreOptions
  - "test/memory/episode-boundary.test.ts"    # NEW

api_contracts:
  - name: "EpisodeSegment"
    file: "src/memory/episode-boundary.ts"
    shape: |
      interface EpisodeSegment {
        start_index: number     // inclusive
        end_index: number       // exclusive
        reason: 'initial' | 'time-gap' | 'topic-shift' | 'explicit' | 'fallback'
        signals: {
          gapMs?: number        // present for time-gap
          cosine?: number       // present for topic-shift
        }
      }

  - name: "EpisodeBoundaryOptions"
    file: "src/memory/episode-boundary.ts"
    shape: |
      interface EpisodeBoundaryOptions {
        timeGap?:  { enabled?: boolean; thresholdMs?: number }
        semantic?: { enabled?: boolean; similarityFloor?: number; embedder?: Embedder }
        explicit?: { enabled?: boolean }
        minTurnsPerEpisode?: number    // default 1
      }

  - name: "detectEpisodeBoundaries"
    file: "src/memory/episode-boundary.ts"
    shape: |
      function detectEpisodeBoundaries(
        trace: TraceStep[],
        opts?: EpisodeBoundaryOptions,
      ): Promise<EpisodeSegment[]>

  - name: "EpisodeBoundaryDetector type + plumbing"
    file: "src/memory/session.ts"
    shape: |
      type EpisodeBoundaryDetector = (trace: TraceStep[]) => Promise<EpisodeSegment[]>

      interface EndSessionOptions {
        // existing fields …
        episodeBoundary?:
          | false                                        // legacy single-episode
          | EpisodeBoundaryOptions                       // tweak default detector
          | { detector: EpisodeBoundaryDetector }        // BYO detector
      }

verification_plan:
  - id: V1-default-single-episode-without-signals
    description: |
      Trace with no time gaps, no explicit markers, semantic OFF →
      detector returns ONE segment spanning the whole trace.
      writeEpisodicV2 writes one Episode (legacy behaviour preserved).
  - id: V2-time-gap-splits
    description: |
      Trace with a 15-minute gap (timestamp jumps) → detector returns
      two segments. writeEpisodicV2 writes two Episodes; the second
      Episode's first turn matches the trace step after the gap.
  - id: V3-explicit-marker-splits
    description: |
      Trace contains a system turn with metadata.episode_boundary=true
      at index k → segments split at k.
  - id: V4-semantic-splits-when-enabled
    description: |
      With semantic.enabled=true and a stub embedder returning two
      far-apart vectors at index k → segment splits at k.
      With semantic.enabled=false (default) the same trace yields ONE
      segment (no embedder dependency in the hot path).
  - id: V5-segments-record-reason-and-signals
    description: |
      Each EpisodeSegment carries reason + signals reflecting WHY the
      boundary fired (gapMs for time, cosine for semantic).
  - id: V6-pluggable-detector
    description: |
      endSession({ episodeBoundary: { detector: customFn } }) → custom
      detector is called; default detector is NOT.
  - id: V7-legacy-mode
    description: |
      endSession({ episodeBoundary: false }) reproduces the pre-change
      single-episode behaviour exactly. No regression in existing
      session.test.ts cases.

implementation_steps:
  - 1. Build src/memory/episode-boundary.ts: types + DEFAULT_OPTIONS +
       detectByTimeGap, detectByExplicit, detectBySemantic helpers +
       detectEpisodeBoundaries orchestrator + cosineSim helper.
  - 2. Refactor session.ts.writeEpisodicV2 to call the detector and
       loop over segments. Episode ids: `E-<session>-001`, `-002`, ...
  - 3. Stamp seg.reason + seg.signals into Episode.provenance for
       audit trail.
  - 4. EndSessionOptions extension: episodeBoundary?: false |
       EpisodeBoundaryOptions | { detector }.
  - 5. Public exports.
  - 6. Tests V1-V7 with hand-built fixtures (no real embedder calls
       beyond a stub).
```
