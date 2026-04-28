/**
 * gks-mcp-server tests — in-process client + server connected via the
 * SDK's InMemoryTransport. No actual stdio process spawned, no Zod
 * boilerplate — just the public tool surface verified end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { MemoryStore, mockEmbedder } from '../../src/memory/index.js'
import { createGksMcpServer } from '../../src/mcp-server/index.js'

interface ToolReply {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

function unpack<T = unknown>(reply: ToolReply): T {
  expect(reply.isError).toBeFalsy()
  const text = (reply.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
  return JSON.parse(text) as T
}

describe('gks-mcp-server', () => {
  let cleanup: string[] = []
  let client: Client
  let store: MemoryStore

  beforeEach(async () => {
    cleanup = []
    const root = await mkdtemp(join(tmpdir(), 'gks-mcp-'))
    cleanup.push(root)

    store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
      audit: false,
      cost: false,
    })
    await store.init()

    const server = createGksMcpServer({
      store,
      defaultNamespace: { tenant_id: 'unit-test' },
      exposeCrossNamespace: true,
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  })

  afterEach(async () => {
    await client.close()
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  it('lists all the expected tools', async () => {
    const list = await client.listTools()
    const names = list.tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'gks_retain',
        'gks_recall',
        'gks_lookup',
        'gks_lookup_by_symbol',
        'gks_propose_inbound',
        'gks_reflect',
        'gks_recall_cross_namespace',
        'gks_verify_flow',
        'gks_validate_links',
        'gks_new_feature',
        'gks_hotfix_open',
        'gks_hotfix_list',
        'gks_hotfix_close',
      ].sort(),
    )
  })

  it('gks_retain stores a doc and returns the id', async () => {
    const reply = await client.callTool({
      name: 'gks_retain',
      arguments: {
        content: 'the cat sat on the mat',
        path: 'a.md',
      },
    })
    const body = unpack<{ ok: boolean; doc_id: string; conflicts: unknown[] }>(reply as ToolReply)
    expect(body.ok).toBe(true)
    expect(body.doc_id).toBeTypeOf('string')
    expect(body.conflicts).toEqual([])
  })

  it('gks_recall returns hits matching the query', async () => {
    await client.callTool({
      name: 'gks_retain',
      arguments: { content: 'paris is the capital of france' },
    })
    const reply = await client.callTool({
      name: 'gks_recall',
      arguments: {
        query: 'paris is the capital of france',
        topK: 3,
        scoreThreshold: -1,
      },
    })
    const body = unpack<{ hits: Array<{ snippet: string; score: number }> }>(reply as ToolReply)
    expect(body.hits.length).toBeGreaterThan(0)
    expect(body.hits[0]!.snippet.toLowerCase()).toContain('paris')
  })

  it('gks_lookup returns null on unknown id (never hallucinates)', async () => {
    const reply = await client.callTool({
      name: 'gks_lookup',
      arguments: { id: 'CONCEPT--DOES-NOT-EXIST' },
    })
    const body = unpack<{ found: boolean; note: unknown }>(reply as ToolReply)
    expect(body.found).toBe(false)
    expect(body.note).toBeNull()
  })

  it('gks_lookup_by_symbol returns atoms whose linked_symbols cite the path', async () => {
    // Seed the atomic index with a citation-bearing entry. Normally the MSP
    // re-indexer does this; the MCP test bypasses it.
    const fs = await import('node:fs/promises')
    const root = (store as unknown as { root: string }).root
    const indexDir = join(root, 'gks', '00_index')
    await fs.mkdir(indexDir, { recursive: true })
    const row = {
      id: 'ADR--PARSE-TRACE-NORM',
      phase: 2,
      type: 'adr',
      status: 'stable',
      vault_id: 'V',
      path: 'concept/adr-parse-trace-norm.md',
      title: 'Parse-trace normalization',
      linked_symbols: [{ file: 'src/memory/consolidator-llm.ts', fn: 'formatStep' }],
    }
    await fs.writeFile(join(indexDir, 'atomic_index.jsonl'), JSON.stringify(row) + '\n')

    const hit = await client.callTool({
      name: 'gks_lookup_by_symbol',
      arguments: { symbol: 'src/memory/consolidator-llm.ts:formatStep' },
    })
    const body = unpack<{ hit_count: number; hits: Array<{ id: string; type: string }> }>(
      hit as ToolReply,
    )
    expect(body.hit_count).toBe(1)
    expect(body.hits[0]!.id).toBe('ADR--PARSE-TRACE-NORM')
    expect(body.hits[0]!.type).toBe('adr')

    const miss = await client.callTool({
      name: 'gks_lookup_by_symbol',
      arguments: { symbol: 'src/never.ts:nope' },
    })
    const missBody = unpack<{ hit_count: number }>(miss as ToolReply)
    expect(missBody.hit_count).toBe(0)
  })

  it('gks_propose_inbound writes to the inbound queue', async () => {
    const reply = await client.callTool({
      name: 'gks_propose_inbound',
      arguments: {
        proposed_id: 'INSIGHT--MCP-WORKS',
        phase: 1,
        type: 'insight',
        title: 'MCP server works',
        body: 'Verified by integration test.',
      },
    })
    const body = unpack<{ path: string; review_id: string }>(reply as ToolReply)
    expect(body.review_id).toMatch(/^rev-/)
    expect(body.path).toContain('inbound')
  })

  it('default namespace is applied (tenant_id stamped on retained docs)', async () => {
    await client.callTool({
      name: 'gks_retain',
      arguments: { content: 'tenant-checked' },
    })
    const vs = await store.getVectorStore('atomic')
    const docs = vs.listDocs()
    expect(docs[0]!.metadata['tenant_id']).toBe('unit-test')
  })

  it('rejects malformed atomic ids', async () => {
    const reply = (await client.callTool({
      name: 'gks_lookup',
      arguments: { id: 'lowercase-bad' },
    })) as ToolReply
    expect(reply.isError).toBe(true)
  })

  it('exposeCrossNamespace=false hides the admin tool', async () => {
    // Re-init server without exposeCrossNamespace.
    await client.close()
    const root = await mkdtemp(join(tmpdir(), 'gks-mcp-'))
    cleanup.push(root)
    const innerStore = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      reranker: { enabled: false },
      audit: false,
      cost: false,
    })
    await innerStore.init()

    const server = createGksMcpServer({
      store: innerStore,
      // exposeCrossNamespace omitted
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const c2 = new Client({ name: 'test', version: '0' }, { capabilities: {} })
    await Promise.all([c2.connect(clientT), server.connect(serverT)])
    const list = await c2.listTools()
    expect(list.tools.map((t) => t.name)).not.toContain('gks_recall_cross_namespace')
    await c2.close()
  })
})
