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
  /**
   * Episodic schema version to write at end-of-session. v2 (default)
   * writes the 3-document split (session.json + episodes.jsonl +
   * turns.jsonl) per BLUEPRINT--EPISODIC-V2 alongside the existing v1
   * markdown. Pass '1' to skip the v2 write (legacy tooling that hasn't
   * migrated). Both versions can coexist on disk; reflect() always
   * produces the v1 EpisodicMemory shape.
   */
  schemaVersion?: '1' | '2' | 'both'
  /**
   * Episode boundary detection (BLUEPRINT--EPISODE-BOUNDARY).
   *   undefined / not set → use the default detector
   *                         (time-gap + explicit; semantic OFF)
   *   false               → legacy single-episode mode
   *   { ...opts }         → tweak detector config
   *   { detector }        → bring your own detector function
   */
  episodeBoundary?:
    | false
    | import('./episode-boundary.js').EpisodeBoundaryOptions
    | { detector: import('./episode-boundary.js').EpisodeBoundaryDetector }
}

export interface EndSessionReport {
  session: SessionMetadata
  consolidated: boolean
  triggered: boolean
  reflect?: ReflectResult
  traceSteps: number
  sessionFilePath: string
  /** Set when v2 episodic was written (default 'both' / '2'). */
  episodicV2Path?: string
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

  // EPISODIC-V2 write — runs alongside the v1 markdown. Default 'both'
  // so existing readers see no behavioural change while new readers
  // get the richer schema. Trace gets segmented into Episodes per
  // BLUEPRINT--EPISODE-BOUNDARY (default: time-gap + explicit-marker
  // detection; semantic OFF for cost reasons).
  const schemaVersion = opts.schemaVersion ?? 'both'
  let episodicV2Path: string | undefined
  if ((schemaVersion === '2' || schemaVersion === 'both') && opts.persist !== false) {
    try {
      episodicV2Path = await writeEpisodicV2(
        store,
        session,
        endedAt,
        trace as TraceStep[],
        reflectResult,
        opts.episodeBoundary,
      )
    } catch (err) {
      log.warn('episodic v2 write failed (v1 still wrote)', {
        session_id: session.id,
        error: (err as Error).message,
      })
    }
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
    ...(episodicV2Path ? { episodic_v2_path: episodicV2Path } : {}),
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
    ...(episodicV2Path ? { episodicV2Path } : {}),
  }
}

/**
 * Translate the legacy trace.jsonl into a v2 EpisodicSession +
 * one Episode + one Turn per trace step. Conservative shape — keeps
 * everything append-only-friendly so a future consolidator can layer
 * episode boundary detection on top without touching the wire format.
 */
async function writeEpisodicV2(
  store: MemoryStore,
  session: SessionMetadata,
  endedAt: string,
  trace: TraceStep[],
  reflectResult: ReflectResult | undefined,
  boundaryOpt: EndSessionOptions['episodeBoundary'],
): Promise<string> {
  const { newEpisodicSession } = await import('./episodic-v2.js')
  const layer = store.episodicV2

  // Skip if a v2 session already exists (idempotent endSession in tests).
  const existing = await layer.readSession(session.id)
  if (!existing) {
    const sess = newEpisodicSession({
      session_id: session.id,
      system: 'gks-v3',
      started_at: session.started_at,
    })
    await layer.writeSession(sess)
  }

  // Resolve segments: legacy mode = single segment; configured = use
  // detector or BYO function; default = use the default detector
  // (time-gap + explicit; semantic off).
  let segments: import('./episode-boundary.js').EpisodeSegment[] = []
  if (boundaryOpt === false) {
    // Legacy: one Episode for the whole trace.
    segments = trace.length > 0 ? [{ start_index: 0, end_index: trace.length, reason: 'initial', signals: {} }] : []
  } else {
    const { detectEpisodeBoundaries } = await import('./episode-boundary.js')
    if (
      boundaryOpt &&
      typeof boundaryOpt === 'object' &&
      'detector' in boundaryOpt &&
      typeof boundaryOpt.detector === 'function'
    ) {
      segments = await boundaryOpt.detector(trace)
    } else {
      segments = await detectEpisodeBoundaries(trace, (boundaryOpt as import('./episode-boundary.js').EpisodeBoundaryOptions) ?? {})
    }
  }

  // No turns / no segments → emit nothing (matches the previous
  // skipped-turn behaviour for empty traces).
  if (segments.length === 0 && trace.length === 0) {
    await layer.finaliseSession(session.id, {
      ended_at: endedAt,
      ...(reflectResult?.memory.summary ? { summary: reflectResult.memory.summary } : {}),
      ...(reflectResult?.memory.outcomes ? { outcomes: reflectResult.memory.outcomes } : {}),
      ...(reflectResult?.memory.tags ? { tags: reflectResult.memory.tags } : {}),
    })
    return session.id
  }

  // Idempotency: if any expected episode_id already exists, treat the
  // whole call as a no-op for episodes/turns (caller is replaying).
  const existingEpisodes = await layer.listEpisodes(session.id)
  if (existingEpisodes.length === 0) {
    let segNum = 0
    for (const seg of segments) {
      segNum++
      const episodeId = `E-${session.id}-${String(segNum).padStart(3, '0')}`
      const isFirstSegment = segNum === 1
      // Crosslinks + tags from reflectResult attach to the first segment
      // only — they're session-level summaries, not per-Episode.
      await layer.appendEpisode(session.id, {
        episode_id: episodeId,
        episode_type: 'interaction',
        ...(isFirstSegment && reflectResult?.memory.tags
          ? { episode_tag: reflectResult.memory.tags }
          : {}),
        ...(isFirstSegment &&
        reflectResult?.memory.linked_atoms &&
        reflectResult.memory.linked_atoms.length > 0
          ? { crosslinks: { references: reflectResult.memory.linked_atoms } }
          : {}),
        provenance: {
          written_by: 'gks-session-end',
          ...(reflectResult && isFirstSegment ? { llm_contribution: ['summary'] } : {}),
          authoritative_fields: [
            `episode_reason:${seg.reason}`,
            ...(seg.signals.gapMs !== undefined ? [`gap_ms:${seg.signals.gapMs}`] : []),
            ...(seg.signals.cosine !== undefined ? [`cosine:${seg.signals.cosine.toFixed(4)}`] : []),
          ],
        },
      })

      for (let i = seg.start_index; i < seg.end_index; i++) {
        const step = trace[i]!
        await layer.appendTurn(session.id, {
          episode_id: episodeId,
          speaker: step.kind,
          t: step.t,
          raw_text: step.content,
        })
      }
    }
  }

  // Finalise: stamp ended_at + summary into session.json + _index.jsonl.
  await layer.finaliseSession(session.id, {
    ended_at: endedAt,
    ...(reflectResult?.memory.summary ? { summary: reflectResult.memory.summary } : {}),
    ...(reflectResult?.memory.outcomes ? { outcomes: reflectResult.memory.outcomes } : {}),
    ...(reflectResult?.memory.tags ? { tags: reflectResult.memory.tags } : {}),
  })

  return session.id // session_id is the v2 key
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
