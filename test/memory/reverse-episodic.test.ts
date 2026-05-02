/**
 * Tests for scanEpisodicForAtom + MemoryStore.lookupByAtom
 * (BLUEPRINT--REVERSE-EPISODIC-LOOKUP, V1-V7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EpisodicLayerV2,
  newEpisodicSession,
  scanEpisodicForAtom,
} from '../../src/memory/episodic-v2.js'
import { MemoryStore } from '../../src/memory/index.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'

async function withLayer(): Promise<{ layer: EpisodicLayerV2; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'gks-rev-ep-'))
  const layer = new EpisodicLayerV2({ episodicDir: dir })
  return { layer, dir }
}

describe('scanEpisodicForAtom — V1-V7', () => {
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

  it('V1: empty store → empty result, no throw', async () => {
    const r = await scanEpisodicForAtom(layer, 'ATOM--ANY')
    expect(r.episodes).toEqual([])
    expect(r.turns).toEqual([])
    expect(r.scanned.sessions).toBe(0)
  })

  it('V2: episode crosslink match', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S1' }))
    await layer.appendEpisode('S1', {
      episode_id: 'E1',
      episode_type: 'interaction',
      crosslinks: { discusses: ['ATOM--X'] },
    })
    await layer.finaliseSession('S1', { ended_at: '2026-05-01T11:00:00Z' })

    const r = await scanEpisodicForAtom(layer, 'ATOM--X')
    expect(r.episodes).toHaveLength(1)
    expect(r.episodes[0]!.episode_id).toBe('E1')
    expect(r.episodes[0]!.predicates).toEqual(['discusses'])
    expect(r.turns).toHaveLength(0)
  })

  it('V3: turn crosslink match', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S2' }))
    await layer.appendEpisode('S2', { episode_id: 'E1', episode_type: 'interaction' })
    await layer.appendTurn('S2', {
      episode_id: 'E1',
      speaker: 'user',
      crosslinks: { implements: ['ATOM--X'] },
    })
    await layer.finaliseSession('S2', { ended_at: '2026-05-01T11:00:00Z' })

    const r = await scanEpisodicForAtom(layer, 'ATOM--X')
    expect(r.turns).toHaveLength(1)
    expect(r.turns[0]!.predicates).toEqual(['implements'])
    expect(r.episodes).toHaveLength(0)
  })

  it('V4: multi-predicate dedupe — single ref with merged predicates', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S3' }))
    await layer.appendEpisode('S3', {
      episode_id: 'E1',
      episode_type: 'interaction',
      crosslinks: {
        discusses: ['ATOM--X'],
        implements: ['ATOM--X'],
      },
    })
    await layer.finaliseSession('S3', { ended_at: '2026-05-01T11:00:00Z' })

    const r = await scanEpisodicForAtom(layer, 'ATOM--X')
    expect(r.episodes).toHaveLength(1) // merged, not duplicated
    expect(r.episodes[0]!.predicates.sort()).toEqual(['discusses', 'implements'])
  })

  it('V5: predicates filter restricts the scan', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S4' }))
    await layer.appendEpisode('S4', {
      episode_id: 'E1',
      episode_type: 'interaction',
      crosslinks: { discusses: ['ATOM--X'], implements: ['ATOM--X'] },
    })
    await layer.appendEpisode('S4', {
      episode_id: 'E2',
      episode_type: 'interaction',
      crosslinks: { discusses: ['ATOM--X'] },
    })
    await layer.finaliseSession('S4', { ended_at: '2026-05-01T11:00:00Z' })

    const all = await scanEpisodicForAtom(layer, 'ATOM--X')
    expect(all.episodes).toHaveLength(2)

    const onlyImpl = await scanEpisodicForAtom(layer, 'ATOM--X', { predicates: ['implements'] })
    expect(onlyImpl.episodes).toHaveLength(1)
    expect(onlyImpl.episodes[0]!.episode_id).toBe('E1')
    expect(onlyImpl.episodes[0]!.predicates).toEqual(['implements'])
  })

  it('V6: cross-session merge with chronological turn ordering', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S-A', started_at: '2026-05-01T09:00:00Z' }))
    await layer.appendEpisode('S-A', { episode_id: 'EA', episode_type: 'interaction' })
    await layer.appendTurn('S-A', {
      episode_id: 'EA',
      speaker: 'user',
      t: '2026-05-01T09:30:00Z',
      crosslinks: { discusses: ['ATOM--X'] },
    })
    await layer.finaliseSession('S-A', { ended_at: '2026-05-01T10:00:00Z' })

    await layer.writeSession(newEpisodicSession({ session_id: 'S-B', started_at: '2026-05-01T08:00:00Z' }))
    await layer.appendEpisode('S-B', { episode_id: 'EB', episode_type: 'interaction' })
    await layer.appendTurn('S-B', {
      episode_id: 'EB',
      speaker: 'agent',
      t: '2026-05-01T08:15:00Z',
      crosslinks: { discusses: ['ATOM--X'] },
    })
    await layer.finaliseSession('S-B', { ended_at: '2026-05-01T08:30:00Z' })

    const r = await scanEpisodicForAtom(layer, 'ATOM--X')
    expect(r.turns).toHaveLength(2)
    // Chronological — earlier session's turn first.
    expect(r.turns[0]!.session_id).toBe('S-B')
    expect(r.turns[1]!.session_id).toBe('S-A')
  })

  it('V7: no match → empty refs, scanned reflects walked counts', async () => {
    await layer.writeSession(newEpisodicSession({ session_id: 'S5' }))
    await layer.appendEpisode('S5', { episode_id: 'E1', episode_type: 'interaction' })
    await layer.appendTurn('S5', { episode_id: 'E1', speaker: 'user', raw_text: 'no crosslinks' })
    await layer.finaliseSession('S5', { ended_at: '2026-05-01T11:00:00Z' })

    const r = await scanEpisodicForAtom(layer, 'ATOM--NEVER-CITED')
    expect(r.episodes).toEqual([])
    expect(r.turns).toEqual([])
    expect(r.scanned.sessions).toBe(1)
    expect(r.scanned.episodes).toBe(1)
    expect(r.scanned.turns).toBe(1)
  })
})

describe('MemoryStore.lookupByAtom', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-store-rev-'))
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('plumbs through to scanEpisodicForAtom', async () => {
    const store = new MemoryStore({ root, embedder: mockEmbedder(32) })
    await store.init()
    await store.episodicV2.writeSession(newEpisodicSession({ session_id: 'S-INT' }))
    await store.episodicV2.appendEpisode('S-INT', {
      episode_id: 'E1',
      episode_type: 'interaction',
      crosslinks: { discusses: ['FEAT--FOO'] },
    })
    await store.episodicV2.finaliseSession('S-INT', { ended_at: '2026-05-01T11:00:00Z' })

    const r = await store.lookupByAtom('FEAT--FOO')
    expect(r.atomId).toBe('FEAT--FOO')
    expect(r.episodes).toHaveLength(1)
    expect(r.episodes[0]!.session_id).toBe('S-INT')
  })
})
