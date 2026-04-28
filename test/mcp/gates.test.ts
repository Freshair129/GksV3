/**
 * ADR-014 gates MCP tests — verifies verify_flow, validate_links,
 * new_feature, and hotfix lifecycle over the MCP transport.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
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
  if (reply.isError) {
    console.error('Tool error:', reply.content)
  }
  expect(reply.isError).toBeFalsy()
  const text = (reply.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
  return JSON.parse(text) as T
}

describe('gks-mcp-gates', () => {
  let root = ''
  let client: Client
  let store: MemoryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-mcp-gates-'))
    store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      audit: false,
    })
    await store.init()

    const server = createGksMcpServer({ store })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} })
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  })

  afterEach(async () => {
    await client.close()
    await rm(root, { recursive: true, force: true })
  })

  it('gks_validate_links returns ok:true on empty store', async () => {
    const reply = await client.callTool({ name: 'gks_validate_links', arguments: {} })
    const body = unpack<{ ok: boolean }>(reply as ToolReply)
    expect(body.ok).toBe(true)
  })

  it('gks_validate_links detects broken wikilinks', async () => {
    const indexDir = join(root, 'gks', '00_index')
    await mkdir(indexDir, { recursive: true })
    const row = {
      id: 'FEAT--BROKEN',
      phase: 3,
      type: 'feat',
      status: 'stable',
      vault_id: 'V',
      path: 'feat/broken.md',
      crosslinks: { references: ['CONCEPT--MISSING'] },
    }
    const indexPath = join(indexDir, 'atomic_index.jsonl')
    await writeFile(indexPath, JSON.stringify(row) + '\n')
    await store.atomic.loadIndex()

    const reply = await client.callTool({ name: 'gks_validate_links', arguments: {} })
    const body = unpack<{ ok: boolean; errors: any[] }>(reply as ToolReply)
    expect(body.ok).toBe(false)
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].target).toBe('CONCEPT--MISSING')
  })

  it('gks_verify_flow reports chain status', async () => {
    const indexDir = join(root, 'gks', '00_index')
    await mkdir(indexDir, { recursive: true })
    const concept = {
      id: 'CONCEPT--GOOD',
      phase: 1,
      type: 'concept',
      status: 'stable',
      vault_id: 'V',
      path: 'concept/good.md',
    }
    const feat = {
      id: 'FEAT--BAD',
      phase: 3,
      type: 'feat',
      status: 'draft',
      vault_id: 'V',
      path: 'feat/bad.md',
      crosslinks: { references: ['CONCEPT--GOOD'] },
    }
    const indexPath = join(indexDir, 'atomic_index.jsonl')
    await writeFile(indexPath, JSON.stringify(concept) + '\n' + JSON.stringify(feat) + '\n')
    await store.atomic.loadIndex()

    const reply = await client.callTool({
      name: 'gks_verify_flow',
      arguments: { id: 'FEAT--BAD' },
    })
    const body = unpack<{ ok: boolean; errors: any[] }>(reply as ToolReply)
    expect(body.ok).toBe(false)
    expect(body.errors[0].id).toBe('FEAT--BAD')
    expect(body.errors[0].reason).toContain('status is \'draft\'')
  })

  it('gks_new_feature scaffolds candidates', async () => {
    const reply = await client.callTool({
      name: 'gks_new_feature',
      arguments: { slug: 'TEST-MCP', title: 'Test via MCP' },
    })
    const body = unpack<{ proposed: Array<{ id: string; path: string }> }>(reply as ToolReply)
    expect(body.proposed).toHaveLength(4)
    expect(body.proposed.some(p => p.id === 'CONCEPT--TEST-MCP')).toBe(true)
  })

  it('gks_hotfix_open/list/close lifecycle', async () => {
    // 1. Open
    const openReply = await client.callTool({
      name: 'gks_hotfix_open',
      arguments: { commitSha: 'abc1234', title: 'fix mcp' },
    })
    const h = unpack<{ id: string }>(openReply as ToolReply)
    expect(h.id).toBe('HOTFIX--ABC1234')

    // 2. List
    const listReply = await client.callTool({
      name: 'gks_hotfix_list',
      arguments: { pending: true },
    })
    const list = unpack<any[]>(listReply as ToolReply)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(h.id)

    // 3. Close
    const closeReply = await client.callTool({
      name: 'gks_hotfix_close',
      arguments: { id: h.id, resolvedBy: ['ADR--FIXED'] },
    })
    const closed = unpack<{ closed_at: string }>(closeReply as ToolReply)
    expect(closed.closed_at).toBeDefined()

    // 4. Verify closed in list
    const list2Reply = await client.callTool({
      name: 'gks_hotfix_list',
      arguments: { pending: true },
    })
    const list2 = unpack<any[]>(list2Reply as ToolReply)
    expect(list2).toHaveLength(0)
  })
})
