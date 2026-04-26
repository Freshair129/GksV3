import { describe, it, expect } from 'vitest'
import { createLlmExtractor, type LlmClient } from '../../src/memory/consolidator-llm.js'
import { Consolidator } from '../../src/memory/consolidator.js'
import type { ConsolidationInput, SummaryExtractor } from '../../src/memory/consolidator.js'
import type { TraceStep } from '../../src/memory/types.js'

function mockClient(response: string): LlmClient {
  return {
    name: 'mock',
    async generate() {
      return response
    },
  }
}

function failingClient(): LlmClient {
  return {
    name: 'failing',
    async generate() {
      throw new Error('rate limited')
    },
  }
}

function sampleInput(): ConsolidationInput {
  const t: TraceStep[] = [
    { t: '2026-04-24T10:00:00.000Z', session_id: 'S1', kind: 'user', content: 'How does GKS v3 handle conflicts?' },
    { t: '2026-04-24T10:00:05.000Z', session_id: 'S1', kind: 'agent', content: 'The bi-temporal resolver marks superseded docs with valid_to.' },
    { t: '2026-04-24T10:00:12.000Z', session_id: 'S1', kind: 'user', content: 'So the old doc stays in the store but filtered out?' },
    { t: '2026-04-24T10:00:18.000Z', session_id: 'S1', kind: 'agent', content: 'Exactly — preserves audit trail.' },
  ]
  return {
    sessionId: 'S1',
    startedAt: '2026-04-24T10:00:00.000Z',
    endedAt: '2026-04-24T10:30:00.000Z',
    participants: ['USR', 'AGT'],
    trace: t,
  }
}

const heuristic: SummaryExtractor = {
  async extract() {
    return {
      summary: 'heuristic fallback summary',
      tags: ['fallback'],
      outcomes: [],
      emotionSummary: 'neutral',
      linkedAtoms: [],
      proposals: [],
    }
  },
}

describe('createLlmExtractor', () => {
  it('parses a valid JSON response and stamps source_session', async () => {
    const payload = JSON.stringify({
      summary: 'Discussed bi-temporal conflict resolution in GKS v3.',
      tags: ['memory', 'conflicts'],
      outcomes: ['Confirmed valid_to semantics'],
      emotionSummary: 'curious',
      linkedAtoms: ['CONCEPT--EVA-TRI-BRAIN'],
      proposals: [
        {
          proposed_id: 'INSIGHT--BITEMPORAL-PRESERVES-AUDIT',
          phase: 1,
          type: 'insight',
          title: 'Bitemporal preserves audit trail',
          body: 'Keeping superseded docs in the store lets auditors trace when each fact was current.',
          confidence: 0.8,
        },
      ],
    })
    const extractor = createLlmExtractor({ client: mockClient(payload), fallback: heuristic })
    const out = await extractor.extract(sampleInput())
    expect(out.summary).toContain('bi-temporal')
    expect(out.tags).toEqual(['memory', 'conflicts'])
    expect(out.proposals).toHaveLength(1)
    expect(out.proposals[0]!.source_session).toBe('S1')
    expect(out.proposals[0]!.proposed_id).toBe('INSIGHT--BITEMPORAL-PRESERVES-AUDIT')
  })

  it('extracts JSON from a fenced code block', async () => {
    const payload = '```json\n{"summary":"x","tags":[],"outcomes":[],"emotionSummary":"","linkedAtoms":[],"proposals":[]}\n```'
    const extractor = createLlmExtractor({ client: mockClient(payload), fallback: heuristic })
    const out = await extractor.extract(sampleInput())
    expect(out.summary).toBe('x')
  })

  it('extracts JSON even when preceded by prose', async () => {
    const payload =
      'Here is the consolidation:\n{"summary":"prose-prefixed","tags":[],"outcomes":[],"emotionSummary":"","linkedAtoms":[],"proposals":[]}'
    const extractor = createLlmExtractor({ client: mockClient(payload), fallback: heuristic })
    const out = await extractor.extract(sampleInput())
    expect(out.summary).toBe('prose-prefixed')
  })

  it('drops proposals with malformed IDs', async () => {
    const payload = JSON.stringify({
      summary: 's',
      tags: [],
      outcomes: [],
      emotionSummary: '',
      linkedAtoms: [],
      proposals: [
        { proposed_id: 'lowercase--bad', phase: 1, type: 'insight', title: 'x', body: 'y' },
        { proposed_id: 'INSIGHT--GOOD', phase: 1, type: 'insight', title: 'good', body: 'keep me' },
      ],
    })
    const extractor = createLlmExtractor({ client: mockClient(payload), fallback: heuristic })
    const out = await extractor.extract(sampleInput())
    expect(out.proposals).toHaveLength(1)
    expect(out.proposals[0]!.proposed_id).toBe('INSIGHT--GOOD')
  })

  it('falls back to heuristic on non-JSON output', async () => {
    const extractor = createLlmExtractor({
      client: mockClient('sorry, I cannot produce JSON right now'),
      fallback: heuristic,
    })
    const out = await extractor.extract(sampleInput())
    expect(out.summary).toBe('heuristic fallback summary')
  })

  it('falls back to heuristic on client error', async () => {
    const extractor = createLlmExtractor({ client: failingClient(), fallback: heuristic })
    const out = await extractor.extract(sampleInput())
    expect(out.summary).toBe('heuristic fallback summary')
  })

  it('integrates with Consolidator (Three-Gate filter stays deterministic)', async () => {
    const payload = JSON.stringify({
      summary: 's',
      tags: ['t'],
      outcomes: [],
      emotionSummary: '',
      linkedAtoms: [],
      proposals: [
        {
          proposed_id: 'INSIGHT--BITEMPORAL-PRESERVES-AUDIT',
          phase: 1,
          type: 'insight',
          title: 'Bitemporal preserves audit trail',
          body: 'body',
          confidence: 0.9,
        },
        {
          proposed_id: 'INSIGHT--UNREFERENCED-IDEA',
          phase: 1,
          type: 'insight',
          title: 'Unreferenced Idea',
          body: 'body',
          confidence: 0.9,
        },
      ],
    })
    const extractor = createLlmExtractor({ client: mockClient(payload), fallback: heuristic })
    // threshold 0.6 keeps both if they score highly; threshold 0.95 should
    // drop the unreferenced one since frequency+recency give near-zero signal.
    const consolidator = new Consolidator({
      extractor,
      proposalScoreThreshold: 0.95,
    })
    const out = await consolidator.consolidate(sampleInput())
    // Neither should survive the 0.95 gate because the heuristic proposal
    // scoring has no mentions of these IDs in the (short) trace.
    expect(out.proposals).toHaveLength(0)
  })
})
