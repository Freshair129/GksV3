/**
 * Persisted reverse atom→episode/turn index for v2 episodic store.
 *
 * Implements BLUEPRINT--EPISODIC-ATOM-INDEX. JSONL file at
 * `<episodicDir>/_atom_refs.jsonl`, one row per (atom, predicate,
 * source) tuple. Self-builds at appendTurn / appendEpisode time;
 * `gks episodic reindex` rebuilds from source-of-truth files.
 *
 * The index is a HINT. The on-disk session.json + episodes.jsonl +
 * turns.jsonl files remain authoritative — `lookupByAtom` re-verifies
 * each ref before returning so a stale index doesn't yield false hits.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { appendJsonl, forEachJsonl } from '../lib/jsonl.js'
import type { Episode, Turn } from './types.js'
import type { EpisodicLayerV2 } from './episodic-v2.js'

const REFS_FILENAME = '_atom_refs.jsonl'

export interface AtomRef {
  atom_id: string
  session_id: string
  episode_id: string
  /** Omit for episode-level refs. */
  turn_id?: string
  predicate: string
  /** Turn timestamp for turn refs; episode timestamp / now for episode refs. */
  t: string
}

function refsPath(episodicDir: string): string {
  return join(resolve(episodicDir), REFS_FILENAME)
}

/**
 * Append one or more refs to `_atom_refs.jsonl`. Creates the file
 * (and parent dir) on first write. Strict append-only — sequential
 * calls never rewrite existing lines.
 */
export async function appendIndexRefs(episodicDir: string, refs: AtomRef[]): Promise<void> {
  if (refs.length === 0) return
  await mkdir(resolve(episodicDir), { recursive: true })
  const path = refsPath(episodicDir)
  for (const ref of refs) {
    await appendJsonl(path, ref)
  }
}

/**
 * Read refs matching `atomId` from the index. Returns:
 *   - `AtomRef[]` (possibly empty) when the index file exists.
 *   - `null` when the file doesn't exist (caller falls back to live scan).
 *
 * Optional predicate filter narrows further.
 */
export async function loadIndexForAtom(
  episodicDir: string,
  atomId: string,
  opts: { predicates?: string[] } = {},
): Promise<AtomRef[] | null> {
  const path = refsPath(episodicDir)
  const filter = opts.predicates && opts.predicates.length > 0 ? new Set(opts.predicates) : null
  const out: AtomRef[] = []
  try {
    await forEachJsonl<AtomRef>(path, (row) => {
      if (!row || row.atom_id !== atomId) return
      if (filter && !filter.has(row.predicate)) return
      out.push(row)
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return out
}

/** Walk one Episode's crosslinks → AtomRef[]. */
export function expandEpisodeCrosslinks(sessionId: string, episode: Episode): AtomRef[] {
  if (!episode.crosslinks) return []
  const out: AtomRef[] = []
  const t = episode.started_at ?? episode.ended_at ?? new Date().toISOString()
  for (const [predicate, targets] of Object.entries(episode.crosslinks)) {
    if (!Array.isArray(targets)) continue
    for (const atom_id of targets) {
      if (typeof atom_id !== 'string' || atom_id.length === 0) continue
      out.push({ atom_id, session_id: sessionId, episode_id: episode.episode_id, predicate, t })
    }
  }
  return out
}

/** Walk one Turn's crosslinks → AtomRef[]. */
export function expandTurnCrosslinks(sessionId: string, turn: Turn): AtomRef[] {
  if (!turn.crosslinks) return []
  const out: AtomRef[] = []
  for (const [predicate, targets] of Object.entries(turn.crosslinks)) {
    if (!Array.isArray(targets)) continue
    for (const atom_id of targets) {
      if (typeof atom_id !== 'string' || atom_id.length === 0) continue
      out.push({
        atom_id,
        session_id: sessionId,
        episode_id: turn.episode_id,
        turn_id: turn.turn_id,
        predicate,
        t: turn.t,
      })
    }
  }
  return out
}

/**
 * Rebuild `_atom_refs.jsonl` from scratch by walking every session.
 * Atomic via write-tmp + rename. Returns `{ refs, sessions }` counts.
 */
export async function reindexEpisodicAtoms(
  layer: EpisodicLayerV2,
): Promise<{ refs: number; sessions: number }> {
  // EpisodicLayerV2 doesn't expose its dir directly; the helper takes it
  // from the layer's `_index.jsonl` location via the same `episodicDir`
  // used elsewhere. We use a small accessor that returns the dir.
  const dir = (layer as unknown as { episodicDir: string }).episodicDir
  if (!dir) throw new Error('reindexEpisodicAtoms: layer has no episodicDir field')

  const sessions = await layer.listSessions()
  let totalRefs = 0
  const lines: string[] = []
  for (const s of sessions) {
    const eps = await layer.listEpisodes(s.session_id)
    for (const ep of eps) {
      const refs = expandEpisodeCrosslinks(s.session_id, ep)
      for (const r of refs) lines.push(JSON.stringify(r))
      totalRefs += refs.length
    }
    const turns = await layer.listTurns(s.session_id)
    for (const t of turns) {
      const refs = expandTurnCrosslinks(s.session_id, t)
      for (const r of refs) lines.push(JSON.stringify(r))
      totalRefs += refs.length
    }
  }

  const target = refsPath(dir)
  const tmp = `${target}.tmp`
  await mkdir(resolve(dir), { recursive: true })
  await writeFile(tmp, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8')
  await rename(tmp, target)

  return { refs: totalRefs, sessions: sessions.length }
}

/** Read whatever is on disk at the index file (debug/test helper). */
export async function readAllRefs(episodicDir: string): Promise<AtomRef[]> {
  const path = refsPath(episodicDir)
  const out: AtomRef[] = []
  try {
    const text = await readFile(path, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as AtomRef)
      } catch {
        /* skip malformed lines */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return out
}

export const ATOM_REFS_FILENAME = REFS_FILENAME
