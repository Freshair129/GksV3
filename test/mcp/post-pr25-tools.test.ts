/**
 * MCP tests for the six tools added on the post-PR-25 work:
 * gks_tldr_regenerate, gks_community_summarize, gks_community_detect,
 * gks_episodic_show, gks_episodic_migrate, gks_episodic_list.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { MemoryStore, mockEmbedder, newEpisodicSession } from '../../src/memory/index.js'
import { createGksMcpServer } from '../../src/mcp-server/index.js'

interface ToolReply {
  content: Array<{ type: string; text?: string }>
  isError?: boolean
}

function unpack<T = unknown>(reply: ToolReply): T {
  if (reply.isError) console.error('Tool error:', reply.content)
  expect(reply.isError).toBeFalsy()
  const text = (reply.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('')
  return JSON.parse(text) as T
}

describe('post-PR-25 MCP tools', () => {
  let root = ''
  let client: Client
  let store: MemoryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-mcp-post25-'))
    store = new MemoryStore({ root, embedder: mockEmbedder(32), audit: false })
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

  it('lists the new tools', async () => {
    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    for (const expected of [
      'gks_tldr_regenerate',
      'gks_community_summarize',
      'gks_community_detect',
      'gks_episodic_show',
      'gks_episodic_migrate',
      'gks_episodic_list',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('gks_tldr_regenerate stamps fresh fields onto a stale atom', async () => {
    // Drop a v1-style atom with a wrong body_hash so it qualifies as stale.
    await mkdir(join(root, 'gks', 'insight'), { recursive: true })
    await writeFile(
      join(root, 'gks', 'insight', 'INSIGHT--MCP-STALE.md'),
      [
        '---',
        'id: INSIGHT--MCP-STALE',
        'phase: 1',
        'type: insight',
        'status: stable',
        'vault_id: default',
        'title: stale',
        'summary_tldr: outdated.',
        'summary_tldr_body_hash: "deadbeef00000000"',
        'summary_tldr_generated_at: "2026-01-01T00:00:00Z"',
        '---',
        '',
        '# Stale',
        '',
        'New body that does not hash to the stored value.',
        '',
      ].join('\n'),
      'utf8',
    )
    // Index it so the atomic layer can find it.
    const indexer = join(__dirname, '..', '..', 'scripts', 'msp', 're-indexer.ts')
    execFileSync('npx', ['tsx', indexer, `--root=${root}`], { stdio: 'pipe' })

    const reply = (await client.callTool({
      name: 'gks_tldr_regenerate',
      arguments: { ids: ['INSIGHT--MCP-STALE'] },
    })) as ToolReply
    const result = unpack<{
      ok: boolean
      regenerated: Array<{ id: string; path: string }>
      errors: Array<{ id: string }>
    }>(reply)
    expect(result.ok).toBe(true)
    expect(result.regenerated).toHaveLength(1)
    expect(result.regenerated[0]!.id).toBe('INSIGHT--MCP-STALE')
  }, 30_000)

  it('gks_community_detect returns a deterministic clustering', async () => {
    // Build a small atom graph: A→B (parent_concept), C→D (parent_concept), E orphan.
    await mkdir(join(root, 'gks', 'concept'), { recursive: true })
    const fm = (id: string, links?: Record<string, string[]>) =>
      [
        '---',
        `id: ${id}`,
        'phase: 1',
        'type: concept',
        'status: stable',
        'vault_id: default',
        `title: ${id}`,
        ...(links ? [`crosslinks: ${JSON.stringify(links)}`] : []),
        '---',
        '',
        `# ${id}`,
        '',
        'body',
        '',
      ].join('\n')
    await writeFile(join(root, 'gks', 'concept', 'CONCEPT--A.md'), fm('CONCEPT--A', { parent_concept: ['CONCEPT--B'] }), 'utf8')
    await writeFile(join(root, 'gks', 'concept', 'CONCEPT--B.md'), fm('CONCEPT--B'), 'utf8')
    await writeFile(join(root, 'gks', 'concept', 'CONCEPT--C.md'), fm('CONCEPT--C', { parent_concept: ['CONCEPT--D'] }), 'utf8')
    await writeFile(join(root, 'gks', 'concept', 'CONCEPT--D.md'), fm('CONCEPT--D'), 'utf8')
    await writeFile(join(root, 'gks', 'concept', 'CONCEPT--E.md'), fm('CONCEPT--E'), 'utf8')

    const indexer = join(__dirname, '..', '..', 'scripts', 'msp', 're-indexer.ts')
    execFileSync('npx', ['tsx', indexer, `--root=${root}`], { stdio: 'pipe' })

    const reply = (await client.callTool({
      name: 'gks_community_detect',
      arguments: {},
    })) as ToolReply
    const result = unpack<{
      communities: Array<{ community_id: string; members: string[] }>
      orphans: string[]
      total_atoms: number
    }>(reply)
    expect(result.total_atoms).toBe(5)
    expect(result.communities.length).toBeGreaterThanOrEqual(2)
    expect(result.orphans).toContain('CONCEPT--E')
  }, 30_000)

  it('gks_community_summarize walks crosslinks via MCP', async () => {
    // Reuse the fixture from the previous test pattern.
    await mkdir(join(root, 'gks', 'concept'), { recursive: true })
    await mkdir(join(root, 'gks', 'feat'), { recursive: true })
    await writeFile(
      join(root, 'gks', 'concept', 'CONCEPT--MCP.md'),
      [
        '---',
        'id: CONCEPT--MCP',
        'phase: 1',
        'type: concept',
        'status: stable',
        'vault_id: default',
        'title: MCP concept',
        'summary_tldr: MCP concept tldr.',
        '---',
        '# concept body',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(root, 'gks', 'feat', 'FEAT--MCP.md'),
      [
        '---',
        'id: FEAT--MCP',
        'phase: 2',
        'type: feat',
        'status: stable',
        'vault_id: default',
        'title: MCP feat',
        'summary_tldr: MCP feat tldr.',
        'crosslinks: {"parent_concept":["CONCEPT--MCP"]}',
        '---',
        '# feat body',
      ].join('\n'),
      'utf8',
    )
    const indexer = join(__dirname, '..', '..', 'scripts', 'msp', 're-indexer.ts')
    execFileSync('npx', ['tsx', indexer, `--root=${root}`], { stdio: 'pipe' })

    const reply = (await client.callTool({
      name: 'gks_community_summarize',
      arguments: { seed: 'FEAT--MCP', hops: 2, edges: ['parent_concept'] },
    })) as ToolReply
    const result = unpack<{ members: string[]; summary: string; generator: string }>(reply)
    expect(result.members).toContain('FEAT--MCP')
    expect(result.members).toContain('CONCEPT--MCP')
    expect(result.summary.length).toBeGreaterThan(0)
  }, 30_000)

  it('gks_episodic_list / show / migrate cycle over MCP', async () => {
    // Programmatically write a v2 session.
    const sess = newEpisodicSession({ session_id: 'SESS-MCP', system: 'gks-v3' })
    await store.episodicV2.writeSession(sess)
    await store.episodicV2.appendEpisode('SESS-MCP', { episode_type: 'interaction', episode_id: 'E1' })
    await store.episodicV2.appendTurn('SESS-MCP', { episode_id: 'E1', speaker: 'user', raw_text: 'hi' })
    await store.episodicV2.finaliseSession('SESS-MCP', { ended_at: '2026-05-02T10:00:00Z', summary: 'mcp session' })

    // list
    const listReply = (await client.callTool({
      name: 'gks_episodic_list',
      arguments: {},
    })) as ToolReply
    const list = unpack<{ ok: boolean; sessions: Array<{ session_id: string; episode_count: number }> }>(listReply)
    expect(list.sessions.find((s) => s.session_id === 'SESS-MCP')).toBeDefined()

    // show
    const showReply = (await client.callTool({
      name: 'gks_episodic_show',
      arguments: { sessionId: 'SESS-MCP', full: true },
    })) as ToolReply
    const show = unpack<{
      ok: boolean
      session: { session_id: string; summary?: string }
      episodes: Array<{ episode_id: string; turn_count: number }>
      turns: Array<{ turn_id: string; speaker: string }>
    }>(showReply)
    expect(show.ok).toBe(true)
    expect(show.session.session_id).toBe('SESS-MCP')
    expect(show.episodes).toHaveLength(1)
    expect(show.turns).toHaveLength(1)
    expect(show.turns[0]!.speaker).toBe('user')

    // show on nonexistent
    const missingReply = (await client.callTool({
      name: 'gks_episodic_show',
      arguments: { sessionId: 'NOT-A-SESSION' },
    })) as ToolReply
    const missing = unpack<{ ok: boolean }>(missingReply)
    expect(missing.ok).toBe(false)
  })

  it('gks_episodic_migrate refuses to clobber existing v2 without force', async () => {
    // Setup: v1 markdown + matching trace, plus a pre-existing v2 dir.
    await mkdir(join(root, '.brain/msp/projects/evaAI/memory'), { recursive: true })
    await mkdir(join(root, '.brain/msp/projects/evaAI/session'), { recursive: true })
    await writeFile(
      join(root, '.brain/msp/projects/evaAI/memory', 'V1-CLOBBER.md'),
      '---\nid: V1-CLOBBER\nsession_id: V1-CLOBBER\n---\n\n# v1\n\nbody.\n',
      'utf8',
    )
    // Pre-create v2 session.
    await store.episodicV2.writeSession(newEpisodicSession({ session_id: 'V1-CLOBBER' }))

    const reply = (await client.callTool({
      name: 'gks_episodic_migrate',
      arguments: { sessionId: 'V1-CLOBBER' },
    })) as ToolReply
    const result = unpack<{ ok: boolean; reason?: string }>(reply)
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/already exists/)
  })
})
