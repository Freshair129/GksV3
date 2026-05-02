/**
 * Tests for the persisted episodic atom-refs index
 * (BLUEPRINT--EPISODIC-ATOM-INDEX, V1-V7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendIndexRefs,
  expandTurnCrosslinks,
  loadIndexForAtom,
  readAllRefs,
  reindexEpisodicAtoms,
  ATOM_REFS_FILENAME,
} from '../../src/memory/episodic-atom-index.js'
import {
  EpisodicLayerV2,
  newEpisodicSession,
  scanEpisodicForAtom,
} from '../../src/memory/episodic-v2.js'

async function withLayer(): Promise<{ layer: EpisodicLayerV2; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gks-atom-idx-'))
  return { layer: new EpisodicLayerV2({ episodicDir: dir }), dir }
}

describe('episodic-atom-index — V1-V7', () => {
  let dir = ''
  let layer: EpisodicLayerV2

  beforeEach(async () => {
    const created = await withLayer()
    layer = created.layer
    dir = created.dir
  })

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('V1: index self-builds on appendTurn (one ref per (predicate, target))', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S1' }))
    await layer.appendEpisode('S1', { episode_id: 'E1', episode_type: 'interaction' })
    await layer.appendTurn('S1', {
      episode_id: 'E1',
      speaker: 'user',
      crosslinks: { discusses: ['FEAT--X'], implements: ['FEAT--X', 'FEAT--Y'] },
    })

    const refs = await readAllRefs(dir)
    // 3 refs: discusses→X, implements→X, implements→Y
    expect(refs).toHaveLength(3)
    const names = refs.map((r) => `${r.predicate}:${r.atom_id}`).sort()
    expect(names).toEqual(['discusses:FEAT--X', 'implements:FEAT--X', 'implements:FEAT--Y'])
  })

  it('V2: loadIndexForAtom filters by atom_id', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S2' }))
    await layer.appendEpisode('S2', { episode_id: 'E1', episode_type: 'interaction' })
    await layer.appendTurn('S2', {
      episode_id: 'E1',
      speaker: 'user',
      crosslinks: { discusses: ['FEAT--A', 'FEAT--B'] },
    })
    const a = await loadIndexForAtom(dir, 'FEAT--A')
    const b = await loadIndexForAtom(dir, 'FEAT--B')
    const z = await loadIndexForAtom(dir, 'FEAT--Z')
    expect(a).not.toBeNull()
    expect(a!.map((r) => r.atom_id)).toEqual(['FEAT--A'])
    expect(b!.map((r) => r.atom_id)).toEqual(['FEAT--B'])
    expect(z!).toEqual([])
  })

  it('V3: loadIndexForAtom filters by predicate', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S3' }))
    await layer.appendEpisode('S3', { episode_id: 'E1', episode_type: 'interaction' })
    await layer.appendTurn('S3', {
      episode_id: 'E1',
      speaker: 'user',
      crosslinks: { discusses: ['FEAT--X'], implements: ['FEAT--X'] },
    })
    const all = await loadIndexForAtom(dir, 'FEAT--X')
    const onlyImpl = await loadIndexForAtom(dir, 'FEAT--X', { predicates: ['implements'] })
    expect(all).toHaveLength(2)
    expect(onlyImpl).toHaveLength(1)
    expect(onlyImpl![0]!.predicate).toBe('implements')
  })

  it('V4: no index file → loadIndexForAtom returns null + lookup falls back to live scan', async () => {
    // Fresh dir, nothing written yet → no _atom_refs.jsonl.
    const result = await loadIndexForAtom(dir, 'FEAT--ANY')
    expect(result).toBeNull()
    // scanEpisodicForAtom should still work (returns empty since no sessions).
    const scan = await scanEpisodicForAtom(layer, 'FEAT--ANY')
    expect(scan.episodes).toEqual([])
    expect(scan.turns).toEqual([])
  })

  it('V5: reindexEpisodicAtoms rebuilds from source files', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S5' }))
    await layer.appendEpisode('S5', {
      episode_id: 'E1',
      episode_type: 'interaction',
      crosslinks: { discusses: ['FEAT--RE'] },
    })
    await layer.appendTurn('S5', {
      episode_id: 'E1',
      speaker: 'user',
      crosslinks: { references: ['FEAT--RE'] },
    })
    // Finalise so listSessions() (via _index.jsonl) sees the session.
    await layer.finaliseSession('S5', { ended_at: '2026-05-01T11:00:00Z' })

    // Snapshot the index file then delete it.
    const path = join(dir, ATOM_REFS_FILENAME)
    const before = await readAllRefs(dir)
    expect(before).toHaveLength(2)
    await rm(path)
    expect(await loadIndexForAtom(dir, 'FEAT--RE')).toBeNull()

    // Rebuild.
    const result = await reindexEpisodicAtoms(layer)
    expect(result.sessions).toBe(1)
    expect(result.refs).toBe(2)
    const after = await readAllRefs(dir)
    expect(after.length).toBe(before.length)
    // Compare normalised sets
    const norm = (rs: typeof before) =>
      rs
        .map((r) => `${r.atom_id}|${r.session_id}|${r.episode_id}|${r.turn_id ?? ''}|${r.predicate}`)
        .sort()
    expect(norm(after)).toEqual(norm(before))
  })

  it('V6: lookupByAtom uses the index — same result as live scan baseline', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S6' }))
    await layer.appendEpisode('S6', { episode_id: 'E1', episode_type: 'interaction' })
    await layer.appendTurn('S6', {
      episode_id: 'E1',
      speaker: 'user',
      crosslinks: { discusses: ['FEAT--SAME'] },
    })
    await layer.finaliseSession('S6', { ended_at: '2026-05-01T11:00:00Z' })

    // With index present (default after appendTurn) — should hit indexed scan.
    const indexed = await scanEpisodicForAtom(layer, 'FEAT--SAME')
    expect(indexed.turns).toHaveLength(1)
    expect(indexed.turns[0]!.predicates).toEqual(['discusses'])

    // Drop the index and re-run live-scan path.
    await rm(join(dir, ATOM_REFS_FILENAME))
    const live = await scanEpisodicForAtom(layer, 'FEAT--SAME')
    expect(live.turns.map((t) => t.turn_id)).toEqual(indexed.turns.map((t) => t.turn_id))
    expect(live.turns[0]!.predicates).toEqual(['discusses'])
  })

  it('V7: appendIndexRefs is true append-only — sequential calls grow the file', async () => {
    const ref = (atom: string, ts: string) => ({
      atom_id: atom,
      session_id: 'S',
      episode_id: 'E',
      turn_id: 'T',
      predicate: 'discusses',
      t: ts,
    })
    const path = join(dir, ATOM_REFS_FILENAME)
    await appendIndexRefs(dir, [ref('FEAT--A', '2026-05-01T10:00:00Z')])
    const before = await readFile(path, 'utf8')
    const beforeStat = await stat(path)
    await appendIndexRefs(dir, [ref('FEAT--B', '2026-05-01T10:01:00Z')])
    const after = await readFile(path, 'utf8')
    const afterStat = await stat(path)
    // Original prefix preserved.
    expect(after.startsWith(before)).toBe(true)
    expect(afterStat.size).toBeGreaterThan(beforeStat.size)
    expect(after.split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('appendEpisode with crosslinks also writes refs', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S-EP' }))
    await layer.appendEpisode('S-EP', {
      episode_id: 'EP1',
      episode_type: 'interaction',
      crosslinks: { references: ['FEAT--EP'] },
    })
    const refs = await loadIndexForAtom(dir, 'FEAT--EP')
    expect(refs).toHaveLength(1)
    expect(refs![0]!.episode_id).toBe('EP1')
    expect(refs![0]!.turn_id).toBeUndefined()
  })

  it('expandTurnCrosslinks handles missing crosslinks gracefully', () => {
    const refs = expandTurnCrosslinks('S', {
      turn_id: 'T',
      episode_id: 'E',
      t: 'now',
      speaker: 'user',
    })
    expect(refs).toEqual([])
  })

  it('verifies stale entries are dropped on lookup', async () => {
    // Manually write a stale ref pointing at a turn that doesn't exist.
    await layer.writeSession(newEpisodicSession({ session_id: 'S-STALE' }))
    await layer.appendEpisode('S-STALE', { episode_id: 'E1', episode_type: 'interaction' })
    // Append fake ref directly.
    const fakePath = join(dir, ATOM_REFS_FILENAME)
    await writeFile(
      fakePath,
      JSON.stringify({
        atom_id: 'FEAT--GHOST',
        session_id: 'S-STALE',
        episode_id: 'E1',
        turn_id: 'T-NEVER-EXISTED',
        predicate: 'discusses',
        t: '2026-05-01T10:00:00Z',
      }) + '\n',
      'utf8',
    )
    const result = await scanEpisodicForAtom(layer, 'FEAT--GHOST')
    // Stale ref is dropped after re-verification.
    expect(result.turns).toHaveLength(0)
  })
})
