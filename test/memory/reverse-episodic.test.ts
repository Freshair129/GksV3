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

// ─── V1-V7: NAMESPACED-EPISODIC-LOOKUP ─────────────────────────────────

describe('MemoryStore.lookupByAtom — namespace gate (BLUEPRINT--NAMESPACED-EPISODIC-LOOKUP)', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-ns-rev-'))
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  /** Helper: write three sessions, one per tenant + one without ns. */
  async function seed(store: MemoryStore): Promise<void> {
    await store.episodicV2.writeSession(
      newEpisodicSession({ session_id: 'S-A', namespace: { tenant_id: 'A' } }),
    )
    await store.episodicV2.appendEpisode('S-A', {
      episode_id: 'EA',
      episode_type: 'interaction',
      crosslinks: { discusses: ['FEAT--FOO'] },
    })
    await store.episodicV2.finaliseSession('S-A', { ended_at: '2026-05-01T11:00:00Z' })

    await store.episodicV2.writeSession(
      newEpisodicSession({ session_id: 'S-B', namespace: { tenant_id: 'B' } }),
    )
    await store.episodicV2.appendEpisode('S-B', {
      episode_id: 'EB',
      episode_type: 'interaction',
      crosslinks: { discusses: ['FEAT--FOO'] },
    })
    await store.episodicV2.finaliseSession('S-B', { ended_at: '2026-05-01T11:00:00Z' })

    // Session without an explicit namespace (legacy / pre-NS data).
    await store.episodicV2.writeSession(newEpisodicSession({ session_id: 'S-LEGACY' }))
    await store.episodicV2.appendEpisode('S-LEGACY', {
      episode_id: 'EL',
      episode_type: 'interaction',
      crosslinks: { discusses: ['FEAT--FOO'] },
    })
    await store.episodicV2.finaliseSession('S-LEGACY', { ended_at: '2026-05-01T11:00:00Z' })
  }

  it('V1: defaultNamespace tenant_id=A excludes B + legacy', async () => {
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      defaultNamespace: { tenant_id: 'A' },
    })
    await store.init()
    await seed(store)
    const r = await store.lookupByAtom('FEAT--FOO')
    expect(r.episodes.map((e) => e.session_id).sort()).toEqual(['S-A'])
  })

  it('V2: empty defaultNamespace returns every match (single-tenant default)', async () => {
    const store = new MemoryStore({ root, embedder: mockEmbedder(32) })
    await store.init()
    await seed(store)
    const r = await store.lookupByAtom('FEAT--FOO')
    expect(r.episodes.map((e) => e.session_id).sort()).toEqual(['S-A', 'S-B', 'S-LEGACY'])
  })

  it('V3: explicit namespace opt overrides defaultNamespace', async () => {
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      defaultNamespace: { tenant_id: 'A' },
    })
    await store.init()
    await seed(store)
    const r = await store.lookupByAtom('FEAT--FOO', { namespace: { tenant_id: 'B' } })
    expect(r.episodes.map((e) => e.session_id).sort()).toEqual(['S-B'])
  })

  it('V4: crossNamespace=true bypasses the filter', async () => {
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      defaultNamespace: { tenant_id: 'A' },
    })
    await store.init()
    await seed(store)
    const r = await store.lookupByAtom('FEAT--FOO', { crossNamespace: true })
    expect(r.episodes.map((e) => e.session_id).sort()).toEqual(['S-A', 'S-B', 'S-LEGACY'])
  })

  it('V5: legacy session (no namespace) is excluded under non-empty filter, included under empty', async () => {
    const scoped = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      defaultNamespace: { tenant_id: 'A' },
    })
    await scoped.init()
    await seed(scoped)
    const scopedRes = await scoped.lookupByAtom('FEAT--FOO')
    expect(scopedRes.episodes.map((e) => e.session_id)).not.toContain('S-LEGACY')

    // Use the SAME store with crossNamespace to verify legacy is reachable.
    const wide = await scoped.lookupByAtom('FEAT--FOO', { crossNamespace: true })
    expect(wide.episodes.map((e) => e.session_id)).toContain('S-LEGACY')
  })

  it('V6: predicates filter composes with namespace filter', async () => {
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      defaultNamespace: { tenant_id: 'A' },
    })
    await store.init()
    await seed(store)
    // Add another A-namespace episode that uses 'implements' instead.
    await store.episodicV2.writeSession(
      newEpisodicSession({ session_id: 'S-A2', namespace: { tenant_id: 'A' } }),
    )
    await store.episodicV2.appendEpisode('S-A2', {
      episode_id: 'EA2',
      episode_type: 'interaction',
      crosslinks: { implements: ['FEAT--FOO'] },
    })
    await store.episodicV2.finaliseSession('S-A2', { ended_at: '2026-05-01T11:00:00Z' })

    // Default namespace (A) + only 'implements' predicate → S-A2 only.
    const r = await store.lookupByAtom('FEAT--FOO', { predicates: ['implements'] })
    expect(r.episodes.map((e) => e.session_id)).toEqual(['S-A2'])
  })

  it('V7: matchesNamespace helper handles wildcards + missing fields', async () => {
    const { matchesNamespace } = await import('../../src/memory/episodic-v2.js')
    // Empty filter admits everything.
    expect(matchesNamespace({ tenant_id: 'A' }, {})).toBe(true)
    expect(matchesNamespace(undefined, {})).toBe(true)
    // Non-empty filter requires session ns to match.
    expect(matchesNamespace({ tenant_id: 'A' }, { tenant_id: 'A' })).toBe(true)
    expect(matchesNamespace({ tenant_id: 'A' }, { tenant_id: 'B' })).toBe(false)
    expect(matchesNamespace(undefined, { tenant_id: 'A' })).toBe(false)
    // Multi-key filter — all must match.
    expect(
      matchesNamespace({ tenant_id: 'A', user_id: 'u1' }, { tenant_id: 'A', user_id: 'u1' }),
    ).toBe(true)
    expect(
      matchesNamespace({ tenant_id: 'A', user_id: 'u1' }, { tenant_id: 'A', user_id: 'u2' }),
    ).toBe(false)
    // Session has more keys than the filter cares about → still matches.
    expect(
      matchesNamespace({ tenant_id: 'A', user_id: 'u1', agent_id: 'a' }, { tenant_id: 'A' }),
    ).toBe(true)
  })
})
