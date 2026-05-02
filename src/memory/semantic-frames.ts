/**
 * Per-turn semantic_frames inferrer (BLUEPRINT--SEMANTIC-FRAMES).
 *
 * Two implementations:
 *   - createHeuristicSemanticFramesInferrer(): deterministic,
 *     zero-cost, maps TraceStep.kind + simple text patterns.
 *   - createLlmSemanticFramesInferrer(opts): one LLM call per
 *     session over the whole trace, with fallback to heuristic
 *     on failure or shape mismatch.
 *
 * Both return a `SemanticFramesInferrer` — the function-shape contract
 * `EndSessionOptions.semanticFrames` accepts.
 */

import type { TraceStep } from './types.js'
import type { LlmClient } from './consolidator-llm.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('semantic-frames')

const DEFAULT_MAX_TURNS_LLM = 200
const DEFAULT_MAX_TOKENS_LLM = 1024

export type SemanticFramesInferrer = (
  trace: TraceStep[],
) => Promise<{ frames: (string[] | undefined)[] }>

// ─── heuristic ─────────────────────────────────────────────────────────

const REQUEST_RX = /^\s*(please|can you|could you|would you|make|build|create|fix|update|run|deploy|generate|write|test|validate|delete|show)\b/i

export function createHeuristicSemanticFramesInferrer(): SemanticFramesInferrer {
  return async (trace) => ({
    frames: trace.map((s) => heuristicForStep(s)),
  })
}

function heuristicForStep(step: TraceStep): string[] | undefined {
  const text = step.content ?? ''
  switch (step.kind) {
    case 'user': {
      if (/\?\s*$/.test(text.trim())) return ['question']
      if (REQUEST_RX.test(text)) return ['request']
      return ['statement']
    }
    case 'agent': {
      if (/```/.test(text)) return ['explanation', 'demonstration']
      return ['explanation']
    }
    case 'tool':
      return ['action']
    case 'system':
      return ['system_event']
    case 'memory':
    case 'brain':
      return ['recall']
    default:
      return undefined
  }
}

// ─── LLM-backed ───────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You annotate each turn in a multi-turn conversation with semantic frames.

A frame is a single short token describing the speech act / function of
the turn (e.g. "question", "request", "explanation", "constraint",
"comparison", "agreement", "refusal", "demonstration", "action",
"recall", "system_event").

Rules:
- Output a single JSON object: { "frames": [[<frame>, ...], ...] }
- The outer array length MUST equal the number of turns provided.
- Each inner array carries 1-4 lowercase tokens. Snake_case for
  multi-word frames ("system_event").
- No prose, no fences, no explanations. JSON object only.
- A turn with no clear frame can be []; do not omit slots.`

export interface LlmSemanticFramesOptions {
  client: LlmClient
  /** Used when the LLM call fails or returns the wrong shape. Default = heuristic. */
  fallback?: SemanticFramesInferrer
  /** Trace lengths above this skip the LLM call entirely. Default 200. */
  maxTurnsInPrompt?: number
  /** Token cap on the LLM response. Default 1024. */
  maxTokens?: number
}

export function createLlmSemanticFramesInferrer(
  opts: LlmSemanticFramesOptions,
): SemanticFramesInferrer {
  const fallback = opts.fallback ?? createHeuristicSemanticFramesInferrer()
  const maxTurns = opts.maxTurnsInPrompt ?? DEFAULT_MAX_TURNS_LLM
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS_LLM

  return async (trace) => {
    if (trace.length === 0) return { frames: [] }
    if (trace.length > maxTurns) {
      log.warn('llm semantic frames: trace exceeds maxTurnsInPrompt; using fallback', {
        traceLength: trace.length,
        maxTurns,
      })
      return fallback(trace)
    }

    const prompt = buildPrompt(trace)
    let raw: string
    try {
      raw = await opts.client.generate({ system: SYSTEM_PROMPT, user: prompt, maxTokens })
    } catch (err) {
      log.warn('llm semantic frames: client.generate threw — using fallback', {
        error: (err as Error).message,
      })
      return fallback(trace)
    }

    const parsed = parseFramesResponse(raw, trace.length)
    if (parsed.length !== trace.length) {
      log.warn('llm semantic frames: shape mismatch — using fallback', {
        expected: trace.length,
        got: parsed.length,
      })
      return fallback(trace)
    }
    return { frames: parsed }
  }
}

export function buildPrompt(trace: TraceStep[]): string {
  const lines: string[] = []
  lines.push(`Trace (${trace.length} turns):`)
  trace.forEach((step, i) => {
    const text = (step.content ?? '').replace(/\s+/g, ' ').slice(0, 200)
    lines.push(`[${i}] ${step.kind}: ${text}`)
  })
  lines.push('')
  lines.push('Now produce the JSON object described in the system prompt.')
  return lines.join('\n')
}

/**
 * Parse the LLM's response JSON. Returns the raw `frames` array
 * (length normalised to the input trace length when possible) or `[]`
 * on malformed input. Caller compares `.length` against trace length
 * and falls back when mismatched.
 */
export function parseFramesResponse(raw: string, expectedLen: number): (string[] | undefined)[] {
  if (!raw) return []
  let text = raw.trim()
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
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
  const frames = Array.isArray(obj['frames']) ? (obj['frames'] as unknown[]) : []
  if (frames.length !== expectedLen) return []

  return frames.map((row) => {
    if (!Array.isArray(row)) return undefined
    const cleaned = (row as unknown[])
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map((s) => s.toLowerCase().slice(0, 30))
      .slice(0, 4)
    return cleaned.length > 0 ? cleaned : undefined
  })
}
