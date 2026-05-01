/**
 * TldrGenerator — produces a calibrated, ≤200-token summary of an atom
 * body. See ADR--SUMMARY-TLDR / BLUEPRINT--SUMMARY-TLDR.
 *
 * Two implementations ship here:
 *
 *   1. createLlmTldrGenerator(opts)  — calls a configured LlmClient
 *      (Anthropic, or any OpenAI-compatible local SLM via the client
 *      added in PR #25). Pricing-aware; on failure falls back to (2).
 *
 *   2. heuristicTldrGenerator()      — deterministic, zero-LLM-cost
 *      fallback. Strips frontmatter + the first H1, then returns the
 *      first 2-3 sentences. Good enough for round-tripping in tests
 *      and offline environments.
 *
 * Both implementations honour the same contract: input = full atom body
 * (markdown, may include H1 + sections), output = a single-paragraph
 * summary with no leading/trailing whitespace and no markdown headings.
 */

import { createHash } from 'node:crypto'

import type { LlmClient } from './consolidator-llm.js'
import { withRetry } from '../lib/retry.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('memory:tldr')

export interface TldrGenerator {
  readonly name: string
  summarize(
    body: string,
    opts?: {
      /** Soft cap on output token length. Default 200. */
      maxTokens?: number
      /** Optional atom title for prompt grounding (LLM impl uses it). */
      title?: string
      /** Optional atom type/phase context for the LLM prompt. */
      type?: string
    },
  ): Promise<string>
}

// ─── heuristic (fallback, always available) ───────────────────────────────

const HEADING_RX = /^#{1,6}\s+.*$/gm
const FRONTMATTER_RX = /^---\n[\s\S]*?\n---\n?/

/**
 * Tries to keep up to N sentences but caps at maxChars. Sentence boundary
 * detection is intentionally simple — we err on the side of one extra
 * fragment rather than chopping mid-word.
 */
function trimToSentences(text: string, maxSentences: number, maxChars: number): string {
  const cleaned = text.trim()
  if (!cleaned) return ''
  const sentences: string[] = []
  // Greedy: split on `.`, `!`, `?` followed by whitespace or end-of-string.
  const re = /[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    sentences.push(m[0]!.trim())
    if (sentences.length >= maxSentences) break
  }
  let out = sentences.join(' ').trim()
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).trimEnd() + '…'
  return out
}

export function heuristicTldrGenerator(): TldrGenerator {
  return {
    name: 'heuristic',
    async summarize(body, opts) {
      const maxTokens = opts?.maxTokens ?? 200
      // Roughly 4 chars per token; matches the estimateTokens heuristic
      // used elsewhere in lib/pricing.ts.
      const maxChars = Math.max(80, maxTokens * 4)
      const stripped = body
        .replace(FRONTMATTER_RX, '')
        .replace(HEADING_RX, '')
        .replace(/\n{2,}/g, '\n')
        .replace(/```[\s\S]*?```/g, '')
        .trim()
      return trimToSentences(stripped, 3, maxChars)
    },
  }
}

// ─── LLM-backed (delegates to LlmClient) ──────────────────────────────────

const LLM_SYSTEM_PROMPT = `You produce a TL;DR for a knowledge atom in the GKS v3 system.

Output rules:
- A single paragraph, no markdown, no headings, no bullets.
- ≤200 tokens (~600-800 characters). Shorter is better when the atom is short.
- Preserve concrete claims, decisions, and named entities.
- Drop boilerplate ("This document describes…").
- Never invent details that are not in the atom.
- Use the atom's own language when possible (English or Thai).

Respond with ONLY the summary text — no quotes, no JSON, no prefix.`

export interface LlmTldrOptions {
  client: LlmClient
  /** Output token cap passed to the LLM. Default 256 (allows ≤200-token output with slack). */
  maxTokens?: number
  /** Used when the LLM call fails or returns empty text. Default heuristic. */
  fallback?: TldrGenerator
}

export function createLlmTldrGenerator(opts: LlmTldrOptions): TldrGenerator {
  const fallback = opts.fallback ?? heuristicTldrGenerator()
  const maxTokens = opts.maxTokens ?? 256
  return {
    name: `llm:${opts.client.name}`,
    async summarize(body, callOpts) {
      const userPrompt = buildUserPrompt(body, callOpts)
      let raw: string
      try {
        raw = await withRetry(
          () => opts.client.generate({ system: LLM_SYSTEM_PROMPT, user: userPrompt, maxTokens }),
          { label: 'tldr-llm' },
        )
      } catch (err) {
        log.warn('llm tldr generator failed — falling back to heuristic', {
          client: opts.client.name,
          error: (err as Error).message,
        })
        return fallback.summarize(body, callOpts)
      }
      const cleaned = sanitize(raw)
      if (!cleaned) {
        log.warn('llm tldr generator returned empty output — falling back to heuristic', {
          client: opts.client.name,
        })
        return fallback.summarize(body, callOpts)
      }
      return cleaned
    },
  }
}

function buildUserPrompt(
  body: string,
  callOpts: { title?: string; type?: string; maxTokens?: number } | undefined,
): string {
  const lines: string[] = []
  if (callOpts?.title) lines.push(`Title: ${callOpts.title}`)
  if (callOpts?.type) lines.push(`Type: ${callOpts.type}`)
  if (lines.length > 0) lines.push('')
  lines.push('Atom body:')
  lines.push('---')
  lines.push(body)
  lines.push('---')
  lines.push('')
  lines.push('Now produce the TL;DR. Plain text only.')
  return lines.join('\n')
}

function sanitize(raw: string): string {
  // LLMs occasionally wrap in quotes or fences despite instructions.
  let out = raw.trim()
  out = out.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim()
  if ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'"))) {
    out = out.slice(1, -1).trim()
  }
  // Strip any leading "TL;DR:" / "Summary:" prefixes.
  out = out.replace(/^(?:tl;?dr|summary)\s*[:\-—]\s*/i, '').trim()
  return out
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Stable short hash of an atom body, used to detect TLDR staleness when
 * the body is edited after the summary was generated. SHA-256, first 16
 * hex chars — collision risk is negligible at any realistic atom count.
 */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)
}

export interface TldrStamp {
  summary_tldr: string
  summary_tldr_body_hash: string
  summary_tldr_generated_at: string
}

/** Run the generator and produce the three frontmatter fields together. */
export async function generateTldrStamp(
  generator: TldrGenerator,
  body: string,
  opts?: { title?: string; type?: string; maxTokens?: number },
): Promise<TldrStamp> {
  const summary = await generator.summarize(body, opts)
  return {
    summary_tldr: summary,
    summary_tldr_body_hash: bodyHash(body),
    summary_tldr_generated_at: new Date().toISOString(),
  }
}
