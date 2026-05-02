/**
 * Tests for semantic_frames inferrers
 * (BLUEPRINT--SEMANTIC-FRAMES, V1-V7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  buildPrompt,
  createHeuristicSemanticFramesInferrer,
  createLlmSemanticFramesInferrer,
  parseFramesResponse,
} from '../../src/memory/semantic-frames.js'
import type { LlmClient } from '../../src/memory/consolidator-llm.js'
import type { TraceStep } from '../../src/memory/types.js'
import { MemoryStore, mockEmbedder, startSession, endSession } from '../../src/memory/index.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

function step(t: string, content: string, opts: Partial<TraceStep> = {}): TraceStep {
  return { t, session_id: 'S', kind: 'user', content, ...opts }
}

describe('createHeuristicSemanticFramesInferrer — V1-V2', () => {
  it('V1: question vs request vs statement (kind=user)', async () => {
    const inferrer = createHeuristicSemanticFramesInferrer()
    const trace: TraceStep[] = [
      step('2026-05-01T10:00:00Z', 'What is GKS?', { kind: 'user' }),
      step('2026-05-01T10:00:10Z', 'Please make X', { kind: 'user' }),
      step('2026-05-01T10:00:20Z', 'X is a thing.', { kind: 'user' }),
    ]
    const { frames } = await inferrer(trace)
    expect(frames).toEqual([['question'], ['request'], ['statement']])
  })

  it('V2: tool / system / agent / memory frames', async () => {
    const inferrer = createHeuristicSemanticFramesInferrer()
    const trace: TraceStep[] = [
      step('t1', 'cmd output', { kind: 'tool' }),
      step('t2', 'session start', { kind: 'system' }),
      step('t3', 'plain explanation', { kind: 'agent' }),
      step('t4', '```js\nconst x=1;\n```', { kind: 'agent' }),
      step('t5', 'recalled fact', { kind: 'memory' }),
      step('t6', 'brain summary', { kind: 'brain' }),
    ]
    const { frames } = await inferrer(trace)
    expect(frames[0]).toEqual(['action'])
    expect(frames[1]).toEqual(['system_event'])
    expect(frames[2]).toEqual(['explanation'])
    expect(frames[3]).toEqual(['explanation', 'demonstration'])
    expect(frames[4]).toEqual(['recall'])
    expect(frames[5]).toEqual(['recall'])
  })
})

describe('createLlmSemanticFramesInferrer — V3-V6', () => {
  function fixedClient(reply: string): LlmClient {
    return { name: 'mock', async generate() { return reply } }
  }

  function failingClient(): LlmClient {
    return { name: 'mock-fail', async generate() { throw new Error('boom') } }
  }

  it('V3: LLM-success — frames stamped from JSON response', async () => {
    const reply = JSON.stringify({
      frames: [['question', 'meta'], ['explanation'], ['agreement']],
    })
    const inferrer = createLlmSemanticFramesInferrer({ client: fixedClient(reply) })
    const trace: TraceStep[] = [
      step('t1', 'q?', { kind: 'user' }),
      step('t2', 'a', { kind: 'agent' }),
      step('t3', 'thanks', { kind: 'user' }),
    ]
    const { frames } = await inferrer(trace)
    expect(frames).toEqual([['question', 'meta'], ['explanation'], ['agreement']])
  })

  it('V4: shape mismatch → fallback', async () => {
    // LLM returns 2 entries for a 3-turn trace.
    const reply = JSON.stringify({ frames: [['x'], ['y']] })
    const inferrer = createLlmSemanticFramesInferrer({ client: fixedClient(reply) })
    const trace: TraceStep[] = [
      step('t1', 'q?', { kind: 'user' }),
      step('t2', 'a', { kind: 'agent' }),
      step('t3', 'thanks', { kind: 'user' }),
    ]
    const { frames } = await inferrer(trace)
    // Default fallback = heuristic
    expect(frames).toEqual([['question'], ['explanation'], ['statement']])
  })

  it('V5: LLM throws → fallback', async () => {
    const inferrer = createLlmSemanticFramesInferrer({ client: failingClient() })
    const trace: TraceStep[] = [step('t1', '?', { kind: 'user' })]
    const { frames } = await inferrer(trace)
    expect(frames).toEqual([['question']])
  })

  it('V6: trace > maxTurnsInPrompt → LLM not called', async () => {
    let calls = 0
    const counted: LlmClient = {
      name: 'count',
      async generate() {
        calls++
        return '{}'
      },
    }
    const inferrer = createLlmSemanticFramesInferrer({
      client: counted,
      maxTurnsInPrompt: 2,
    })
    const trace: TraceStep[] = []
    for (let i = 0; i < 5; i++) trace.push(step(`t${i}`, 'q?', { kind: 'user' }))
    const { frames } = await inferrer(trace)
    expect(calls).toBe(0)
    expect(frames.every((f) => Array.isArray(f) && f[0] === 'question')).toBe(true)
  })
})

describe('parseFramesResponse — defensive parsing', () => {
  it('parses fenced JSON block', () => {
    const parsed = parseFramesResponse(
      '```json\n{"frames":[["a"],["b"]]}\n```',
      2,
    )
    expect(parsed).toEqual([['a'], ['b']])
  })

  it('clamps inner array to 4 items + lowercases tokens', () => {
    const parsed = parseFramesResponse(
      JSON.stringify({ frames: [['One', 'Two', 'Three', 'FOUR', 'five']] }),
      1,
    )
    expect(parsed).toEqual([['one', 'two', 'three', 'four']])
  })

  it('drops non-string entries within an inner array', () => {
    const parsed = parseFramesResponse(
      JSON.stringify({ frames: [['ok', 42, null, 'good']] }),
      1,
    )
    expect(parsed).toEqual([['ok', 'good']])
  })

  it('returns [] on shape mismatch', () => {
    expect(parseFramesResponse('{}', 3)).toEqual([])
    expect(parseFramesResponse('not json', 3)).toEqual([])
  })

  it('inner non-array becomes undefined slot', () => {
    const parsed = parseFramesResponse(
      JSON.stringify({ frames: [['ok'], 'wrong', null] }),
      3,
    )
    expect(parsed).toEqual([['ok'], undefined, undefined])
  })
})

describe('buildPrompt', () => {
  it('lists each turn with its kind + excerpt', () => {
    const trace: TraceStep[] = [
      step('t1', 'hello world', { kind: 'user' }),
      step('t2', 'response text', { kind: 'agent' }),
    ]
    const prompt = buildPrompt(trace)
    expect(prompt).toContain('Trace (2 turns):')
    expect(prompt).toContain('[0] user: hello world')
    expect(prompt).toContain('[1] agent: response text')
  })
})

describe('V7 — end-to-end via endSession', () => {
  let cleanup: string[] = []
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('endSession({semanticFrames: heuristic}) populates frames on turns.jsonl', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-frames-int-'))
    cleanup.push(root)
    await mkdir(join(root, 'gks'), { recursive: true })
    await cp(FIXTURES, join(root, 'gks'), { recursive: true })
    const store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
    })
    await store.init()
    const start = await startSession(store)
    await store.appendTrace(start.session.id, { kind: 'user', content: 'What is GKS?' })
    await store.appendTrace(start.session.id, { kind: 'agent', content: 'It is a memory system.' })
    await store.appendTrace(start.session.id, { kind: 'user', content: 'Please make a demo.' })

    await endSession(store, start.session, {
      semanticFrames: createHeuristicSemanticFramesInferrer(),
    })

    const turns = await store.episodicV2.listTurns(start.session.id)
    expect(turns).toHaveLength(3)
    expect(turns[0]!.semantic_frames).toEqual(['question'])
    expect(turns[1]!.semantic_frames).toEqual(['explanation'])
    expect(turns[2]!.semantic_frames).toEqual(['request'])
  })

  it('default behaviour (no opt) leaves semantic_frames undefined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-frames-default-'))
    cleanup.push(root)
    await mkdir(join(root, 'gks'), { recursive: true })
    await cp(FIXTURES, join(root, 'gks'), { recursive: true })
    const store = new MemoryStore({ root, embedder: mockEmbedder(32), reranker: { enabled: false } })
    await store.init()
    const start = await startSession(store)
    await store.appendTrace(start.session.id, { kind: 'user', content: 'q?' })
    await endSession(store, start.session)
    const turns = await store.episodicV2.listTurns(start.session.id)
    expect(turns[0]!.semantic_frames).toBeUndefined()
  })
})
