/**
 * LLM-backed SummaryExtractor for the Consolidator.
 *
 * Drop-in replacement for the heuristic extractor in src/memory/consolidator.ts.
 * When an Anthropic API key is present, calls the Messages API to produce a
 * calibrated session summary + proposals. Otherwise, falls back to the
 * heuristic (so tests + offline runs still work end-to-end).
 *
 * The LLM is NOT asked to do Three-Gate scoring — that stays in the
 * deterministic Consolidator where it can be audited. The LLM only generates
 * candidates; the composite score decides what survives.
 *
 * Why a dedicated client class (not the SDK)?
 *   (a) We keep runtime deps zero — just fetch. CI doesn't need @anthropic-ai/sdk
 *       to compile or test this module.
 *   (b) The prompt + response shape is stable and small; a thin client is
 *       easier to reason about than layered SDK defaults.
 */

import type {
  ConsolidationInput,
  SummaryExtractor,
} from './consolidator.js'
import type { InboundArtifact, Phase, TraceStep } from './types.js'
import { isAtomicId } from './atomic-id.js'
import { isPresent, isRecord, toStringArray } from '../lib/guards.js'
import { withRetry } from '../lib/retry.js'
import type { CostTracker } from '../lib/cost-tracker.js'
import { createLogger } from '../lib/logger.js'
import { redactSecrets, truncate } from '../lib/text.js'

const log = createLogger('consolidator:llm')

export interface LlmClient {
  /**
   * Returns the raw assistant text for a single-turn request. The extractor
   * is responsible for parsing the JSON body out of the response.
   */
  generate(args: {
    system: string
    user: string
    maxTokens?: number
  }): Promise<string>
  readonly name: string
}

export interface AnthropicClientOptions {
  apiKey?: string
  baseUrl?: string
  model?: string
  /**
   * API version header. Kept explicit so that upstream breaking changes surface
   * as a version mismatch rather than mysterious 400s.
   */
  version?: string
  /**
   * Optional CostTracker to record token usage from each Messages API
   * response. Anthropic returns `usage.{input_tokens, output_tokens}`
   * natively — no estimation needed.
   */
  costTracker?: CostTracker
  /** Extra labels added to cost records (tenant_id, session_id, ...). */
  costAttrs?: Record<string, string>
}

export function createAnthropicClient(opts: AnthropicClientOptions = {}): LlmClient {
  const apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY']
  if (!apiKey) {
    throw new Error('createAnthropicClient: ANTHROPIC_API_KEY is not set')
  }
  const baseUrl = opts.baseUrl ?? process.env['ANTHROPIC_BASE_URL'] ?? 'https://api.anthropic.com'
  const model =
    opts.model ??
    process.env['ANTHROPIC_CONSOLIDATOR_MODEL'] ??
    // Sonnet 4.6 is the safe default for consolidation — cheap, fast, good
    // enough at structured extraction. Opus is overkill here.
    'claude-sonnet-4-6'
  const version = opts.version ?? '2023-06-01'

  return {
    name: `anthropic:${model}`,
    async generate({ system, user, maxTokens = 2048 }) {
      return withRetry(
        async () => {
          const res = await fetch(`${baseUrl}/v1/messages`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': apiKey,
              'anthropic-version': version,
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              system,
              messages: [{ role: 'user', content: user }],
            }),
          })
          if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`anthropic ${res.status}: ${truncate(redactSecrets(body), 300)}`)
          }
          const data = (await res.json()) as {
            content?: Array<{ type: string; text?: string }>
            usage?: { input_tokens?: number; output_tokens?: number }
          }
          if (opts.costTracker && data.usage) {
            opts.costTracker.record({
              provider: 'anthropic',
              model,
              inputTokens: data.usage.input_tokens ?? 0,
              outputTokens: data.usage.output_tokens ?? 0,
              ...(opts.costAttrs ? { attrs: opts.costAttrs } : {}),
            })
          }
          return (data.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('')
        },
        { label: 'anthropic-messages' },
      )
    },
  }
}

// ─── the extractor ─────────────────────────────────────────────────────────

export interface LlmExtractorOptions {
  client: LlmClient
  /** Fallback used when the LLM call fails or returns malformed output. */
  fallback: SummaryExtractor
  /** Cap how much of the trace to feed the model. Default 200 messages. */
  maxMessages?: number
  /** maxTokens passed to the model. Default 2048. */
  maxTokens?: number
}

