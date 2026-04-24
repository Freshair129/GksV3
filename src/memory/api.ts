/**
 * Core functional API — Retain / Recall / Reflect.
 *
 * These are the three verbs called out in the Spec §3:
 *   Retain(content, metadata)  — write path: index + conflict check + optional inbound
 *   Recall(query, strategy)    — read  path: multi-strategy retrieval (+ rerank hook)
 *   Reflect(session_history)   — session end: consolidate trace → episodic + proposals
 *
 * The heavy lifting lives in MemoryStore and Consolidator — this module is the
 * thin, ergonomic façade that agents (and tests) are expected to call.
 */

import type {
  ConflictRecord,
  EpisodicMemory,
  InboundArtifact,
  RetainInput,
  RetainResult,
  RetrievalOptions,
  RetrievalResult,
  TraceStep,
} from './types.js'

import type { MemoryStore } from './index.js'
import {
  Consolidator,
  type ConsolidationInput,
  type ConsolidationOutput,
  type ConsolidatorOptions,
} from './consolidator.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('memory:api')

// ─── Retain ────────────────────────────────────────────────────────────────

export async function retain(
  store: MemoryStore,
  input: RetainInput,
): Promise<RetainResult> {
  const conflicts = await detectConflicts(store, input)

  const vectorStore = await store.getVectorStore('atomic')
  const doc = await vectorStore.add(input.content, {
    ...(input.metadata ?? {}),
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
  })

  let inboundPath: string | undefined
  if (input.proposeInbound) {
    const proposed: InboundArtifact = {
      proposed_id: deriveProposedId(input),
      phase: input.inboundPhase ?? 1,
      type: input.inboundType ?? 'fact',
      title: deriveTitle(input.content),
      body: input.content,
      ...(input.sessionId ? { source_session: input.sessionId } : {}),
      confidence: 0.5,
    }
    const receipt = await store.proposeInbound(proposed)
    inboundPath = receipt.path
  }

  return {
    vectorDocId: doc.id,
    ...(inboundPath !== undefined ? { inboundPath } : {}),
    conflicts,
  }
}

/**
 * Lightweight conflict detector — reuses semantic search to find very-close
 * existing docs. Heuristic: if cosine ≥ 0.92 and the text isn't identical,
 * we flag it. A full bi-temporal resolver (valid_from/valid_to flip) lives in
 * Phase 2 alongside the Temporal Graph layer.
 */
async function detectConflicts(
  store: MemoryStore,
  input: RetainInput,
): Promise<ConflictRecord[]> {
  const out: ConflictRecord[] = []
  try {
    const hits = await store.search(input.content, 'vector', {
      topK: 3,
      scoreThreshold: 0.8,
    })
    for (const h of hits) {
      if (h.score >= 0.92 && h.snippet.trim() !== input.content.trim()) {
        out.push({
          existingId: h.id,
          existingPath: h.path ?? '',
          reason: `high-similarity pre-existing entry (cosine ${h.score.toFixed(3)})`,
          resolution: 'kept_both',
        })
      }
    }
  } catch (err) {
    log.warn('conflict detection skipped', { error: (err as Error).message })
  }
  return out
}

function deriveProposedId(input: RetainInput): string {
  const typ = (input.inboundType ?? 'fact').toUpperCase()
  const slug = deriveTitle(input.content)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${typ}--${slug || 'UNTITLED'}`
}

function deriveTitle(content: string): string {
  const firstLine = content.split(/\r?\n/)[0]!.trim()
  const words = firstLine.split(/\s+/).slice(0, 8).join(' ')
  return words || 'Untitled'
}

// ─── Recall ────────────────────────────────────────────────────────────────

export async function recall(
  store: MemoryStore,
  query: string,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  return store.retrieve(query, options)
}

// ─── Reflect ───────────────────────────────────────────────────────────────

export interface ReflectOptions extends ConsolidatorOptions {
  /**
   * If true (default), writes the consolidated EpisodicMemory to disk and
   * forwards proposals to the inbound queue. If false, returns the output
   * without side effects — useful for previews / tests.
   */
  persist?: boolean
}

export interface ReflectResult extends ConsolidationOutput {
  episodicPath?: string
  inboundPaths: string[]
  triggered: boolean
}

export async function reflect(
  store: MemoryStore,
  input: ConsolidationInput,
  options: ReflectOptions = {},
): Promise<ReflectResult> {
  const { persist = true, ...consolidatorOpts } = options
  const consolidator = new Consolidator(consolidatorOpts)

  // shouldConsolidate is advisory — callers can gate on it before invoking
  // reflect(). When called explicitly we always run and return the flag.
  const triggered = consolidator.shouldConsolidate(input)

  const { memory, proposals } = await consolidator.consolidate(input)

  if (!persist) {
    return { memory, proposals, inboundPaths: [], triggered }
  }

  const inboundPaths: string[] = []
  for (const p of proposals) {
    const receipt = await store.proposeInbound(p)
    inboundPaths.push(receipt.path)
  }

  let episodicPath: string | undefined
  try {
    await store.writeEpisodic(memory)
    // EpisodicLayer doesn't return a path; derive the expected file name.
    episodicPath = `${memory.session_id}.md`
  } catch (err) {
    log.warn('episodic write refused (exists)', {
      session_id: memory.session_id,
      err: (err as Error).message,
    })
  }

  return {
    memory,
    proposals,
    inboundPaths,
    triggered,
    ...(episodicPath !== undefined ? { episodicPath } : {}),
  }
}

// ─── re-exports for ergonomic imports ──────────────────────────────────────

export type { ConsolidationInput, ConsolidationOutput, TraceStep, EpisodicMemory }
