/**
 * Session lifecycle hooks.
 *
 * Contract from BLUEPRINT--memory §init_sequence:
 *   on_session_start:
 *     - load atomic_index.jsonl
 *     - load vector manifest (verify embedder compatibility)
 *     - ping obsidian MCP (non-blocking)
 *     - warn if episodic vector missing
 *
 *   on_session_end:
 *     - flush trace to disk
 *     - if consolidation_trigger: run consolidator
 *     - if new atomic_proposals: write to inbound
 *     - update session.json → ended
 *
 * The orchestrator owns session identity + clock; this module only provides
 * the stateless functions it calls. Tests can drive it directly without
 * spinning up an orchestrator.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { MemoryStore } from './index.js'
import type { ConsolidationInput } from './consolidator.js'
import type { SummaryExtractor } from './consolidator.js'
import type { TraceStep } from './types.js'
import { reflect, type ReflectResult } from './api.js'
import { readJsonSafe, writeJson } from '../lib/jsonl.js'
import { manifestCompatible, readManifest } from './vector/manifest.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('session')

export interface SessionMetadata {
  id: string                 // MSP-SESS-...
  started_at: string
  ended_at?: string
  participants: string[]
  tags?: string[]
  tokens_total?: number
  cost_usd?: number
}

export interface StartSessionOptions {
  id?: string
  participants?: string[]
  tags?: string[]
  /** Where to write session.json. Default: <root>/.brain/msp/projects/evaAI/session. */
  sessionDir?: string
  /** Timeout (ms) for the non-blocking Obsidian ping. Default 500. */
  obsidianPingTimeoutMs?: number
}

export interface StartSessionReport {
  session: SessionMetadata
  atomicLoaded: number
  embedder: { provider: string; model: string; dimension: number }
  vectorManifestCompatible: boolean
  obsidianReachable: boolean
  warnings: string[]
  sessionFilePath: string
}

export async function startSession(
  store: MemoryStore,
  opts: StartSessionOptions = {},
): Promise<StartSessionReport> {
  const warnings: string[] = []

  // 1. Load atomic index.
  await store.atomic.loadIndex()
  const atomicLoaded = store.atomic.size()

  // 2. Resolve embedder + verify vector manifest compatibility.
  const embedder = await store.embedder()
  const vectorDir = store.vectorDir
  const manifest = await readManifest(vectorDir)
  const vectorManifestCompatible = manifest
    ? manifestCompatible(manifest, embedder.model, embedder.dimension)
    : true
  if (manifest && !vectorManifestCompatible) {
    warnings.push(
      `vector manifest embedder (${manifest.embedder_model} dim ${manifest.dimension}) ` +
        `differs from current (${embedder.model} dim ${embedder.dimension}); ` +
        `run 'npm run re-embed -- --full' before ingesting new content.`,
    )
  }

  // 3. Ping obsidian (non-blocking, best-effort).
  const obsidianReachable = await pingObsidianWithTimeout(
    store.obsidian,
    opts.obsidianPingTimeoutMs ?? 500,
  )
  if (store.obsidian && !obsidianReachable) {
    warnings.push('obsidian adapter configured but unreachable; retrieve() will skip that source')
  }

  // 4. Episodic vector: warn if missing (not fatal).
  try {
    const episodic = await store.getVectorStore('episodic')
    void episodic
  } catch (err) {
    warnings.push(`episodic vector store unavailable: ${(err as Error).message}`)
  }

  // Create session metadata + write session.json.
  const session: SessionMetadata = {
    id: opts.id ?? generateSessionId(),
    started_at: new Date().toISOString(),
    participants: opts.participants ?? [],
    ...(opts.tags ? { tags: opts.tags } : {}),
  }

  const sessionDir = opts.sessionDir ?? store.sessionDir
  await mkdir(sessionDir, { recursive: true })
  const sessionFilePath = join(sessionDir, `${session.id}.session.json`)
  await writeJson(sessionFilePath, { ...session, status: 'active' })

  log.info('session started', {
    id: session.id,
    atomicLoaded,
    embedder: embedder.provider,
    vectorManifestCompatible,
    obsidianReachable,
    warnings: warnings.length,
  })

  return {
    session,
    atomicLoaded,
    embedder: {
      provider: embedder.provider,
      model: embedder.model,
      dimension: embedder.dimension,
    },
    vectorManifestCompatible,
    obsidianReachable,
    warnings,
    sessionFilePath,
  }
}