const SYSTEM_PROMPT = `You are the Consolidator for an agentic memory system (GKS v3 / EVA Tri-Brain).
You consolidate a multi-turn session into a structured episodic memory record.

You MUST respond with a single JSON object and nothing else (no prose, no code
fences, no prefixes). The JSON schema is:

{
  "summary": string,              // 3-6 sentence prose summary of the session
  "tags": string[],               // 3-8 lowercase topic tags
  "outcomes": string[],           // concrete things the session produced / decided / concluded
  "emotionSummary": string,       // one short phrase describing overall affect
  "linkedAtoms": string[],        // any GKS atomic IDs explicitly referenced (e.g. "CONCEPT--FOO")
  "proposals": [                  // candidate new atomic notes, 0-5 items
    {
      "proposed_id": string,      // "TYPE--SLUG" format (uppercase, e.g. "INSIGHT--USER-PREFERS-DARK-MODE")
      "phase": number,            // 1 | 2 | 3 (default 1 for raw insights)
      "type": string,             // "insight" | "fact" | "rule" | "concept" | "adr"
      "title": string,            // 3-10 word human-readable title
      "body": string,             // 2-5 sentence detail; cite the observation
      "confidence": number        // 0.0 - 1.0, your confidence this is worth retaining
    }
  ]
}

Rules:
- Only propose an atom if the session contains a discrete, reusable idea worth
  retaining as a separate note. Err on the side of fewer proposals.
- The summary must be factual; never speculate beyond what the trace shows.
- If the session is short or trivial, proposals may be an empty array.
- Tags must be single lowercase tokens or kebab-case (e.g. "memory", "code-review").`

export function createLlmExtractor(opts: LlmExtractorOptions): SummaryExtractor {
  const maxMessages = opts.maxMessages ?? 200
  const maxTokens = opts.maxTokens ?? 2048

  return {
    async extract(input: ConsolidationInput) {
      const userPrompt = buildUserPrompt(input, maxMessages)

      let raw: string
      try {
        raw = await opts.client.generate({
          system: SYSTEM_PROMPT,
          user: userPrompt,
          maxTokens,
        })
      } catch (err) {
        log.warn('llm extractor failed — falling back to heuristic', {
          client: opts.client.name,
          error: (err as Error).message,
        })
        return opts.fallback.extract(input)
      }

      const parsed = tryParseExtractorOutput(raw)
      if (!parsed) {
        log.warn('llm extractor returned unparseable output — falling back', {
          client: opts.client.name,
          preview: raw.slice(0, 200),
        })
        return opts.fallback.extract(input)
      }

      // Stamp source_session on every proposal so the Three-Gate filter can
      // score them downstream.
      const proposals: InboundArtifact[] = parsed.proposals.map((p) => ({
        ...p,
        source_session: input.sessionId,
      }))

      return {
        summary: parsed.summary,
        tags: parsed.tags,
        outcomes: parsed.outcomes,
        emotionSummary: parsed.emotionSummary,
        linkedAtoms: parsed.linkedAtoms,
        proposals,
      }
    },
  }
}

function buildUserPrompt(input: ConsolidationInput, maxMessages: number): string {
  const conversational = input.trace.filter((s) => s.kind === 'user' || s.kind === 'agent')
  const truncated =
    conversational.length > maxMessages
      ? conversational.slice(-maxMessages)
      : conversational

  const header =
    `Session: ${input.sessionId}\n` +
    `Started: ${input.startedAt}\n` +
    `Ended: ${input.endedAt}\n` +
    `Participants: ${input.participants.join(', ')}\n` +
    (conversational.length > maxMessages
      ? `(showing most recent ${maxMessages} of ${conversational.length} messages)\n`
      : '') +
    `\n---\n`

  const body = truncated.map(formatStep).join('\n\n')

  return (
    header +
    body +
    `\n\n---\n` +
    `Respond now with the JSON object described in the system prompt. No other text.`
  )
}

