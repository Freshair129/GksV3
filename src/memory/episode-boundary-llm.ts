/**
 * LLM-backed episode boundary detector.
 *
 * Implements BLUEPRINT--LLM-EPISODE-BOUNDARY. Plugs into the existing
 * `EpisodeBoundaryDetector` contract from BLUEPRINT--EPISODE-BOUNDARY
 * via `EndSessionOptions.episodeBoundary.detector`.
 *
 *   await endSession(store, session, {
 *     episodeBoundary: { detector: createLlmBoundaryDetector({ client }) },
 *   })
 *
 * Always runs the deterministic heuristic baseline first (time-gap +
 * explicit marker) and only adds the LLM's topic-shift boundaries on
 * top. LLM failure → falls back to heuristic-only; the call never
 * blocks endSession.
 */

import type { LlmClient } from './consolidator-llm.js'
import type { TraceStep } from './types.js'
import {
  detectEpisodeBoundaries,
  type EpisodeBoundaryDetector,
  type EpisodeBoundaryOptions,
  type EpisodeSegment,
} from './episode-boundary.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('episode-boundary-llm')

const DEFAULT_MAX_TURNS = 200
const DEFAULT_EXCERPT_CHARS = 200
const DEFAULT_MAX_RESPONSE_TOKENS = 256

const SYSTEM_PROMPT = `You are an episode boundary detector for a multi-turn conversation log.

You read the entire trace and return ONE JSON object identifying
indices where the conversation shifts to a new TOPIC. Time gaps and
explicit boundary markers are handled separately — focus only on
topic-level shifts the surrounding code wouldn't otherwise detect.

Output format (a single JSON object, no prose, no fences):
{
  "boundaries": [<int>, ...],
  "reasons":    [<short string>, ...]
}

Rules:
- Indices are 1-based positions where a NEW episode starts (the turn
  at that index begins the new episode).
- Use the same length for "boundaries" and "reasons".
- Indices must be in [1, traceLength - 1] (never 0, never traceLength).
- Each reason ≤ 60 chars, plain text.
- Be conservative — prefer fewer correct boundaries over many noisy ones.
- Empty boundaries are fine: respond with { "boundaries": [], "reasons": [] }.`

export interface LlmBoundaryDetectorOptions {
  /** LLM client (Anthropic, OpenAI-compatible local SLM, etc.). */
  client: LlmClient
  /** Forwarded to the heuristic baseline. Default = library defaults. */
  heuristic?: EpisodeBoundaryOptions
  /** If trace exceeds this length, return heuristic-only. Default 200. */
  maxTurnsInPrompt?: number
  /** Per-turn excerpt length in the prompt. Default 200 chars. */
  excerptChars?: number
  /** Token cap for the LLM response. Default 256. */
  maxResponseTokens?: number
}

export function createLlmBoundaryDetector(
  opts: LlmBoundaryDetectorOptions,
): EpisodeBoundaryDetector {
  const maxTurns = opts.maxTurnsInPrompt ?? DEFAULT_MAX_TURNS
  const excerpt = opts.excerptChars ?? DEFAULT_EXCERPT_CHARS
  const maxRespTokens = opts.maxResponseTokens ?? DEFAULT_MAX_RESPONSE_TOKENS

  return async (trace: TraceStep[]) => {
    const heuristic = await detectEpisodeBoundaries(trace, opts.heuristic ?? {})

    if (trace.length === 0) return heuristic
    if (trace.length > maxTurns) {
      log.warn('llm boundary detector: trace exceeds maxTurnsInPrompt; heuristic only', {
        traceLength: trace.length,
        maxTurns,
      })
      return heuristic
    }

    const userPrompt = buildPrompt(trace, excerpt)
    let raw: string
    try {
      raw = await opts.client.generate({
        system: SYSTEM_PROMPT,
        user: userPrompt,
        maxTokens: maxRespTokens,
      })
    } catch (err) {
      log.warn('llm boundary detector: client.generate threw — heuristic only', {
        error: (err as Error).message,
      })
      return heuristic
    }

    const llmIndices = parseLlmResponse(raw, trace.length)
    if (llmIndices.length === 0) return heuristic
    return mergeSegments(heuristic, llmIndices, trace.length)
  }
}