export interface EndSessionOptions {
  /**
   * If provided, forces consolidation regardless of the advisory trigger
   * threshold. Default: let Consolidator.shouldConsolidate() decide.
   */
  forceConsolidate?: boolean
  /** Extractor to use when consolidating. Default: heuristic. */
  extractor?: SummaryExtractor
  /** If true (default), writes EpisodicMemory to disk + forwards proposals. */
  persist?: boolean
  sessionDir?: string
}

export interface EndSessionReport {
  session: SessionMetadata
  consolidated: boolean
  triggered: boolean
  reflect?: ReflectResult
  traceSteps: number
  sessionFilePath: string
}

export async function endSession(
  store: MemoryStore,
  session: SessionMetadata,
  opts: EndSessionOptions = {},
): Promise<EndSessionReport> {
  const endedAt = new Date().toISOString()
  const trace = await store.episodic.readTrace(session.id)

  const input: ConsolidationInput = {
    sessionId: session.id,
    startedAt: session.started_at,
    endedAt,
    participants: session.participants,
    trace: trace as TraceStep[],
    ...(session.tokens_total !== undefined ? { tokensTotal: session.tokens_total } : {}),
    ...(session.cost_usd !== undefined ? { costUsd: session.cost_usd } : {}),
  }

  // Advisory trigger (from Consolidator) plus explicit override.
  const { Consolidator } = await import('./consolidator.js')
  const consolidator = new Consolidator({
    ...(opts.extractor ? { extractor: opts.extractor } : {}),
  })
  const triggered = consolidator.shouldConsolidate(input)
  const runConsolidation = opts.forceConsolidate === true || triggered

  let reflectResult: ReflectResult | undefined
  if (runConsolidation) {
    reflectResult = await reflect(store, input, {
      ...(opts.persist !== undefined ? { persist: opts.persist } : {}),
      ...(opts.extractor ? { extractor: opts.extractor } : {}),
    })
  }

  // Update session.json → status: ended.
  const sessionDir = opts.sessionDir ?? store.sessionDir
  const sessionFilePath = join(sessionDir, `${session.id}.session.json`)
  const existing = await readJsonSafe<Record<string, unknown>>(sessionFilePath)

  // Snapshot cost / token usage for the session, if a tracker is configured.
  const costSummary = store.costTracker?.summary()

  const merged = {
    ...(existing ?? {}),
    ...session,
    ended_at: endedAt,
    status: 'ended',
    consolidated: runConsolidation,
    consolidation_triggered: triggered,
    proposals: reflectResult?.proposals.length ?? 0,
    episodic_path: reflectResult?.episodicPath,
    ...(costSummary
      ? {
          tokens_total: costSummary.total.input_tokens + costSummary.total.output_tokens,
          cost_usd: costSummary.total.usd,
          cost_breakdown: costSummary.byModel,
        }
      : {}),
  }
  await writeJson(sessionFilePath, merged)

  log.info('session ended', {
    id: session.id,
    ended_at: endedAt,
    traceSteps: trace.length,
    consolidated: runConsolidation,
    proposals: reflectResult?.proposals.length ?? 0,
  })

  return {
    session: { ...session, ended_at: endedAt },
    consolidated: runConsolidation,
    triggered,
    ...(reflectResult ? { reflect: reflectResult } : {}),
    traceSteps: trace.length,
    sessionFilePath,
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

function generateSessionId(): string {
  const now = new Date()
  const yy = String(now.getUTCFullYear()).slice(-2)
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  const serial = randomUUID().slice(0, 4).toUpperCase()
  return `MSP-SESS-${yy}${mm}${dd}${serial}`
}

async function pingObsidianWithTimeout(
  obs: MemoryStore['obsidian'],
  timeoutMs: number,
): Promise<boolean> {
  if (!obs) return false
  try {
    const result = await Promise.race([
      obs.ping(),
      new Promise<boolean>((_, reject) =>
        setTimeout(() => reject(new Error('ping timeout')), timeoutMs),
      ),
    ])
    return result === true
  } catch {
    return false
  }
}
