/**
 * Consolidator (a.k.a "Dreaming") — Phase 1 stub.
 *
 * Full consolidator pipeline per BLUEPRINT--memory §episodic.consolidation:
 *   1. Collect session trace + messages
 *   2. Extract facts, outcomes, tags, emotion_summary (LLM: CORTEX)
 *   3. Three-Gate Scoring (Relevance × Frequency × Recency) → decide what to keep
 *   4. Write EpisodicMemory markdown (→ EpisodicLayer.writeEpisodic)
 *   5. Generate InboundArtifact[] for candidate new atomic notes
 *
 * This file ships the deterministic, LLM-free parts (3, 4, and the mechanical
 * bits of 5) so that higher-level tests can exercise the plumbing without a
 * network call. The LLM-driven extraction is behind an injectable interface so
 * the real implementation plugs in once the CORTEX client is built.
 */

import type {
  EpisodicMemory,
  InboundArtifact,
  Phase,
  TraceStep,
} from './types.js'
import { truncate } from '../lib/text.js'

export interface ConsolidationInput {
  sessionId: string
  startedAt: string
  endedAt: string
  participants: string[]
  trace: TraceStep[]
  tokensTotal?: number
  costUsd?: number
}

export interface ConsolidationOutput {
  memory: EpisodicMemory
  proposals: InboundArtifact[]
}

/** Minimal interface the real (LLM-backed) extractor must implement. */
export interface SummaryExtractor {
  extract(input: ConsolidationInput): Promise<{
    summary: string
    tags: string[]
    outcomes: string[]
    emotionSummary: string
    linkedAtoms: string[]
    proposals: InboundArtifact[]
  }>
}

export interface ConsolidatorOptions {
  extractor?: SummaryExtractor
  /** Three-Gate weights — sum to 1.0 in typical configurations. */
  weights?: { relevance: number; frequency: number; recency: number }
  /** Drop proposals whose composite score is below this. */
  proposalScoreThreshold?: number
  /** Session must have >= this many messages to trigger consolidation. */
  minMessages?: number
  /** Session must be >= this duration (minutes) to trigger consolidation. */
  minDurationMin?: number
}

export class Consolidator {
  private readonly extractor: SummaryExtractor
  private readonly weights: { relevance: number; frequency: number; recency: number }
  private readonly proposalScoreThreshold: number
  private readonly minMessages: number
  private readonly minDurationMin: number

  constructor(opts: ConsolidatorOptions = {}) {
    this.extractor = opts.extractor ?? HEURISTIC_EXTRACTOR
    this.weights = opts.weights ?? { relevance: 0.5, frequency: 0.3, recency: 0.2 }
    this.proposalScoreThreshold = opts.proposalScoreThreshold ?? 0.45
    this.minMessages = opts.minMessages ?? 30
    this.minDurationMin = opts.minDurationMin ?? 60
  }