/** Build the LLM prompt for a trace. One labelled line per turn. */
export function buildPrompt(trace: TraceStep[], excerptChars: number): string {
  const lines: string[] = []
  lines.push(`Trace (${trace.length} turns):`)
  trace.forEach((step, i) => {
    const text = (step.content ?? '').replace(/\s+/g, ' ').slice(0, excerptChars)
    lines.push(`[${i}] ${step.kind}: ${text}`)
  })
  lines.push('')
  lines.push(
    'Identify topic-level shifts only. Time gaps and explicit markers are handled elsewhere.',
  )
  return lines.join('\n')
}

interface ParsedBoundary {
  idx: number
  reason?: string
}

/**
 * Parse the LLM's JSON-array response. Strips fenced blocks, validates
 * indices in [1, traceLen-1], dedupes, and returns sorted ascending.
 * Malformed output → returns [].
 */
export function parseLlmResponse(raw: string, traceLen: number): ParsedBoundary[] {
  if (!raw || traceLen < 2) return []
  let text = raw.trim()
  // Strip code fences.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  // Pick the first `{...}` block defensively.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return []
  text = text.slice(start, end + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const obj = parsed as Record<string, unknown>
  const indices = Array.isArray(obj['boundaries']) ? (obj['boundaries'] as unknown[]) : []
  const reasons = Array.isArray(obj['reasons']) ? (obj['reasons'] as unknown[]) : []

  const seen = new Set<number>()
  const out: ParsedBoundary[] = []
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : Number.NaN
    if (!Number.isFinite(n)) continue
    if (n <= 0 || n >= traceLen) continue
    if (seen.has(n)) continue
    seen.add(n)
    const reasonRaw = reasons[i]
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim().slice(0, 60) : undefined
    out.push(reason ? { idx: n, reason } : { idx: n })
  }
  out.sort((a, b) => a.idx - b.idx)
  return out
}

/**
 * Merge heuristic segments with LLM-suggested boundary indices.
 * Heuristic reason wins on conflicts (priority: explicit > time-gap >
 * topic-shift > existing > new llm). Each new LLM index becomes a
 * `topic-shift` segment with `signals.llm_reason` set.
 */
export function mergeSegments(
  heuristic: EpisodeSegment[],
  llmBoundaries: ParsedBoundary[],
  traceLen: number,
): EpisodeSegment[] {
  if (heuristic.length === 0 && llmBoundaries.length === 0) return []

  // Build a map keyed by start_index of the segment metadata. Heuristic
  // wins because it ran first; LLM only contributes new starts.
  const byStart = new Map<
    number,
    { reason: EpisodeSegment['reason']; signals: EpisodeSegment['signals'] }
  >()
  for (const seg of heuristic) {
    byStart.set(seg.start_index, { reason: seg.reason, signals: seg.signals })
  }
  for (const lb of llmBoundaries) {
    if (byStart.has(lb.idx)) continue
    byStart.set(lb.idx, {
      reason: 'topic-shift',
      signals: lb.reason ? { llm_reason: lb.reason } : {},
    })
  }
  if (!byStart.has(0)) byStart.set(0, { reason: 'initial', signals: {} })

  const starts = [...byStart.keys()].sort((a, b) => a - b)
  const segments: EpisodeSegment[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!
    const end = i + 1 < starts.length ? starts[i + 1]! : traceLen
    const meta = byStart.get(start)!
    segments.push({
      start_index: start,
      end_index: end,
      reason: meta.reason,
      signals: meta.signals,
    })
  }
  return segments
}
