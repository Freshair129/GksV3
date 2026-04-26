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
  Namespace,
  RetainInput,
  RetainResult,
  RetrievalOptions,
  RetrievalResult,
  TraceStep,
} from './types.js'

import { applyNamespace, namespaceAsFilter, type MemoryStore } from './index.js'
import {
  Consolidator,
  type ConsolidationInput,
  type ConsolidationOutput,
  type ConsolidatorOptions,
} from './consolidator.js'
import { createLogger } from '../lib/logger.js'
import {
  METRIC_NAMES,
  incrementCounter,
  recordHistogram,
  withSpan,
} from '../lib/telemetry.js'

const log = createLogger('memory:api')

// ─── Retain ────────────────────────────────────────────────────────────────

export async function retain(
  store: MemoryStore,
  input: RetainInput,
): Promise<RetainResult> {
  return withSpan(
    'gks.retain',
    {
      'gks.content_length': input.content.length,
      'gks.session_id': input.sessionId ?? '',
      'gks.policy': input.conflictPolicy ?? 'auto',
    },
    (span) => retainInner(store, input, span),
  )
}

async function retainInner(
  store: MemoryStore,
  input: RetainInput,
  span: { setAttributes(attrs: Record<string, unknown>): unknown },
): Promise<RetainResult> {
  const now = new Date().toISOString()
  const validFrom = input.validFrom ?? now

  const vectorStore = await store.getVectorStore('atomic')
  const embedder = await store.embedder()

  // Embed ONCE and reuse the vector for both conflict detection and the
  // insert. Previously retain() triggered 2 embedder calls per content
  // (one inside store.search, one inside vectorStore.add) — expensive on
  // real providers.
  const vector = await embedder.embed(input.content)

  // Resolve effective namespace: explicit > (legacy) sessionId > store default.
  const effectiveNs = input.namespace ?? {
    ...store.defaultNamespace,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
  }

  const { conflicts, toInvalidate } = await resolveConflicts(
    vectorStore,
    vector,
    input,
    validFrom,
    effectiveNs,
  )

  const baseMetadata = applyNamespace(input.metadata ?? {}, effectiveNs)
  const doc = await vectorStore.addWithVector(input.content, vector, {
    ...baseMetadata,
    valid_from: validFrom,
    valid_to: null,
    ...(toInvalidate.length > 0 ? { supersedes: toInvalidate[0] } : {}),
  })

  if (toInvalidate.length > 0) {
    await vectorStore.patchMetadataMany(
      toInvalidate.map((id) => ({
        id,
        patch: { valid_to: validFrom, superseded_by: doc.id },
      })),
    )
  }

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
      ...(Object.keys(effectiveNs).length > 0 ? { namespace: effectiveNs } : {}),
      ...(input.linkedSymbols && input.linkedSymbols.length > 0
        ? { linked_symbols: input.linkedSymbols }
        : {}),
    }
    const receipt = await store.proposeInbound(proposed)
    inboundPath = receipt.path
  }

  span.setAttributes({
    'gks.conflicts': conflicts.length,
    'gks.invalidated': toInvalidate.length,
    'gks.proposed_inbound': inboundPath !== undefined,
  })
  incrementCounter(METRIC_NAMES.retainDocs, 1, {
    backend: vectorStore.name,
    has_conflict: String(conflicts.length > 0),
  })

  if (store.audit) {
    await store.audit.emit({
      op: 'retain',
      ...(Object.keys(effectiveNs).length > 0 ? { namespace: effectiveNs } : {}),
      doc_id: doc.id,
      conflicts: conflicts.length,
      invalidated: toInvalidate.length,
      ...(inboundPath !== undefined ? { meta: { inbound_path: inboundPath } } : {}),
    })
  }

  return {
    vectorDocId: doc.id,
    ...(inboundPath !== undefined ? { inboundPath } : {}),
    conflicts,
  }
}

/**
 * Bi-temporal conflict resolution. Reuses semantic search to find very-close
 * existing docs, then applies the requested policy:
 *   - 'coexist'   (default for agentic turns): keep both, flag conflict.
 *   - 'supersede' (for authoritative updates):  mark all matches as invalidated.
 *   - 'auto'      (default):                    supersede iff exact cosine ≥ threshold
 *                                               AND new text meaningfully differs.
 *
 * Returns both the ConflictRecord list (for the caller) and the IDs of docs
 * that should be invalidated (so retain() can flip valid_to after creating the
 * new doc — allowing `superseded_by` to point at a known ID).
 *
 * Already-invalidated docs (valid_to != null or status=='invalid') are skipped.
 */
async function resolveConflicts(
  vectorStore: Awaited<ReturnType<MemoryStore['getVectorStore']>>,
  queryVector: number[],
  input: RetainInput,
  nowIso: string,
  effectiveNs: Namespace,
): Promise<{ conflicts: ConflictRecord[]; toInvalidate: string[] }> {
  const conflicts: ConflictRecord[] = []
  const toInvalidate: string[] = []
  const policy = input.conflictPolicy ?? 'auto'
  const threshold = input.conflictThreshold ?? 0.92
  const newTextNorm = input.content.trim()

  // Scope conflict-detection to the same namespace — tenant A's retain
  // shouldn't supersede tenant B's docs.
  const nsFilter = namespaceAsFilter(effectiveNs)

  try {
    const hits = await vectorStore.search(queryVector, {
      topK: 5,
      scoreThreshold: Math.min(0.8, threshold - 0.05),
      ...(nsFilter ? { filter: nsFilter } : {}),
    })

    for (const h of hits) {
      if (h.score < threshold) continue
      if (isInvalid(h.doc.metadata)) continue
      if (h.doc.text.trim() === newTextNorm) continue // true duplicate

      const reason = `cosine ${h.score.toFixed(3)} ≥ threshold ${threshold}`
      const path = (h.doc.metadata['path'] as string | undefined) ?? ''

      if (policy === 'coexist') {
        conflicts.push({ existingId: h.doc.id, existingPath: path, reason, resolution: 'kept_both' })
      } else if (policy === 'supersede' || policy === 'auto') {
        toInvalidate.push(h.doc.id)
        conflicts.push({
          existingId: h.doc.id,
          existingPath: path,
          reason,
          resolution: 'superseded',
          superseded_at: nowIso,
        })
      }
    }
  } catch (err) {
    log.warn('conflict detection skipped', { error: (err as Error).message })
  }

  return { conflicts, toInvalidate }
}

function isInvalid(metadata: Record<string, unknown>): boolean {
  if (metadata['valid_to'] != null) return true
  if (metadata['status'] === 'invalid') return true
  return false
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
