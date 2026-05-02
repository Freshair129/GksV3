/**
 * Episodic memory v2 — three-document split + typed crosslinks.
 *
 * Implements BLUEPRINT--EPISODIC-V2. See FEAT--EPISODIC-V2 for
 * acceptance criteria. The v1 layout (one markdown per session) lives
 * in episodic.ts; this module is the new richer storage path.
 *
 * Layout per session:
 *   <episodicDir>/<session_id>/
 *     ├── session.json     — top-level metadata, immutable after finalise
 *     ├── episodes.jsonl   — append-only, 1 line/episode
 *     └── turns.jsonl      — append-only, 1 line/turn (FK episode_id)
 *
 * Plus a store-wide `<episodicDir>/_index.jsonl` carrying one row per
 * session for fast enumeration.
 *
 * Append-only invariant: appendTurn / appendEpisode write a single
 * newline-terminated JSON object via fs.appendFile. They never rewrite
 * existing lines. The one exception is the per-episode denormalised
 * counter update (turn_count, last_turn_id, ended_at) — that requires
 * a single-pass rewrite of episodes.jsonl, which is acceptable because
 * episode count is bounded (typically <100/session) while turn count
 * grows unboundedly.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

import type {
  Episode,
  EpisodicIndexRow,
  EpisodicSession,
  Turn,
} from './types.js'
import { EPISODIC_V2_SCHEMA_VERSION } from './types.js'
import { appendJsonl, forEachJsonl } from '../lib/jsonl.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('episodic-v2')

export interface EpisodicLayerV2Options {
  /** Same dir the v1 EpisodicLayer uses for memory/. Sessions live in subdirs. */
  episodicDir: string
}

export class EpisodicLayerV2 {
  private readonly episodicDir: string

  constructor(opts: EpisodicLayerV2Options) {
    this.episodicDir = resolve(opts.episodicDir)
  }

  // ─── path helpers ──────────────────────────────────────────────────────

