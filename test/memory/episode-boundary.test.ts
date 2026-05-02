/**
 * Tests for detectEpisodeBoundaries + endSession integration
 * (BLUEPRINT--EPISODE-BOUNDARY, V1-V7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  detectEpisodeBoundaries,
  type EpisodeBoundaryDetector,
  type EpisodeSegment,
} from '../../src/memory/episode-boundary.js'
import type { TraceStep } from '../../src/memory/types.js'
import type { Embedder } from '../../src/memory/vector/embedder.js'
import { MemoryStore, mockEmbedder } from '../../src/memory/index.js'
import { startSession, endSession } from '../../src/memory/index.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

function step(t: string, content: string, opts: Partial<TraceStep> = {}): TraceStep {
  return {
    t,
    session_id: 'S',
    kind: 'user',
    content,
    ...opts,
  }
}

describe('detectEpisodeBoundaries — V1-V7', () => {
  it('V1: empty trace returns empty segments', async () => {
    const segs = await detectEpisodeBoundaries([])
    expect(segs).toEqual([])
  })

  it('V1: trace without signals returns one segment spanning the whole trace', async () => {
    const trace = [
      step('2026-05-01T10:00:00Z', 'a'),
      step('2026-05-01T10:00:30Z', 'b', { kind: 'agent' }),
      step('2026-05-01T10:01:00Z', 'c'),
    ]
    const segs = await detectEpisodeBoundaries(trace)
    expect(segs).toHaveLength(1)
    expect(segs[0]!.start_index).toBe(0)
    expect(segs[0]!.end_index).toBe(3)
    expect(segs[0]!.reason).toBe('initial')
  })

  it('V2: time-gap > thresholdMs splits the trace', async () => {
    const trace = [
      step('2026-05-01T10:00:00Z', 'before gap'),
      step('2026-05-01T10:00:30Z', 'still before', { kind: 'agent' }),
      // 15-minute gap →
      step('2026-05-01T10:15:30Z', 'after gap'),
    ]
    const segs = await detectEpisodeBoundaries(trace, {
      timeGap: { thresholdMs: 600_000 },
    })
    expect(segs).toHaveLength(2)
    expect(segs[0]!.end_index).toBe(2)
    expect(segs[1]!.start_index).toBe(2)
    expect(segs[1]!.reason).toBe('time-gap')
    expect(segs[1]!.signals.gapMs).toBeGreaterThan(600_000)
  })

  it('V3: explicit episode_boundary marker splits at that index', async () => {
    const trace = [
      step('2026-05-01T10:00:00Z', 'first'),
      step('2026-05-01T10:00:10Z', 'still first', { kind: 'agent' }),
      step('2026-05-01T10:00:20Z', 'boundary marker', {
        kind: 'system',
        metadata: { episode_boundary: true },
      }),
      step('2026-05-01T10:00:30Z', 'second'),
    ]
    const segs = await detectEpisodeBoundaries(trace)
    expect(segs).toHaveLength(2)
    expect(segs[1]!.start_index).toBe(2)
    expect(segs[1]!.reason).toBe('explicit')
  })

  it('V4: semantic detection only fires when enabled (and uses embedder)', async () => {
    const trace = [
      step('2026-05-01T10:00:00Z', 'topic A'),
      step('2026-05-01T10:00:10Z', 'still A', { kind: 'agent' }),
      step('2026-05-01T10:00:20Z', 'TOPIC SHIFT'),
      step('2026-05-01T10:00:30Z', 'topic B', { kind: 'agent' }),
    ]
    // Stub embedder: returns far-apart vectors at the boundary.
    const stubEmbedder: Embedder = {
      provider: 'mock',
      model: 'stub-boundary-test',
      dimension: 2,
      async embed() {
        return [1, 0]
      },
      async embedBatch(texts) {
        return texts.map((t) => (t.toLowerCase().includes('shift') || t.toLowerCase().includes('b') ? [0, 1] : [1, 0]))
      },
    }

    // Default (semantic OFF) → one segment, no embedder calls.
    const off = await detectEpisodeBoundaries(trace)
    expect(off).toHaveLength(1)

    // semantic ON → splits where vectors diverge.
    const on = await detectEpisodeBoundaries(trace, {
      timeGap: { enabled: false }, // disable other signals to isolate
      explicit: { enabled: false },
      semantic: { enabled: true, embedder: stubEmbedder, similarityFloor: 0.5 },
    })
    expect(on.length).toBeGreaterThan(1)
    const semanticSeg = on.find((s) => s.reason === 'topic-shift')
    expect(semanticSeg).toBeDefined()
    expect(semanticSeg!.signals.cosine).toBeDefined()
  })

  it("V4b: semantic.enabled=true without embedder throws", async () => {
    await expect(
      detectEpisodeBoundaries([step('2026-05-01T10:00:00Z', 'a'), step('2026-05-01T10:00:10Z', 'b')], {
        semantic: { enabled: true },
      }),
    ).rejects.toThrow(/requires semantic\.embedder/)
  })

  it('V5: segments record reason + signals correctly', async () => {
    const trace = [
      step('2026-05-01T10:00:00Z', 'first'),
      // 20-minute gap
      step('2026-05-01T10:20:00Z', 'second'),
    ]
    const segs = await detectEpisodeBoundaries(trace)
    expect(segs[0]!.reason).toBe('initial')
    expect(segs[1]!.reason).toBe('time-gap')
    expect(segs[1]!.signals.gapMs).toBeGreaterThan(0)
  })

  it('V6: pluggable detector — endSession uses the supplied function', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-bd-'))
    try {
      await mkdir(join(root, 'gks'), { recursive: true })
      await cp(FIXTURES, join(root, 'gks'), { recursive: true })
      const store = new MemoryStore({ root, embedder: mockEmbedder(32), reranker: { enabled: false } })
      await store.init()
      const start = await startSession(store)

      // Append a small trace.
      for (let i = 0; i < 4; i++) {
        await store.appendTrace(start.session.id, { kind: 'user', content: `q${i}` })
      }

      let detectorCalled = 0
      const customDetector: EpisodeBoundaryDetector = async (trace) => {
        detectorCalled++
        // Force two segments at midpoint
        const mid = Math.floor(trace.length / 2)
        const segments: EpisodeSegment[] = [
          { start_index: 0, end_index: mid, reason: 'initial', signals: {} },
          { start_index: mid, end_index: trace.length, reason: 'explicit', signals: {} },
        ]
        return segments
      }

      await endSession(store, start.session, {
        episodeBoundary: { detector: customDetector },
      })
      expect(detectorCalled).toBe(1)

      const eps = await store.episodicV2.listEpisodes(start.session.id)
      expect(eps).toHaveLength(2)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('V7: episodeBoundary:false reproduces single-episode behaviour', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-bd-legacy-'))
    try {
      await mkdir(join(root, 'gks'), { recursive: true })
      await cp(FIXTURES, join(root, 'gks'), { recursive: true })
      const store = new MemoryStore({ root, embedder: mockEmbedder(32), reranker: { enabled: false } })
      await store.init()
      const start = await startSession(store)

      // Trace with a HUGE time gap that would normally trigger a split.
      await store.appendTrace(start.session.id, {
        t: '2026-05-01T10:00:00Z',
        kind: 'user',
        content: 'first',
      })
      await store.appendTrace(start.session.id, {
        t: '2026-05-01T11:00:00Z', // 1-hour gap
        kind: 'agent',
        content: 'second',
      })

      await endSession(store, start.session, { episodeBoundary: false })

      const eps = await store.episodicV2.listEpisodes(start.session.id)
      // Legacy mode: one episode despite the 1-hour gap.
      expect(eps).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('endSession + boundary detection (default)', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  async function withStore() {
    const root = await mkdtemp(join(tmpdir(), 'gks-bd-int-'))
    cleanup.push(root)
    await mkdir(join(root, 'gks'), { recursive: true })
    await cp(FIXTURES, join(root, 'gks'), { recursive: true })
    const store = new MemoryStore({ root, embedder: mockEmbedder(32), reranker: { enabled: false } })
    await store.init()
    return store
  }

  it('default detector splits at a 15-minute gap', async () => {
    const store = await withStore()
    const start = await startSession(store)
    await store.appendTrace(start.session.id, {
      t: '2026-05-01T10:00:00Z',
      kind: 'user',
      content: 'before',
    })
    await store.appendTrace(start.session.id, {
      t: '2026-05-01T10:01:00Z',
      kind: 'agent',
      content: 'still before',
    })
    await store.appendTrace(start.session.id, {
      // 20 min later
      t: '2026-05-01T10:21:00Z',
      kind: 'user',
      content: 'after',
    })

    await endSession(store, start.session)

    const eps = await store.episodicV2.listEpisodes(start.session.id)
    expect(eps).toHaveLength(2)
    expect(eps[0]!.episode_id).toBe(`E-${start.session.id}-001`)
    expect(eps[1]!.episode_id).toBe(`E-${start.session.id}-002`)
    // Provenance carries the reason for the second segment.
    const auth = eps[1]!.provenance?.authoritative_fields ?? []
    expect(auth.some((s) => s.includes('episode_reason:time-gap'))).toBe(true)
    expect(auth.some((s) => s.startsWith('gap_ms:'))).toBe(true)
  })
})
