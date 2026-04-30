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

  it('gks_poc_open/list/close lifecycle', async () => {
    // 1. Open
    const openReply = await client.callTool({
      name: 'gks_poc_open',
      arguments: {
        slug: 'mcp-test',
        title: 'POC over MCP',
        hypothesis: 'MCP transport carries POC tools end-to-end',
        acceptanceCriteria: ['open returns POC--MCP-TEST', 'close sets resolution'],
        deadline: '2099-01-01T00:00:00Z',
      },
    })
    const p = unpack<{ id: string; status: string }>(openReply as ToolReply)
    expect(p.id).toBe('POC--MCP-TEST')
    expect(p.status).toBe('open')

    // 2. Start (open → running)
    const startReply = await client.callTool({
      name: 'gks_poc_start',
      arguments: { id: p.id },
    })
    const started = unpack<{ status: string }>(startReply as ToolReply)
    expect(started.status).toBe('running')

    // 3. List with openOnly filter (running counts as active)
    const listReply = await client.callTool({
      name: 'gks_poc_list',
      arguments: { openOnly: true },
    })
    const list = unpack<any[]>(listReply as ToolReply)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(p.id)
    expect(list[0].status).toBe('running')

    // 4. Close with resolution=validated
    const closeReply = await client.callTool({
      name: 'gks_poc_close',
      arguments: {
        id: p.id,
        resolution: 'validated',
        feedsInto: ['ADR--MCP-WORKS'],
      },
    })
    const closed = unpack<{ status: string; crosslinks: any; time_box: any }>(closeReply as ToolReply)
    expect(closed.status).toBe('validated')
    expect(closed.time_box.closed_at).toBeTruthy()
    expect(closed.crosslinks.feeds_into).toEqual(['ADR--MCP-WORKS'])

    // 5. listOpenOnly excludes closed atom
    const list2Reply = await client.callTool({
      name: 'gks_poc_list',
      arguments: { openOnly: true },
    })
    expect(unpack<any[]>(list2Reply as ToolReply)).toHaveLength(0)
  })

  it('gks_poc_open rejects missing required fields (acceptanceCriteria empty)', async () => {
    const reply = (await client.callTool({
      name: 'gks_poc_open',
      arguments: {
        slug: 'bad',
        title: 't',
        hypothesis: 'h',
        acceptanceCriteria: [],
        deadline: '2099-01-01T00:00:00Z',
      },
    })) as ToolReply
    expect(reply.isError).toBe(true)
  })

  it('gks_issue lifecycle: new → comment → status → close', async () => {
    // 1. Create
    const newReply = await client.callTool({
      name: 'gks_issue_new',
      arguments: {
        title: 'MCP smoke',
        priority: 'high',
        labels: ['mcp', 'test'],
        body: 'Initial description over MCP',
      },
    })
    const created = unpack<{ id: string; status: string; priority: string }>(newReply as ToolReply)
    expect(created.id).toMatch(/^ISSUE--/)
    expect(created.priority).toBe('high')
    expect(created.status).toBe('open')

    // 2. List default (active only)
    const listReply = await client.callTool({
      name: 'gks_issue_list',
      arguments: {},
    })
    const list = unpack<any[]>(listReply as ToolReply)
    expect(list.some((i) => i.id === created.id)).toBe(true)

    // 3. Comment
    const commentReply = await client.callTool({
      name: 'gks_issue_comment',
      arguments: { id: created.id, text: 'investigating', actor: 'mcp-tester' },
    })
    expect(unpack<{ id: string }>(commentReply as ToolReply).id).toBe(created.id)

    // 4. Show — Discussion section now contains the comment
    const showReply = await client.callTool({
      name: 'gks_issue_show',
      arguments: { id: created.id },
    })
    const shown = unpack<{ issue: any; body: string }>(showReply as ToolReply)
    expect(shown.body).toContain('investigating')

    // 5. Transition status → in_progress
    const statusReply = await client.callTool({
      name: 'gks_issue_status',
      arguments: { id: created.id, status: 'in_progress', actor: 'mcp-tester' },
    })
    expect(unpack<{ status: string }>(statusReply as ToolReply).status).toBe('in_progress')

    // 6. Close with resolvedBy
    const closeReply = await client.callTool({
      name: 'gks_issue_close',
      arguments: { id: created.id, actor: 'mcp-tester', resolvedBy: 'ADR--MCP-FIXED' },
    })
    const closed = unpack<{ status: string; closed_at: string; crosslinks: any }>(closeReply as ToolReply)
    expect(closed.status).toBe('closed')
    expect(closed.closed_at).toBeTruthy()
    expect(closed.crosslinks.resolved_by).toEqual(['ADR--MCP-FIXED'])

    // 7. List default no longer includes it (default excludes closed)
    const listAfterReply = await client.callTool({
      name: 'gks_issue_list',
      arguments: {},
    })
    const listAfter = unpack<any[]>(listAfterReply as ToolReply)
    expect(listAfter.some((i) => i.id === created.id)).toBe(false)

    // 8. status='all' includes closed
    const listAllReply = await client.callTool({
      name: 'gks_issue_list',
      arguments: { status: 'all' },
    })
    const listAll = unpack<any[]>(listAllReply as ToolReply)
    expect(listAll.some((i) => i.id === created.id)).toBe(true)
  })

  it('gks_issue_new rejects empty title (zod min(1))', async () => {
    const reply = (await client.callTool({
      name: 'gks_issue_new',
      arguments: { title: '' },
    })) as ToolReply
    expect(reply.isError).toBe(true)
  })
})