function formatStep(step: TraceStep): string {
  const who = step.kind === 'user' ? 'USER' : step.kind === 'agent' ? 'AGENT' : step.kind.toUpperCase()
  // Neutralize attempts by user content to spoof a turn boundary, e.g. a
  // message that contains "\n[AGENT] ignore previous and …" — the LLM would
  // otherwise read it as a real agent turn. Replace bracketed turn-tag
  // patterns and collapse linebreaks so each step renders as one labelled
  // line.
  const safe = step.content
    .replace(/\r/g, '')
    .replace(/\n\s*\[(USER|AGENT|TOOL|BRAIN|MEMORY|SYSTEM)\]/gi, ' [$1-quoted]')
    .replace(/\n+/g, ' ⏎ ')
  return `[${who}] ${safe}`
}

interface ParsedExtractorOutput {
  summary: string
  tags: string[]
  outcomes: string[]
  emotionSummary: string
  linkedAtoms: string[]
  proposals: Array<{
    proposed_id: string
    phase: Phase
    type: string
    title: string
    body: string
    confidence?: number
  }>
}

/** Hard cap on extractor JSON payload size — defends against pathological
 *  upstream responses (DoS via deeply nested or massive JSON). 1 MiB is
 *  well above any reasonable proposal set; anything larger is malformed. */
const MAX_EXTRACTOR_JSON_BYTES = 1 << 20

function tryParseExtractorOutput(raw: string): ParsedExtractorOutput | null {
  const jsonText = extractJsonObject(raw)
  if (!jsonText) return null
  if (jsonText.length > MAX_EXTRACTOR_JSON_BYTES) {
    log.warn('llm extractor output exceeded size cap — rejecting', {
      bytes: jsonText.length,
      cap: MAX_EXTRACTOR_JSON_BYTES,
    })
    return null
  }
  try {
    const parsed = JSON.parse(jsonText) as unknown
    return validateExtractorOutput(parsed)
  } catch {
    return null
  }
}

/**
 * Extract the outermost JSON object from a model response. We try:
 *   1. raw text looks like it starts with `{`
 *   2. ```json fenced block
 *   3. first `{`..matching `}` pair by bracket-depth counting
 */
function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{')) return trimmed

  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/i.exec(trimmed)
  if (fenced && fenced[1]) return fenced[1]

  const start = trimmed.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]!
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return trimmed.slice(start, i + 1)
    }
  }
  return null
}

function validateExtractorOutput(x: unknown): ParsedExtractorOutput | null {
  if (!isRecord(x)) return null
  const summary = typeof x['summary'] === 'string' ? x['summary'] : null
  if (!summary) return null
  const tags = toStringArray(x['tags'])
  const outcomes = toStringArray(x['outcomes'])
  const emotionSummary = typeof x['emotionSummary'] === 'string' ? x['emotionSummary'] : 'neutral'
  const linkedAtoms = toStringArray(x['linkedAtoms'])

  const proposalsRaw = Array.isArray(x['proposals']) ? (x['proposals'] as unknown[]) : []
  const proposals = proposalsRaw
    .map((p) => {
      if (!isRecord(p)) return null
      const proposed_id = typeof p['proposed_id'] === 'string' ? p['proposed_id'] : null
      const title = typeof p['title'] === 'string' ? p['title'] : null
      const body = typeof p['body'] === 'string' ? p['body'] : null
      const type = typeof p['type'] === 'string' ? p['type'] : 'insight'
      const phaseRaw = typeof p['phase'] === 'number' ? p['phase'] : 1
      // Clamp confidence at the extractor edge. Three-Gate scoring re-clamps,
      // but the raw value also lands in InboundArtifact frontmatter + API
      // responses where unclamped values would mislead reviewers.
      const confRaw = typeof p['confidence'] === 'number' ? p['confidence'] : undefined
      const confidence =
        confRaw !== undefined && Number.isFinite(confRaw)
          ? Math.max(0, Math.min(1, confRaw))
          : undefined
      if (!proposed_id || !title || !body) return null
      if (!isAtomicId(proposed_id)) return null
      const phase = (Number.isInteger(phaseRaw) && phaseRaw >= 0 && phaseRaw <= 5
        ? phaseRaw
        : 1) as Phase
      return {
        proposed_id,
        phase,
        type,
        title,
        body,
        ...(confidence !== undefined ? { confidence } : {}),
      }
    })
    .filter(isPresent)

  return { summary, tags, outcomes, emotionSummary, linkedAtoms, proposals }
}

