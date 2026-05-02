import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  createLlmExtractor,
  createOpenAICompatibleClient,
  type LlmClient,
} from '../../src/memory/consolidator-llm.js'
import { Consolidator } from '../../src/memory/consolidator.js'
import type { ConsolidationInput, SummaryExtractor } from '../../src/memory/consolidator.js'
import type { TraceStep } from '../../src/memory/types.js'
import { CostTracker } from '../../src/lib/cost-tracker.js'

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

describe('createOpenAICompatibleClient', () => {
  let originalFetch: typeof globalThis.fetch
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function okResponse(content: string, usage?: { prompt: number; completion: number }) {
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [{ message: { content } }],
          ...(usage
            ? {
                usage: {
                  prompt_tokens: usage.prompt,
                  completion_tokens: usage.completion,
                  total_tokens: usage.prompt + usage.completion,
                },
              }
            : {}),
        }
      },
      async text() {
        return ''
      },
    }
  }

  it('hits the chat/completions endpoint with system+user messages', async () => {
    fetchMock.mockResolvedValue(okResponse('{"summary":"ok","tags":[],"outcomes":[],"emotionSummary":"","linkedAtoms":[],"proposals":[]}'))
    const client = createOpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b-instruct',
    })
    expect(client.name).toBe('ollama:qwen2.5:7b-instruct')

    const out = await client.generate({ system: 'sys', user: 'usr', maxTokens: 512 })
    expect(out).toContain('ok')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    const body = JSON.parse(init.body as string) as {
      model: string
      messages: Array<{ role: string; content: string }>
      max_tokens: number
      response_format?: { type: string }
    }
    expect(body.model).toBe('qwen2.5:7b-instruct')
    expect(body.max_tokens).toBe(512)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'usr' })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('omits response_format when jsonMode is false', async () => {
    fetchMock.mockResolvedValue(okResponse('{}'))
    const client = createOpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      model: 'm',
      jsonMode: false,
    })
    await client.generate({ system: 's', user: 'u' })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      response_format?: unknown
    }
    expect(body.response_format).toBeUndefined()
  })

  it('skips Authorization header when no apiKey is set (Ollama default)', async () => {
    fetchMock.mockResolvedValue(okResponse('{}'))
    const client = createOpenAICompatibleClient({ baseUrl: 'http://localhost:11434/v1' })
    await client.generate({ system: 's', user: 'u' })
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['authorization']).toBeUndefined()
  })

  it('sends Authorization header when apiKey is provided', async () => {
    fetchMock.mockResolvedValue(okResponse('{}'))
    const client = createOpenAICompatibleClient({
      baseUrl: 'https://api.together.xyz/v1',
      apiKey: 'sk-test',
      model: 'Qwen/Qwen2.5-7B-Instruct-Turbo',
    })
    expect(client.name).toBe('together:Qwen/Qwen2.5-7B-Instruct-Turbo')
    await client.generate({ system: 's', user: 'u' })
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer sk-test')
  })

  it('records token usage to CostTracker when usage is reported', async () => {
    fetchMock.mockResolvedValue(okResponse('{}', { prompt: 1500, completion: 600 }))
    const tracker = new CostTracker({ emitMetrics: false })
    const client = createOpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b-instruct',
      costTracker: tracker,
    })
    await client.generate({ system: 's', user: 'u' })
    const summary = tracker.summary()
    expect(summary.total.input_tokens).toBe(1500)
    expect(summary.total.output_tokens).toBe(600)
    expect(summary.total.calls).toBe(1)
    // Local SLM → 0 USD per the pricing table.
    expect(summary.total.usd).toBe(0)
  })

  it('throws on non-2xx with redacted body', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      async text() {
        return 'model loading'
      },
    })
    const client = createOpenAICompatibleClient({ baseUrl: 'http://localhost:11434/v1' })
    await expect(client.generate({ system: 's', user: 'u' })).rejects.toThrow(/ollama 503/)
  })

  it('infers provider label from common base URLs', () => {
    const cases: Array<[string, string]> = [
      ['http://localhost:11434/v1', 'ollama'],
      ['http://localhost:1234/v1', 'lmstudio'],
      ['http://localhost:8080/v1', 'llamacpp'],
      ['http://localhost:8000/v1', 'vllm'],
      ['https://api.openai.com/v1', 'openai'],
      ['https://api.together.xyz/v1', 'together'],
      ['https://api.groq.com/openai/v1', 'groq'],
      ['https://example.com/v1', 'openai-compatible'],
    ]
    for (const [url, expected] of cases) {
      const c = createOpenAICompatibleClient({ baseUrl: url, model: 'm' })
      expect(c.name, `for ${url}`).toBe(`${expected}:m`)
    }
  })

  it('plugs into createLlmExtractor end-to-end', async () => {
    const payload = JSON.stringify({
      summary: 'Discussed local SLM consolidation.',
      tags: ['local', 'slm'],
      outcomes: ['Verified Ollama path'],
      emotionSummary: 'satisfied',
      linkedAtoms: [],
      proposals: [
        {
          proposed_id: 'INSIGHT--LOCAL-SLM-CONSOLIDATION-WORKS',
          phase: 1,
          type: 'insight',
          title: 'Local SLM consolidation works',
          body: 'Qwen2.5-7B handled the prompt without truncation.',
          confidence: 0.7,
        },
      ],
    })
    fetchMock.mockResolvedValue(okResponse(payload, { prompt: 1200, completion: 400 }))

    const client = createOpenAICompatibleClient({
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b-instruct',
    })
    const extractor = createLlmExtractor({ client, fallback: heuristic })
    const out = await extractor.extract(sampleInput())
    expect(out.summary).toContain('SLM')
    expect(out.proposals).toHaveLength(1)
    expect(out.proposals[0]!.source_session).toBe('S1')
  })
})
