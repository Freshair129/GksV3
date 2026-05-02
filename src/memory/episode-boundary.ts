/**
 * Episode boundary detection for the v2 episodic write path.
 *
 * Implements BLUEPRINT--EPISODE-BOUNDARY. Three composable signals
 * (time-gap, semantic, explicit) OR-combined into EpisodeSegment[].
 * Default config keeps the embedder out of the hot path — semantic
 * detection is opt-in.
 */

import type { TraceStep } from './types.js'
import type { Embedder } from './vector/embedder.js'

const DEFAULT_TIME_GAP_MS = 600_000 // 10 minutes
const DEFAULT_SEMANTIC_FLOOR = 0.55
const DEFAULT_MIN_TURNS_PER_EPISODE = 1

export interface EpisodeBoundarySignals {
  /** Wall-clock gap between consecutive turns; present when boundary fired by time-gap. */
  gapMs?: number
  /** Cosine similarity between adjacent turns; present when boundary fired by topic-shift. */
  cosine?: number
}

export type EpisodeBoundaryReason =
  | 'initial'
  | 'time-gap'
  | 'topic-shift'
  | 'explicit'
  | 'fallback'

export interface EpisodeSegment {
  /** Inclusive start index into the trace[]. */
  start_index: number
  /** Exclusive end index. */
  end_index: number
  reason: EpisodeBoundaryReason
  signals: EpisodeBoundarySignals
}

export interface EpisodeBoundaryOptions {
  timeGap?: { enabled?: boolean; thresholdMs?: number }
  semantic?: {
    enabled?: boolean
    similarityFloor?: number
    /** Required when semantic.enabled is true. */
    embedder?: Embedder
  }
  explicit?: { enabled?: boolean }
  /** Segments shorter than this are merged into the previous segment. Default 1. */
  minTurnsPerEpisode?: number
}

/**
 * Detect Episode boundaries in a TraceStep[] using the configured signals.
 * Returns one EpisodeSegment per coherent slice; an empty trace returns [].
 */
export async function detectEpisodeBoundaries(
  trace: TraceStep[],
  opts: EpisodeBoundaryOptions = {},
): Promise<EpisodeSegment[]> {
  if (trace.length === 0) return []

  const timeGapEnabled = opts.timeGap?.enabled !== false
  const timeGapMs = opts.timeGap?.thresholdMs ?? DEFAULT_TIME_GAP_MS
  const explicitEnabled = opts.explicit?.enabled !== false
  const semanticEnabled = opts.semantic?.enabled === true
  const semanticFloor = opts.semantic?.similarityFloor ?? DEFAULT_SEMANTIC_FLOOR
  const minTurnsPerEpisode = Math.max(1, opts.minTurnsPerEpisode ?? DEFAULT_MIN_TURNS_PER_EPISODE)

  // Map<startIndex, {reason, signals}> — first signal to fire wins reason.
  const boundaries = new Map<number, { reason: EpisodeBoundaryReason; signals: EpisodeBoundarySignals }>()
  boundaries.set(0, { reason: 'initial', signals: {} })

  // 1. Time-gap detection.
  if (timeGapEnabled) {
    for (let i = 1; i < trace.length; i++) {
      const prev = parseTime(trace[i - 1]!.t)
      const curr = parseTime(trace[i]!.t)
      if (prev === null || curr === null) continue
      const gap = curr - prev
      if (gap > timeGapMs) {
        boundaries.set(i, { reason: 'time-gap', signals: { gapMs: gap } })
      }
    }
  }

  // 2. Explicit-marker detection.
  if (explicitEnabled) {
    for (let i = 1; i < trace.length; i++) {
      const step = trace[i]!
      if (step.kind !== 'system') continue
      const meta = step.metadata
      if (meta && (meta as Record<string, unknown>)['episode_boundary'] === true) {
        boundaries.set(i, { reason: 'explicit', signals: {} })
      }
    }
  }

  // 3. Semantic detection (opt-in; runs the embedder).
  if (semanticEnabled) {
    if (!opts.semantic?.embedder) {
      throw new Error(
        'detectEpisodeBoundaries: semantic.enabled=true requires semantic.embedder',
      )
    }
    const embedder = opts.semantic.embedder
    const texts = trace.map((t) => t.content)
    const vectors = await embedder.embedBatch(texts)
    for (let i = 1; i < trace.length; i++) {
      const cos = cosineSim(vectors[i - 1]!, vectors[i]!)
      if (cos < semanticFloor) {
        // Only set if no other reason already claimed this index.
        if (!boundaries.has(i)) {
          boundaries.set(i, { reason: 'topic-shift', signals: { cosine: cos } })
        }
      }
    }
  }

  // Sort boundary indices ascending and walk into segments.
  const indices = [...boundaries.keys()].sort((a, b) => a - b)
  const rawSegments: EpisodeSegment[] = []
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i]!
    const end = i + 1 < indices.length ? indices[i + 1]! : trace.length
    const meta = boundaries.get(start)!
    rawSegments.push({
      start_index: start,
      end_index: end,
      reason: meta.reason,
      signals: meta.signals,
    })
  }

  // Merge segments shorter than minTurnsPerEpisode into the previous one.
  const segments: EpisodeSegment[] = []
  for (const seg of rawSegments) {
    const len = seg.end_index - seg.start_index
    if (len < minTurnsPerEpisode && segments.length > 0) {
      const prev = segments[segments.length - 1]!
      prev.end_index = seg.end_index
      continue
    }
    segments.push(seg)
  }

  return segments
}

function parseTime(iso: string): number | null {
  const ts = Date.parse(iso)
  return Number.isFinite(ts) ? ts : null
}

function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) return 0
  let dot = 0
  let aMag = 0
  let bMag = 0
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    aMag += ai * ai
    bMag += bi * bi
  }
  if (aMag === 0 || bMag === 0) return 0
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag))
}

/**
 * Detector function shape — accepts a trace and returns segments.
 * Used by `EndSessionOptions.episodeBoundary.detector` for callers
 * who want to plug in custom logic (LLM-based detection, etc.).
 */
export type EpisodeBoundaryDetector = (
  trace: TraceStep[],
) => Promise<EpisodeSegment[]>
