/**
 * MCPObsidianAdapter unit tests — exercise the result-shape normalisers + tool
 * routing using a mock MCPClientLike. Doesn't actually spawn an obsidian-mcp
 * process; that's reserved for opt-in integration tests against a real vault.
 */

import { describe, it, expect } from 'vitest'

import {
  createMCPObsidianAdapter,
  type MCPClientLike,
} from '../../src/memory/index.js'

interface RecordedCall {
  name: string
  arguments?: Record<string, unknown>
}

function makeMockClient(
  responder: (call: RecordedCall) => unknown,
  opts: { failFor?: string[] } = {},
): { client: MCPClientLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const failFor = new Set(opts.failFor ?? [])

  const client: MCPClientLike = {
    async connect() {},
    async close() {},
    async callTool(params) {
      calls.push({ name: params.name, ...(params.arguments ? { arguments: params.arguments } : {}) })
      if (failFor.has(params.name)) {
        throw new Error(`mock: tool ${params.name} explicitly failing`)
      }
      const result = responder(params)
      return {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
      }
    },
  }

  return { client, calls }
}

describe('MCPObsidianAdapter', () => {
  it('search() routes to the configured search tool', async () => {
    const { client, calls } = makeMockClient((c) => {
      if (c.name === 'search_notes') {
        return [
          { filename: 'Cortex.md', score: 0.9, snippet: 'planning' },
          { filename: 'Motor.md', score: 0.8, snippet: 'codegen' },
        ]
      }
      return []
    })
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const hits = await adapter.search('cortex', { limit: 2 })
    expect(hits).toHaveLength(2)
    expect(hits[0]!.path).toBe('Cortex.md')
    expect(hits[0]!.score).toBe(0.9)
    expect(calls[0]!.name).toBe('search_notes')
    expect(calls[0]!.arguments).toEqual({ query: 'cortex', limit: 2 })
  })

  it('search() handles {results: [...]} wrapper', async () => {
    const { client } = makeMockClient(() => ({
      results: [{ path: 'A.md', score: 0.5 }, { path: 'B.md', score: 0.4 }],
    }))
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const hits = await adapter.search('q')
    expect(hits.map((h) => h.path)).toEqual(['A.md', 'B.md'])
  })

  it('search() handles bare-string array (legacy)', async () => {
    const { client } = makeMockClient(() => ['One.md', 'Two.md'])
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const hits = await adapter.search('q')
    expect(hits.map((h) => h.path)).toEqual(['One.md', 'Two.md'])
    expect(hits[0]!.title).toBe('One')
  })

  it('search() returns [] on tool failure (graceful)', async () => {
    const { client } = makeMockClient(() => [], { failFor: ['search_notes'] })
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const hits = await adapter.search('q')
    expect(hits).toEqual([])
  })

  it('resolveWikilink() strips alias + heading and calls readNote tool', async () => {
    const { client, calls } = makeMockClient((c) => {
      if (c.name === 'get_note') {
        return {
          path: 'Concepts/Cortex.md',
          content: 'See [[Motor]] and [[Limbic]].',
          tags: ['brain'],
        }
      }
      return null
    })
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const note = await adapter.resolveWikilink('[[Concepts/Cortex#Heading|Alias]]')
    expect(note?.path).toBe('Concepts/Cortex.md')
    expect(note?.outlinks.sort()).toEqual(['Limbic', 'Motor'])
    expect(calls[0]!.arguments).toEqual({ path: 'Concepts/Cortex' })
  })

  it('backlinksOf() routes to the configured tool with matchedBy=backlink', async () => {
    const { client, calls } = makeMockClient(() => [
      { path: 'A.md', context: 'links to X' },
      { path: 'B.md', context: 'mentions X' },
    ])
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const hits = await adapter.backlinksOf('X.md')
    expect(hits.every((h) => h.matchedBy === 'backlink')).toBe(true)
    expect(calls[0]!.name).toBe('get_backlinks')
  })

  it('tagQuery() strips leading # before sending', async () => {
    const { client, calls } = makeMockClient(() => [{ path: 'A.md' }])
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    await adapter.tagQuery('#brain')
    expect(calls[0]!.arguments).toEqual({ tag: 'brain', limit: 20 })
  })

  it('honors custom tool name overrides', async () => {
    const { client, calls } = makeMockClient(() => [{ path: 'X.md' }])
    const adapter = createMCPObsidianAdapter({
      command: 'noop',
      client,
      tools: { search: 'custom_search', readNote: 'custom_read' },
    })
    await adapter.search('q')
    expect(calls[0]!.name).toBe('custom_search')
  })

  it('ping() resolves true via listTools when present', async () => {
    let listToolsCalled = false
    const client = {
      async connect() {},
      async close() {},
      async callTool() {
        return { content: [] }
      },
      async listTools() {
        listToolsCalled = true
        return { tools: [] }
      },
    } as unknown as MCPClientLike
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const ok = await adapter.ping()
    expect(ok).toBe(true)
    expect(listToolsCalled).toBe(true)
  })

  it('ping() resolves false on transport error', async () => {
    const client: MCPClientLike = {
      async connect() {},
      async close() {},
      async callTool() {
        throw new Error('transport closed')
      },
    }
    const adapter = createMCPObsidianAdapter({ command: 'noop', client })
    const ok = await adapter.ping()
    expect(ok).toBe(false)
  })
})
