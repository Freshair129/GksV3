/**
 * Tests for EpisodicLayerV2 (BLUEPRINT--EPISODIC-V2, V1-V7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EpisodicLayerV2,
  newEpisodicSession,
  validateEpisodicCrosslinks,
} from '../../src/memory/episodic-v2.js'
import {
  CORE_EPISODIC_PREDICATES,
  EPISODIC_V2_SCHEMA_VERSION,
} from '../../src/memory/types.js'
import type { Episode, EpisodicSession, Turn } from '../../src/memory/types.js'
import { MemoryStore } from '../../src/memory/index.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'

async function withDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'gks-episodic-v2-'))
}

describe('EpisodicLayerV2 — three-document split', () => {
  let dir = ''

  beforeEach(async () => {
    dir = await withDir()
  })

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('V1: writeSession + appendEpisode + appendTurn round-trip via disk', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    const session: EpisodicSession = newEpisodicSession({
      session_id: 'S-001',
      system: 'gks-v3',
      user_id: 'u',
      started_at: '2026-05-01T10:00:00Z',
    })
    await layer.writeSession(session)

    const ep = await layer.appendEpisode('S-001', {
      episode_type: 'interaction',
      situation_context: { interaction_mode: 'discussion', stakes_level: 'low', time_pressure: 'low' },
    })
    await layer.appendTurn('S-001', { episode_id: ep.episode_id, speaker: 'user', raw_text: 'Hi' })
    await layer.appendTurn('S-001', { episode_id: ep.episode_id, speaker: 'agent', raw_text: 'Hello' })

    const readBack = await layer.readSession('S-001')
    expect(readBack?.session_id).toBe('S-001')
    expect(readBack?.schema_version).toBe(EPISODIC_V2_SCHEMA_VERSION)

    const episodes = await layer.listEpisodes('S-001')
    expect(episodes).toHaveLength(1)
    expect(episodes[0]!.episode_id).toBe(ep.episode_id)
    expect(episodes[0]!.turn_count).toBe(2) // bumped denormalised count

    const turns = await layer.listTurns('S-001', ep.episode_id)
    expect(turns).toHaveLength(2)
    expect(turns[0]!.speaker).toBe('user')
    expect(turns[1]!.speaker).toBe('agent')
  })

  it('V2: turn.episode_id is the FK source of truth', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    await layer.writeSession(newEpisodicSession({ session_id: 'S-002' }))
    const epA = await layer.appendEpisode('S-002', { episode_type: 'interaction', episode_id: 'E-A' })
    const epB = await layer.appendEpisode('S-002', { episode_type: 'observation', episode_id: 'E-B' })
    await layer.appendTurn('S-002', { episode_id: epA.episode_id, speaker: 'user', raw_text: 'A1' })
    await layer.appendTurn('S-002', { episode_id: epB.episode_id, speaker: 'user', raw_text: 'B1' })
    await layer.appendTurn('S-002', { episode_id: epA.episode_id, speaker: 'agent', raw_text: 'A2' })

    const aTurns = await layer.listTurns('S-002', 'E-A')
    const bTurns = await layer.listTurns('S-002', 'E-B')
    expect(aTurns).toHaveLength(2)
    expect(bTurns).toHaveLength(1)
    expect(aTurns.every((t) => t.episode_id === 'E-A')).toBe(true)
    expect(bTurns.every((t) => t.episode_id === 'E-B')).toBe(true)
  })

  it('V3: appendTurn is true append-only (turns.jsonl grows by exactly one line)', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    await layer.writeSession(newEpisodicSession({ session_id: 'S-003' }))
    await layer.appendEpisode('S-003', { episode_type: 'interaction', episode_id: 'E1' })

    const turnsPath = join(dir, 'S-003', 'turns.jsonl')
    await layer.appendTurn('S-003', { episode_id: 'E1', speaker: 'user', raw_text: 'one' })
    const before = await readFile(turnsPath, 'utf8')
    const beforeStat = await stat(turnsPath)

    await layer.appendTurn('S-003', { episode_id: 'E1', speaker: 'agent', raw_text: 'two' })
    const after = await readFile(turnsPath, 'utf8')
    const afterStat = await stat(turnsPath)

    // After file starts with the same prefix as before — original line untouched.
    expect(after.startsWith(before)).toBe(true)
    expect(afterStat.size).toBeGreaterThan(beforeStat.size)
    // Exactly two lines after second append.
    expect(after.split('\n').filter((l) => l.length > 0)).toHaveLength(2)
  })

  it('V4: v1 file coexists with v2 sessions in the same dir without conflict', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    // Drop a v1 markdown for session V1-OLD beside a v2 dir for V2-NEW.
    await writeFile(
      join(dir, 'V1-OLD.md'),
      '---\nid: V1-OLD\nsession_id: V1-OLD\n---\n\n# V1 session\n\nLegacy.\n',
      'utf8',
    )
    await layer.writeSession(newEpisodicSession({ session_id: 'V2-NEW' }))
    await layer.appendEpisode('V2-NEW', { episode_type: 'interaction', episode_id: 'E1' })

    // v2 reader returns V2-NEW
    const v2 = await layer.readSession('V2-NEW')
    expect(v2?.session_id).toBe('V2-NEW')

    // v2 reader does NOT mistake the v1 markdown for a v2 session
    const tryV1 = await layer.readSession('V1-OLD')
    expect(tryV1).toBeNull()

    // hasV2Session reflects layout differences correctly
    expect(await layer.hasV2Session('V2-NEW')).toBe(true)
    expect(await layer.hasV2Session('V1-OLD')).toBe(false)
  })

  it('V5: validateEpisodicCrosslinks errors on core predicates, warns on unknown', async () => {
    const atomIds = new Set(['CONCEPT--A', 'FEAT--B'])
    const episodes: Episode[] = [
      {
        episode_id: 'E1',
        episode_type: 'interaction',
        turn_count: 0,
        crosslinks: {
          discusses: ['CONCEPT--A', 'CONCEPT--MISSING'], // core: 1 ok, 1 broken
          inspired_by: ['FEAT--ALSO-MISSING'],            // unknown predicate, broken
        },
      },
    ]
    const turns: Turn[] = [
      {
        turn_id: 'T1',
        episode_id: 'E1',
        t: '2026-05-01T10:00:00Z',
        speaker: 'user',
        crosslinks: { references: ['FEAT--B'] }, // core, ok
      },
    ]
    const result = validateEpisodicCrosslinks(episodes, turns, atomIds)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.target).toBe('CONCEPT--MISSING')
    expect(result.errors[0]!.via).toBe('discusses')
    expect(result.errors[0]!.isCore).toBe(true)
    expect(result.unknownPredicateWarnings).toHaveLength(1)
    expect(result.unknownPredicateWarnings[0]!.via).toBe('inspired_by')
    expect(result.unknownPredicateWarnings[0]!.isCore).toBe(false)
  })

  it('V6: appendTurn updates denormalised counts on the parent episode', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    await layer.writeSession(newEpisodicSession({ session_id: 'S-006' }))
    await layer.appendEpisode('S-006', { episode_type: 'interaction', episode_id: 'E1' })
    const t1 = await layer.appendTurn('S-006', { episode_id: 'E1', speaker: 'user', raw_text: 'hi' })
    const t2 = await layer.appendTurn('S-006', { episode_id: 'E1', speaker: 'agent', raw_text: 'yo' })
    const eps = await layer.listEpisodes('S-006')
    expect(eps[0]!.turn_count).toBe(2)
    expect(eps[0]!.first_turn_id).toBe(t1.turn_id)
    expect(eps[0]!.last_turn_id).toBe(t2.turn_id)
    expect(eps[0]!.started_at).toBeDefined()
    expect(eps[0]!.ended_at).toBeDefined()
  })

  it('V7: finaliseSession updates _index.jsonl idempotently', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    await layer.writeSession(newEpisodicSession({ session_id: 'S-007' }))
    await layer.appendEpisode('S-007', { episode_type: 'interaction', episode_id: 'E1' })
    await layer.appendTurn('S-007', { episode_id: 'E1', speaker: 'user', raw_text: '...' })

    await layer.finaliseSession('S-007', {
      ended_at: '2026-05-01T11:00:00Z',
      summary: 'first finalise',
    })
    let sessions = await layer.listSessions()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.session_id).toBe('S-007')
    expect(sessions[0]!.episode_count).toBe(1)
    expect(sessions[0]!.turn_count).toBe(1)
    expect(sessions[0]!.summary).toBe('first finalise')

    // Second finalise — must NOT add a duplicate row.
    await layer.finaliseSession('S-007', { summary: 'second finalise' })
    sessions = await layer.listSessions()
    expect(sessions).toHaveLength(1) // still one row
    expect(sessions[0]!.summary).toBe('second finalise')
  })

  it('CORE_EPISODIC_PREDICATES is non-empty and includes the expected basics', () => {
    expect(CORE_EPISODIC_PREDICATES.length).toBeGreaterThan(0)
    expect(CORE_EPISODIC_PREDICATES).toContain('discusses')
    expect(CORE_EPISODIC_PREDICATES).toContain('implements')
    expect(CORE_EPISODIC_PREDICATES).toContain('contradicts')
    expect(CORE_EPISODIC_PREDICATES).toContain('references')
  })

  it('rejects writeSession without schema_version', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    await expect(
      layer.writeSession({
        schema_version: '',
        system: 'gks-v3',
        session_id: 'S-bad',
        started_at: '2026-05-01T10:00:00Z',
      }),
    ).rejects.toThrow(/schema_version is required/)
  })

  it('listEpisodes survives multiple denormalised rewrites without duplicates', async () => {
    const layer = new EpisodicLayerV2({ episodicDir: dir })
    await layer.writeSession(newEpisodicSession({ session_id: 'S-010' }))
    await layer.appendEpisode('S-010', { episode_type: 'interaction', episode_id: 'E1' })
    for (let i = 0; i < 5; i++) {
      await layer.appendTurn('S-010', { episode_id: 'E1', speaker: 'user', raw_text: `${i}` })
    }
    const eps = await layer.listEpisodes('S-010')
    expect(eps).toHaveLength(1)
    expect(eps[0]!.turn_count).toBe(5)
  })
})

describe('MemoryStore.episodicV2 — wiring', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-store-v2-'))
  })

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  it('exposes episodicV2 on the MemoryStore instance', async () => {
    const store = new MemoryStore({ root, embedder: mockEmbedder(64) })
    await store.init()
    expect(store.episodicV2).toBeDefined()
    expect(typeof store.episodicV2.appendTurn).toBe('function')
  })

  it('episodicV2 + episodic (v1) coexist in the same memoryDir', async () => {
    const store = new MemoryStore({ root, embedder: mockEmbedder(64) })
    await store.init()

    // v1 write (existing path).
    await store.writeEpisodic({
      id: 'V1-COEXIST',
      session_id: 'V1-COEXIST',
      started_at: '2026-05-01T10:00:00Z',
      ended_at: '2026-05-01T10:30:00Z',
      duration_min: 30,
      participants: ['user'],
      summary: 'legacy',
    })

    // v2 write alongside.
    await store.episodicV2.writeSession(newEpisodicSession({ session_id: 'V2-COEXIST' }))
    await store.episodicV2.appendEpisode('V2-COEXIST', {
      episode_type: 'interaction',
      episode_id: 'E1',
    })
    await store.episodicV2.appendTurn('V2-COEXIST', {
      episode_id: 'E1',
      speaker: 'user',
      raw_text: 'hi',
    })

    // Both readable through their respective layers.
    const v1Items = await store.episodic.listEpisodic()
    expect(v1Items.some((x) => x.session_id.includes('V1-COEXIST'))).toBe(true)

    const v2 = await store.episodicV2.readSession('V2-COEXIST')
    expect(v2?.session_id).toBe('V2-COEXIST')
  })
})
