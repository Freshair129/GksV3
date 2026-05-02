/**
 * Tests for createLlmBoundaryDetector
 * (BLUEPRINT--LLM-EPISODE-BOUNDARY, V1-V7).
 *
 * No real LLM calls — uses a mock LlmClient throughout.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  createLlmBoundaryDetector,
  parseLlmResponse,
  mergeSegments,
} from '../../src/memory/episode-boundary-llm.js'
import type { LlmClient } from '../../src/memory/consolidator-llm.js'
import type { TraceStep } from '../../src/memory/types.js'
import { MemoryStore, mockEmbedder, startSession, endSession } from '../../src/memory/index.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

function step(t: string, content: string, opts: Partial<TraceStep> = {}): TraceStep {
  return { t, session_id: 'S', kind: 'user', content, ...opts }
}

function fixedClient(reply: string): LlmClient {
  return {
    name: 'mock-fixed',
    async generate() {
      return reply
    },
  }
}

function failingClient(): LlmClient {
  return {
    name: 'mock-fail',
    async generate() {
      throw new Error('upstream timeout')
    },
  }
}

describe('createLlmBoundaryDetector — V1-V7', () => {
  function shortTrace(): TraceStep[] {
    return [
      step('2026-05-01T10:00:00Z', 'turn 0', { kind: 'user' }),
      step('2026-05-01T10:00:10Z', 'turn 1', { kind: 'agent' }),
      step('2026-05-01T10:00:20Z', 'turn 2', { kind: 'user' }),
      step('2026-05-01T10:00:30Z', 'turn 3', { kind: 'agent' }),
      step('2026-05-01T10:00:40Z', 'turn 4', { kind: 'user' }),
    ]
  }

  it('V1: LLM-only — returns LLM boundaries when heuristic is silent', async () => {
    const detector = createLlmBoundaryDetector({
      client: fixedClient(JSON.stringify({ boundaries: [2], reasons: ['topic shift'] })),
      heuristic: { timeGap: { enabled: false }, explicit: { enabled: false } },
    })
    const trace = shortTrace()
    const segs = await detector(trace)
    expect(segs).toHaveLength(2)
    expect(segs[0]!).toMatchObject({ start_index: 0, end_index: 2, reason: 'initial' })
    expect(segs[1]!).toMatchObject({ start_index: 2, end_index: 5, reason: 'topic-shift' })
    expect(segs[1]!.signals.llm_reason).toBe('topic shift')
  })

  it('V2: merge — heuristic time-gap + LLM topic-shift coexist', async () => {
    const detector = createLlmBoundaryDetector({
      client: fixedClient(JSON.stringify({ boundaries: [2], reasons: ['subtle drift'] })),
    })
    const trace: TraceStep[] = [
      step('2026-05-01T10:00:00Z', 'a'),
      step('2026-05-01T10:00:10Z', 'b'),
      step('2026-05-01T10:00:20Z', 'c'),
      step('2026-05-01T10:00:30Z', 'd'),
      // 30-minute gap → heuristic boundary at index 4
      step('2026-05-01T10:30:00Z', 'e'),
    ]
    const segs = await detector(trace)
    // Expect [0,2), [2,4), [4,5)
    expect(segs.map((s) => s.start_index)).toEqual([0, 2, 4])
    const second = segs[1]!
    expect(second.reason).toBe('topic-shift')
    expect(second.signals.llm_reason).toBe('subtle drift')
    const third = segs[2]!
    expect(third.reason).toBe('time-gap')
    expect(third.signals.gapMs).toBeGreaterThan(0)
  })

  it('V3: LLM throws → heuristic-only (no exception)', async () => {
    const detector = createLlmBoundaryDetector({
      client: failingClient(),
      heuristic: { explicit: { enabled: false }, timeGap: { enabled: false } },
    })
    const trace = shortTrace()
    const segs = await detector(trace)
    expect(segs).toHaveLength(1) // initial only — no signals fired
    expect(segs[0]!.reason).toBe('initial')
  })

  it('V4: malformed LLM output → heuristic-only', async () => {
    const detector = createLlmBoundaryDetector({
      client: fixedClient('not even close to json'),
      heuristic: { explicit: { enabled: false }, timeGap: { enabled: false } },
    })
    const segs = await detector(shortTrace())
    expect(segs).toHaveLength(1)
    expect(segs[0]!.reason).toBe('initial')
  })

  it('V5: out-of-range LLM indices are clamped/dropped', () => {
    // Pure-helper test for parseLlmResponse with traceLen=5
    const parsed = parseLlmResponse(
      JSON.stringify({ boundaries: [0, 999, -3, 2, 3], reasons: ['', '', '', 'r2', 'r3'] }),
      5,
    )
    // Valid: 2 and 3 only.
    expect(parsed.map((p) => p.idx)).toEqual([2, 3])
  })

  it('V6: trace longer than maxTurnsInPrompt → LLM not called', async () => {
    let calls = 0
    const client: LlmClient = {
      name: 'count',
      async generate() {
        calls++
        return '{"boundaries":[],"reasons":[]}'
      },
    }
    const detector = createLlmBoundaryDetector({
      client,
      maxTurnsInPrompt: 3,
      heuristic: { explicit: { enabled: false }, timeGap: { enabled: false } },
    })
    const long: TraceStep[] = []
    for (let i = 0; i < 10; i++) long.push(step(`2026-05-01T10:00:${String(i).padStart(2, '0')}Z`, `t${i}`))
    const segs = await detector(long)
    expect(calls).toBe(0) // LLM was NOT called
    expect(segs).toHaveLength(1) // heuristic-only
  })

  it('V7: end-to-end via endSession — Episodes match merged segments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-llm-bd-'))
    try {
      await mkdir(join(root, 'gks'), { recursive: true })
      await cp(FIXTURES, join(root, 'gks'), { recursive: true })
      const store = new MemoryStore({ root, embedder: mockEmbedder(32), reranker: { enabled: false } })
      await store.init()
      const start = await startSession(store)
      // 5 trace steps with no time-gap
      for (let i = 0; i < 5; i++) {
        await store.appendTrace(start.session.id, {
          t: `2026-05-01T10:00:${String(i * 10).padStart(2, '0')}Z`,
          kind: 'user',
          content: `turn ${i}`,
        })
      }
      const detector = createLlmBoundaryDetector({
        client: fixedClient(JSON.stringify({ boundaries: [3], reasons: ['shift to deploy'] })),
      })
      await endSession(store, start.session, { episodeBoundary: { detector } })
      const eps = await store.episodicV2.listEpisodes(start.session.id)
      expect(eps).toHaveLength(2)
      const second = eps[1]!
      expect(second.first_turn_id).toBeDefined()
      // Provenance carries the LLM reason in authoritative_fields.
      const auth = second.provenance?.authoritative_fields ?? []
      expect(auth.some((s) => s.startsWith('episode_reason:topic-shift'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('parseLlmResponse — defensive parsing', () => {
  it('parses fenced JSON block', () => {
    const parsed = parseLlmResponse(
      '```json\n{"boundaries":[2,4],"reasons":["a","b"]}\n```',
      10,
    )
    expect(parsed.map((p) => p.idx)).toEqual([2, 4])
    expect(parsed[0]!.reason).toBe('a')
  })

  it('returns empty for missing fields / wrong shape', () => {
    expect(parseLlmResponse('{}', 5)).toEqual([])
    expect(parseLlmResponse('[1,2,3]', 5)).toEqual([])
    expect(parseLlmResponse('', 5)).toEqual([])
  })

  it('dedupes repeated indices', () => {
    const parsed = parseLlmResponse(
      JSON.stringify({ boundaries: [2, 2, 2], reasons: ['x', 'y', 'z'] }),
      5,
    )
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.idx).toBe(2)
  })

  it('clamps reason to 60 chars', () => {
    const long = 'X'.repeat(120)
    const parsed = parseLlmResponse(JSON.stringify({ boundaries: [2], reasons: [long] }), 5)
    expect(parsed[0]!.reason!.length).toBeLessThanOrEqual(60)
  })
})

describe('mergeSegments helper', () => {
  it('heuristic reason wins on conflict', () => {
    const heur = [
      { start_index: 0, end_index: 5, reason: 'time-gap' as const, signals: { gapMs: 999 } },
    ]
    const merged = mergeSegments(heur, [{ idx: 2, reason: 'topic shift' }], 5)
    // Index 0 stays time-gap; index 2 added as topic-shift.
    expect(merged.map((s) => s.start_index)).toEqual([0, 2])
    expect(merged[0]!.reason).toBe('time-gap')
    expect(merged[1]!.reason).toBe('topic-shift')
  })

  it('LLM-only result includes initial when missing', () => {
    const merged = mergeSegments([], [{ idx: 3 }], 5)
    expect(merged.map((s) => s.start_index)).toEqual([0, 3])
    expect(merged[0]!.reason).toBe('initial')
  })
})