  private sessionDir(sessionId: string): string {
    return join(this.episodicDir, sessionId)
  }
  private sessionFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'session.json')
  }
  private episodesFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'episodes.jsonl')
  }
  private turnsFile(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'turns.jsonl')
  }
  private indexFile(): string {
    return join(this.episodicDir, '_index.jsonl')
  }

  // ─── session ──────────────────────────────────────────────────────────

  /**
   * Write or overwrite the session.json header. Used at session start
   * (before turns flow) and at finalise. Refuses to write a session
   * without `schema_version` set.
   */
  async writeSession(session: EpisodicSession): Promise<void> {
    if (!session.schema_version) {
      throw new Error('writeSession: schema_version is required (use EPISODIC_V2_SCHEMA_VERSION)')
    }
    await mkdir(this.sessionDir(session.session_id), { recursive: true })
    await writeFile(this.sessionFile(session.session_id), JSON.stringify(session, null, 2) + '\n', 'utf8')
  }

  /**
   * Read the session header. Returns null if the session.json file
   * doesn't exist or doesn't carry a v2 schema_version.
   */
  async readSession(sessionId: string): Promise<EpisodicSession | null> {
    let text: string
    try {
      text = await readFile(this.sessionFile(sessionId), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const candidate = parsed as Partial<EpisodicSession>
    if (typeof candidate.schema_version !== 'string') return null
    if (!candidate.schema_version.startsWith('2.')) return null
    return candidate as EpisodicSession
  }

  /**
   * Patch the session header (used by finaliseSession to set
   * ended_at, summary, outcomes, tags). Reads current, applies patch,
   * rewrites session.json. Updates _index.jsonl idempotently.
   */
  async finaliseSession(sessionId: string, patch: Partial<EpisodicSession>): Promise<EpisodicSession> {
    const current = await this.readSession(sessionId)
    if (!current) throw new Error(`finaliseSession: no v2 session at ${sessionId}`)
    const next: EpisodicSession = { ...current, ...patch }
    await this.writeSession(next)

    // Update _index.jsonl idempotently
    const episodes = await this.listEpisodes(sessionId)
    const turnTotal = episodes.reduce((s, e) => s + e.turn_count, 0)
    const indexRow: EpisodicIndexRow = {
      session_id: sessionId,
      schema_version: next.schema_version,
      started_at: next.started_at,
      ...(next.ended_at !== undefined ? { ended_at: next.ended_at } : {}),
      episode_count: episodes.length,
      turn_count: turnTotal,
      ...(next.summary ? { summary: next.summary } : {}),
    }
    await this.upsertIndexRow(indexRow)
    log.info('episodic v2 session finalised', {
      session_id: sessionId,
      episodes: episodes.length,
      turns: turnTotal,
    })
    return next
  }

  // ─── episodes ─────────────────────────────────────────────────────────

  async appendEpisode(
    sessionId: string,
    episode: Omit<Episode, 'episode_id' | 'turn_count'> & {
      episode_id?: string
      turn_count?: number
    },
  ): Promise<Episode> {
    await mkdir(this.sessionDir(sessionId), { recursive: true })
    const record: Episode = {
      episode_id: episode.episode_id ?? `E-${randomUUID().slice(0, 8)}`,
      turn_count: episode.turn_count ?? 0,
      episode_type: episode.episode_type,
      ...(episode.episode_tag ? { episode_tag: episode.episode_tag } : {}),
      ...(episode.situation_context ? { situation_context: episode.situation_context } : {}),
      ...(episode.crosslinks ? { crosslinks: episode.crosslinks } : {}),
      ...(episode.first_turn_id ? { first_turn_id: episode.first_turn_id } : {}),
      ...(episode.last_turn_id ? { last_turn_id: episode.last_turn_id } : {}),
      ...(episode.started_at ? { started_at: episode.started_at } : {}),
      ...(episode.ended_at ? { ended_at: episode.ended_at } : {}),
      ...(episode.provenance ? { provenance: episode.provenance } : {}),
    }
    await appendJsonl(this.episodesFile(sessionId), record)
    return record
  }

  async listEpisodes(sessionId: string): Promise<Episode[]> {
    const out: Episode[] = []
    try {
      await forEachJsonl<Episode>(this.episodesFile(sessionId), (row) => {
        out.push(row)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    // De-dup by episode_id, keep last write (rewrite path above).
    const byId = new Map<string, Episode>()
    for (const ep of out) byId.set(ep.episode_id, ep)
    return [...byId.values()]
  }

  // ─── turns ────────────────────────────────────────────────────────────

  /**
   * Append a turn (true append-only — single fs.appendFile call).
   * Auto-generates `turn_id` if not supplied; default `t` is now.
   *
   * Updates the matching Episode's denormalised counts via a single
   * pass rewrite of episodes.jsonl (acceptable because episode count
   * stays small).
   */
  async appendTurn(
    sessionId: string,
    turn: Omit<Turn, 'turn_id' | 't'> & { turn_id?: string; t?: string },
  ): Promise<Turn> {
    await mkdir(this.sessionDir(sessionId), { recursive: true })
    const record: Turn = {
      turn_id: turn.turn_id ?? `T-${randomUUID().slice(0, 8)}`,
      episode_id: turn.episode_id,
      t: turn.t ?? new Date().toISOString(),
      speaker: turn.speaker,
      ...(turn.raw_text !== undefined ? { raw_text: turn.raw_text } : {}),
      ...(turn.text_excerpt !== undefined ? { text_excerpt: turn.text_excerpt } : {}),
      ...(turn.summary !== undefined ? { summary: turn.summary } : {}),
      ...(turn.epistemic_mode ? { epistemic_mode: turn.epistemic_mode } : {}),
      ...(turn.semantic_frames ? { semantic_frames: turn.semantic_frames } : {}),
      ...(turn.salience_anchor ? { salience_anchor: turn.salience_anchor } : {}),
      ...(turn.action ? { action: turn.action } : {}),
      ...(turn.crosslinks ? { crosslinks: turn.crosslinks } : {}),
    }
    await appendJsonl(this.turnsFile(sessionId), record)

    // Update the parent episode's denormalised counts. Read all,
    // bump matching, rewrite. Bounded by episode count.
    await this.bumpEpisodeCounts(sessionId, record)
    return record
  }

  async listTurns(sessionId: string, episodeId?: string): Promise<Turn[]> {
    const out: Turn[] = []
    try {
      await forEachJsonl<Turn>(this.turnsFile(sessionId), (row) => {
        if (episodeId === undefined || row.episode_id === episodeId) out.push(row)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return out
  }

  private async bumpEpisodeCounts(sessionId: string, turn: Turn): Promise<void> {
    const episodes = await this.listEpisodes(sessionId)
    const idx = episodes.findIndex((e) => e.episode_id === turn.episode_id)
    if (idx === -1) {
      // No matching episode — skip silently. Caller is expected to
      // appendEpisode before appendTurn for any episode it expects to
      // see counts on.
      return
    }
    const ep = episodes[idx]!
    const updated: Episode = {
      ...ep,
      turn_count: ep.turn_count + 1,
      ...(ep.first_turn_id ? {} : { first_turn_id: turn.turn_id }),
      last_turn_id: turn.turn_id,
      ...(ep.started_at ? {} : { started_at: turn.t }),
      ended_at: turn.t,
    }
    episodes[idx] = updated
    await this.rewriteEpisodes(sessionId, episodes)
  }

  private async rewriteEpisodes(sessionId: string, episodes: Episode[]): Promise<void> {
    const lines = episodes.map((e) => JSON.stringify(e)).join('\n')
    await writeFile(this.episodesFile(sessionId), lines + '\n', 'utf8')
  }

  // ─── _index.jsonl ─────────────────────────────────────────────────────

  /**
   * Upsert a row in _index.jsonl by session_id (idempotent — no
   * duplicate session_id rows). Reads all, replaces matching, rewrites.
   */
  private async upsertIndexRow(row: EpisodicIndexRow): Promise<void> {
    await mkdir(this.episodicDir, { recursive: true })
    const path = this.indexFile()
    const all: EpisodicIndexRow[] = []
    try {
      await forEachJsonl<EpisodicIndexRow>(path, (r) => {
        if (r.session_id !== row.session_id) all.push(r)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    all.push(row)
    const text = all.map((r) => JSON.stringify(r)).join('\n')
    await writeFile(path, text + '\n', 'utf8')
  }

  /** Read all _index.jsonl rows (one per session). */
  async listSessions(): Promise<EpisodicIndexRow[]> {
    const out: EpisodicIndexRow[] = []
    try {
      await forEachJsonl<EpisodicIndexRow>(this.indexFile(), (r) => {
        out.push(r)
      })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return out
  }

  /** Returns true iff a v2 session.json exists for this id. */
  async hasV2Session(sessionId: string): Promise<boolean> {
    try {
      const dir = await readdir(this.sessionDir(sessionId))
      return dir.includes('session.json')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }
}

// ─── crosslink validator ──────────────────────────────────────────────────

import { CORE_EPISODIC_PREDICATES } from './types.js'

export interface EpisodicLinkError {
  /** 'episode' | 'turn'. */
  source: 'episode' | 'turn'
  /** episode_id or turn_id. */
  from: string
  /** Predicate key. */
  via: string
  /** Atomic id that didn't resolve. */
  target: string
  /** True iff `via` is in CORE_EPISODIC_PREDICATES. */
  isCore: boolean
}

export interface EpisodicValidateResult {
  ok: boolean
  errors: EpisodicLinkError[]
  /** Unknown-predicate edges that resolve fine — surfaced as warnings only. */
  unknownPredicateWarnings: EpisodicLinkError[]
}

/**
 * Validate episode + turn crosslinks against an atom id index.
 *
 * - Core predicates (CORE_EPISODIC_PREDICATES): every target must
 *   resolve in `atomIds`. Misses go to `errors` (treated as failures).
 * - Non-core predicates: targets are still checked; misses go to
 *   `unknownPredicateWarnings` (informational, NOT failures).
 *
 * Caller decides whether to gate CI on warnings.
 */
export function validateEpisodicCrosslinks(
  episodes: Episode[],
  turns: Turn[],
  atomIds: Set<string>,
): EpisodicValidateResult {
  const errors: EpisodicLinkError[] = []
  const warnings: EpisodicLinkError[] = []
  const coreSet = new Set<string>(CORE_EPISODIC_PREDICATES)

  function check(source: 'episode' | 'turn', from: string, crosslinks: Record<string, string[]> | undefined) {
    if (!crosslinks) return
    for (const [via, targets] of Object.entries(crosslinks)) {
      if (!Array.isArray(targets)) continue
      const isCore = coreSet.has(via)
      for (const target of targets) {
        if (typeof target !== 'string' || target.length === 0) continue
        if (atomIds.has(target)) continue
        const err: EpisodicLinkError = { source, from, via, target, isCore }
        if (isCore) errors.push(err)
        else warnings.push(err)
      }
    }
  }

  for (const e of episodes) check('episode', e.episode_id, e.crosslinks)
  for (const t of turns) check('turn', t.turn_id, t.crosslinks)

  return { ok: errors.length === 0, errors, unknownPredicateWarnings: warnings }
}

/** Convenience: create a v2-formatted session header object. */
export function newEpisodicSession(args: {
  session_id: string
  system?: string
  user_id?: string
  instance_id?: string
  started_at?: string
  namespace?: EpisodicSession['namespace']
}): EpisodicSession {
  return {
    schema_version: EPISODIC_V2_SCHEMA_VERSION,
    system: args.system ?? 'gks-v3',
    session_id: args.session_id,
    started_at: args.started_at ?? new Date().toISOString(),
    ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
    ...(args.instance_id !== undefined ? { instance_id: args.instance_id } : {}),
    ...(args.namespace ? { namespace: args.namespace } : {}),
  }
}

// ─── reverse lookup (BLUEPRINT--REVERSE-EPISODIC-LOOKUP) ───────────────

export interface EpisodeRef {
  session_id: string
  episode_id: string
  predicates: string[]
  episode_type: Episode['episode_type']
  episode_tag?: string[]
}

export interface TurnRef {
  session_id: string
  episode_id: string
  turn_id: string
  predicates: string[]
  speaker: string
  /** ISO-8601 turn timestamp; used for chronological sort of `turns[]`. */
  t: string
}

export interface LookupByAtomResult {
  atomId: string
  /** Sorted by (session_id asc, episode_id asc). */
  episodes: EpisodeRef[]
  /** Sorted by `t` ascending (chronological). */
  turns: TurnRef[]
  scanned: { sessions: number; episodes: number; turns: number }
}

/**
 * Options for the public {@link MemoryStore.lookupByAtom} API
 * (BLUEPRINT--NAMESPACED-EPISODIC-LOOKUP).
 */
export interface LookupByAtomOptions {
  /** Restrict to specific crosslink predicates. Default = any. */
  predicates?: string[]
  /**
   * Namespace filter. Defaults to `MemoryStore.defaultNamespace` —
   * sessions with a different namespace are excluded. Mirrors the
   * `RetrievalOptions.namespace` contract.
   */
  namespace?: import('./types.js').Namespace
  /**
   * Bypass the namespace filter — return refs across every namespace.
   * Use for admin / migration paths only.
   */
  crossNamespace?: boolean
}

/**
 * Match the convention from {@link namespaceAsFilter}: a session
 * passes when every key set on `filterNs` matches the session's
 * stored namespace value. Missing fields on either side are
 * wildcards. An empty filter (`{}`) admits every session.
 *
 * Sessions written before EPISODIC-V2 may lack the `namespace`
 * field entirely; they're treated as the empty namespace `{}` —
 * included under empty filters, excluded under non-empty ones.
 */
export function matchesNamespace(
  sessionNs: import('./types.js').Namespace | undefined,
  filterNs: import('./types.js').Namespace,
): boolean {
  const setKeys = (Object.keys(filterNs) as Array<keyof import('./types.js').Namespace>).filter(
    (k) => filterNs[k] !== undefined,
  )
  if (setKeys.length === 0) return true
  if (!sessionNs) return false
  for (const k of setKeys) {
    if (sessionNs[k] !== filterNs[k]) return false
  }
  return true
}

/**
 * Live scan over every v2 episodic session in a layer for entries
 * whose typed crosslinks reference `atomId`. Returns a unified
 * `LookupByAtomResult` per BLUEPRINT--REVERSE-EPISODIC-LOOKUP.
 *
 * Linear in (sessions × turns); fine for small/medium installations.
 * For large stores, layer a persisted reverse index on top.
 */
export async function scanEpisodicForAtom(
  layer: EpisodicLayerV2,
  atomId: string,
  opts: { predicates?: string[] } = {},
): Promise<LookupByAtomResult> {
  const filter = opts.predicates && opts.predicates.length > 0 ? new Set(opts.predicates) : null
  const sessions = await layer.listSessions()
  const counts = { sessions: sessions.length, episodes: 0, turns: 0 }
  const episodes: EpisodeRef[] = []
  const turns: TurnRef[] = []

  for (const s of sessions) {
    const eps = await layer.listEpisodes(s.session_id)
    counts.episodes += eps.length
    for (const ep of eps) {
      const preds = matchedPredicates(ep.crosslinks, atomId, filter)
      if (preds.length === 0) continue
      const ref: EpisodeRef = {
        session_id: s.session_id,
        episode_id: ep.episode_id,
        predicates: preds,
        episode_type: ep.episode_type,
        ...(ep.episode_tag ? { episode_tag: ep.episode_tag } : {}),
      }
      episodes.push(ref)
    }

    const sessionTurns = await layer.listTurns(s.session_id)
    counts.turns += sessionTurns.length
    for (const turn of sessionTurns) {
      const preds = matchedPredicates(turn.crosslinks, atomId, filter)
      if (preds.length === 0) continue
      turns.push({
        session_id: s.session_id,
        episode_id: turn.episode_id,
        turn_id: turn.turn_id,
        predicates: preds,
        speaker: turn.speaker,
        t: turn.t,
      })
    }
  }

  episodes.sort(
    (a, b) =>
      a.session_id.localeCompare(b.session_id) || a.episode_id.localeCompare(b.episode_id),
  )
  turns.sort((a, b) => a.t.localeCompare(b.t))

  return { atomId, episodes, turns, scanned: counts }
}

function matchedPredicates(
  crosslinks: Record<string, string[]> | undefined,
  atomId: string,
  filter: Set<string> | null,
): string[] {
  if (!crosslinks) return []
  const matches: string[] = []
  for (const [pred, targets] of Object.entries(crosslinks)) {
    if (filter && !filter.has(pred)) continue
    if (!Array.isArray(targets)) continue
    if (!targets.includes(atomId)) continue
    if (!matches.includes(pred)) matches.push(pred)
  }
  return matches
}
