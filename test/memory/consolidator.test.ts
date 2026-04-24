import { describe, it, expect } from 'vitest'
import { Consolidator } from '../../src/memory/consolidator.js'
import type { TraceStep } from '../../src/memory/types.js'

function trace(steps: Array<[TraceStep['kind'], string]>): TraceStep[] {
  return steps.map(([kind, content], i) => ({
    t: new Date(Date.now() + i * 1000).toISOString(),
    session_id: 'test',
    kind,
    content,
  }))
}

describe('Consolidator', () => {
  it('heuristic consolidation produces a non-empty summary', async () => {
    const c = new Consolidator()
    const out = await c.consolidate({
      sessionId: 'S1',
      startedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      participants: ['A', 'B'],
      trace: trace([
        ['user', 'Tell me about the Cortex module'],
        ['agent', 'Cortex handles planning and reasoning in the Tri-Brain.'],
        ['user', 'And Motor?'],
        ['agent', 'Motor handles code generation. Motor is faster than Cortex.'],
      ]),
    })
    expect(out.memory.summary.length).toBeGreaterThan(0)
    expect(out.memory.duration_min).toBeGreaterThan(0)
  })

  it('shouldConsolidate() respects message count + duration thresholds', () => {
    const c = new Consolidator({ minMessages: 4, minDurationMin: 1 })
    const longTrace = trace(
      Array.from({ length: 6 }, (_, i) => [i % 2 === 0 ? 'user' : 'agent', `msg ${i}`] as const),
    )
    expect(
      c.shouldConsolidate({
        sessionId: 'S1',
        startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        endedAt: new Date().toISOString(),
        participants: [],
        trace: longTrace,
      }),
    ).toBe(true)

    expect(
      c.shouldConsolidate({
        sessionId: 'S2',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        participants: [],
        trace: longTrace,
      }),
    ).toBe(false) // zero duration
  })

  it('three-gate filter drops low-signal proposals', async () => {
    const c = new Consolidator({ proposalScoreThreshold: 0.9 })
    const out = await c.consolidate({
      sessionId: 'S1',
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      endedAt: new Date().toISOString(),
      participants: [],
      trace: trace([['user', 'hello'], ['agent', 'hi']]),
    })
    expect(out.proposals).toHaveLength(0)
  })
})