  /**
   * Trigger policy from BLUEPRINT--memory §episodic.consolidation.trigger:
   *   "session ended" OR ("session > 60 min AND > 30 messages")
   */
  shouldConsolidate(input: ConsolidationInput): boolean {
    const messageCount = input.trace.filter(
      (s) => s.kind === 'user' || s.kind === 'agent',
    ).length
    const durationMin =
      (Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 60_000
    return messageCount >= this.minMessages && durationMin >= this.minDurationMin
  }

  async consolidate(input: ConsolidationInput): Promise<ConsolidationOutput> {
    const extracted = await this.extractor.extract(input)

    const durationMin =
      (Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 60_000

    const memory: EpisodicMemory = {
      id: `SESS--${input.sessionId}`,
      session_id: input.sessionId,
      started_at: input.startedAt,
      ended_at: input.endedAt,
      duration_min: Number.isFinite(durationMin) ? Math.round(durationMin * 10) / 10 : 0,
      participants: input.participants,
      ...(input.tokensTotal !== undefined ? { tokens_total: input.tokensTotal } : {}),
      ...(input.costUsd !== undefined ? { cost_usd: input.costUsd } : {}),
      tags: extracted.tags,
      linked_atoms: extracted.linkedAtoms,
      emotion_summary: extracted.emotionSummary,
      outcomes: extracted.outcomes,
      summary: extracted.summary,
    }

    // Three-Gate filtering on proposals.
    const kept = extracted.proposals
      .map((p) => ({ p, score: this.scoreProposal(p, input) }))
      .filter(({ score }) => score >= this.proposalScoreThreshold)
      .sort((a, b) => b.score - a.score)
      .map(({ p, score }) => ({
        ...p,
        confidence: p.confidence ?? round2(score),
      }))

    return { memory, proposals: kept }
  }

  /**
   * Three-Gate composite score:
   *   relevance — from extractor.confidence (prior)
   *   frequency — how many times the proposed_id was referenced in the trace
   *   recency   — how close to the session end the references are (0..1)
   */
  private scoreProposal(proposal: InboundArtifact, input: ConsolidationInput): number {
    const relevance = clamp01(proposal.confidence ?? 0.5)

    const id = proposal.proposed_id
    let refCount = 0
    let lastIdx = -1
    input.trace.forEach((step, i) => {
      if (step.content.includes(id) || step.content.includes(proposal.title)) {
        refCount++
        lastIdx = i
      }
    })
    const frequency = clamp01(refCount / 5) // caps at 5 mentions = 1.0
    const recency =
      lastIdx < 0 ? 0 : clamp01((lastIdx + 1) / Math.max(1, input.trace.length))

    return (
      this.weights.relevance * relevance +
      this.weights.frequency * frequency +
      this.weights.recency * recency
    )
  }
}

// ───────────────────────────────────────────────────────── heuristic extractor

/**
 * Phase 1 placeholder extractor — LLM-free. Builds a plausible summary from the
 * session trace so that plumbing, tests, and trigger policy can be exercised
 * end-to-end in CI. Replace with a CORTEX-backed extractor in Phase 2.
 */
const HEURISTIC_EXTRACTOR: SummaryExtractor = {
  async extract(input: ConsolidationInput) {
    const userMsgs = input.trace.filter((s) => s.kind === 'user')
    const agentMsgs = input.trace.filter((s) => s.kind === 'agent')
    const toolCalls = input.trace.filter((s) => s.kind === 'tool')

    const topics = extractTopics(input.trace, 6)
    const firstUser = userMsgs[0]?.content ?? ''
    const lastAgent = agentMsgs[agentMsgs.length - 1]?.content ?? ''

    const summary =
      `Session ${input.sessionId} covered ${userMsgs.length} user turns and ` +
      `${agentMsgs.length} agent turns (${toolCalls.length} tool calls). ` +
      `Initial ask: "${truncate(firstUser, 140)}". ` +
      `Final agent response: "${truncate(lastAgent, 200)}".`

    // Propose one candidate atomic per unique topic that looks "atomic-ish"
    // (capitalized, multi-word, appears more than once). The Three-Gate filter
    // in Consolidator will drop low-signal ones.
    const proposals: InboundArtifact[] = topics
      .filter((t) => t.count >= 2 && /^[A-Z]/.test(t.term))
      .slice(0, 5)
      .map((t) => ({
        proposed_id: toAtomicId('INSIGHT', t.term),
        phase: 1 as Phase,
        type: 'insight',
        title: t.term,
        body: `Observed topic "${t.term}" (${t.count} mentions) during session ${input.sessionId}.`,
        source_session: input.sessionId,
        confidence: clamp01(0.3 + t.count * 0.1),
      }))

    return {
      summary,
      tags: topics.slice(0, 5).map((t) => slugify(t.term)),
      outcomes: [],
      emotionSummary: 'neutral',
      linkedAtoms: [],
      proposals,
    }
  },
}

function extractTopics(trace: TraceStep[], maxTerms: number): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>()
  const STOP = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'been',
    'will', 'what', 'when', 'where', 'which', 'about', 'there', 'their',
  ])
  for (const step of trace) {
    if (step.kind !== 'user' && step.kind !== 'agent') continue
    for (const m of step.content.matchAll(/\b[A-Za-z][A-Za-z\-]{3,}\b/g)) {
      const term = m[0]
      const key = term.toLowerCase()
      if (STOP.has(key)) continue
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTerms)
    .map(([term, count]) => ({ term, count }))
}

function toAtomicId(prefix: string, term: string): string {
  return `${prefix}--${term.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  return x < 0 ? 0 : x > 1 ? 1 : x
}

function round2(x: number): number {
  return Math.round(x * 100) / 100
}
