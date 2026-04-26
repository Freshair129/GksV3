/**
 * MCP-stdio transport adapter for Obsidian (B.4).
 *
 * Sister to the REST adapter in obsidian-mcp.ts. Talks to an Obsidian-side
 * MCP server (e.g. `obsidian-mcp` npm package) over JSON-RPC 2.0 on stdio
 * — preferred transport per BLUEPRINT--memory §layers.obsidian.transport.
 *
 * Why a separate file
 *   The REST adapter has zero deps; it works against the Local REST API
 *   plugin without needing the MCP SDK installed. Keeping the stdio
 *   transport in its own module means users who only run the REST plugin
 *   don't pay the SDK install cost (and never trigger an MCP handshake
 *   that they don't need).
 *
 * Tool name mapping
 *   The actual MCP server tool names vary across Obsidian-MCP
 *   implementations; this adapter accepts a config that names each one,
 *   defaulting to a sensible set. Tests cover both the happy path and
 *   the "tool missing" graceful degradation.
 */

import type {
  ObsidianAdapter,
  ObsidianNote,
  ObsidianSearchHit,
} from './obsidian-mcp.js'
import { extractWikilinks, wikilinkToPath } from './obsidian-mcp.js'
import { isPresent, isRecord, toStringArray } from '../lib/guards.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('obsidian:mcp-stdio')

export interface MCPObsidianOptions {
  /** Executable that hosts the Obsidian-MCP server. e.g. 'npx' */
  command: string
  /** Args to the executable. e.g. ['-y', '@modelcontextprotocol/obsidian-mcp', '/path/to/vault'] */
  args?: string[]
  /** Inherit env or pass an explicit subset. */
  env?: Record<string, string>
  /** Initialization timeout (ms). Default 5000 — first call has to spawn + handshake. */
  initTimeoutMs?: number
  /**
   * Tool-name overrides. Different Obsidian-MCP implementations expose
   * different tool names; the defaults below match the most common one.
   */
  tools?: {
    search?: string
    readNote?: string
    backlinks?: string
    tag?: string
  }
  /**
   * Pre-built MCP Client. Used by tests to inject a mock; production callers
   * leave this undefined and let the adapter spawn its own.
   */
  client?: MCPClientLike
}

/**
 * Subset of @modelcontextprotocol/sdk's Client surface we depend on. Mirrored
 * here so tests can substitute a mock without dragging in the SDK's heavier
 * surface (Zod schemas, transport plumbing).
 */
export interface MCPClientLike {
  connect(transport?: unknown): Promise<void>
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
  }>
  /** Optional in older SDK / mock variants. ping() uses it as a health probe. */
  listTools?(): Promise<{ tools: Array<{ name: string }> }>
  close(): Promise<void>
}

interface ToolNames {
  search: string
  readNote: string
  backlinks: string
  tag: string
}

const DEFAULT_TOOLS: ToolNames = {
  search: 'search_notes',
  readNote: 'get_note',
  backlinks: 'get_backlinks',
  tag: 'search_by_tag',
}

export function createMCPObsidianAdapter(opts: MCPObsidianOptions): ObsidianAdapter {
  const tools: ToolNames = { ...DEFAULT_TOOLS, ...(opts.tools ?? {}) }
  const initTimeoutMs = opts.initTimeoutMs ?? 5_000

  let client: MCPClientLike | null = opts.client ?? null
  let connecting: Promise<MCPClientLike> | null = null

  async function getClient(): Promise<MCPClientLike> {
    if (client) return client
    if (connecting) return connecting
    connecting = connect()
    try {
      client = await connecting
      return client
    } finally {
      connecting = null
    }
  }

  async function connect(): Promise<MCPClientLike> {
    // Lazy-import the SDK so users who only use the REST adapter don't pay
    // the import cost / dependency surface.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

    // The transport owns the child process — passing the same command/args to
    // it spawns once. (Earlier code also called `spawn(...)` here separately,
    // which orphaned a second process holding stdio handles that the client
    // never saw — see the H1 cleanup commit.)
    const transport = new StdioClientTransport({
      command: opts.command,
      args: opts.args ?? [],
      ...(opts.env ? { env: opts.env } : {}),
    })

    const c: MCPClientLike = new Client(
      { name: 'gks-obsidian-client', version: '1.0.0' },
      { capabilities: {} },
    ) as unknown as MCPClientLike

    await Promise.race([
      c.connect(transport),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`mcp-stdio init timeout after ${initTimeoutMs}ms`)), initTimeoutMs),
      ),
    ])

    return c
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const c = await getClient()
    const result = await c.callTool({ name, arguments: args })
    if (result.isError) {
      throw new Error(`mcp tool ${name} returned isError`)
    }
    // Most Obsidian-MCP servers return JSON in a single text content block.
    const text = (result.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  return {
    id: 'mcp-stdio',

    async ping() {
      try {
        const c = await getClient()
        if (c.listTools) {
          await c.listTools()
        } else {
          // Older SDK / mock without listTools — fall back to a search call.
          await callTool(tools.search, { query: '' })
        }
        return true
      } catch (err) {
        log.debug('mcp-stdio ping failed', { err: (err as Error).message })
        return false
      }
    },

    async search(query, { limit = 10 } = {}) {
      try {
        const result = await callTool(tools.search, { query, limit })
        return normalizeSearchResult(result, limit)
      } catch (err) {
        log.warn('mcp-stdio search failed', { err: (err as Error).message })
        return []
      }
    },

    async resolveWikilink(link) {
      const path = wikilinkToPath(link)
      try {
        const result = await callTool(tools.readNote, { path })
        return normalizeNote(result)
      } catch (err) {
        log.debug('mcp-stdio wikilink miss', { link, err: (err as Error).message })
        return null
      }
    },

    async backlinksOf(path, { limit = 20 } = {}) {
      try {
        const result = await callTool(tools.backlinks, { path, limit })
        return normalizeSearchResult(result, limit, 'backlink')
      } catch (err) {
        log.debug('mcp-stdio backlinks miss', { path, err: (err as Error).message })
        return []
      }
    },

    async tagQuery(tag, { limit = 20 } = {}) {
      const norm = tag.startsWith('#') ? tag.slice(1) : tag
      try {
        const result = await callTool(tools.tag, { tag: norm, limit })
        return normalizeSearchResult(result, limit, 'tag')
      } catch (err) {
        log.debug('mcp-stdio tagQuery failed', { tag: norm, err: (err as Error).message })
        return []
      }
    },
  }
}

// ─── normalisers ───────────────────────────────────────────────────────────

function normalizeSearchResult(
  result: unknown,
  limit: number,
  defaultMatchedBy: ObsidianSearchHit['matchedBy'] = 'fulltext',
): ObsidianSearchHit[] {
  // Accept three shapes commonly returned by Obsidian-MCP servers:
  //   1. [{filename, score, snippet?}, ...]
  //   2. {results: [...]} or {hits: [...]} or {items: [...]}
  //   3. [path, path, ...] (legacy)
  let arr: unknown[] = []
  if (Array.isArray(result)) {
    arr = result
  } else if (isRecord(result)) {
    for (const key of ['results', 'hits', 'items', 'matches', 'notes']) {
      if (Array.isArray(result[key])) {
        arr = result[key] as unknown[]
        break
      }
    }
  }

  return arr
    .slice(0, limit)
    .map((entry, i) => normalizeHit(entry, i, defaultMatchedBy))
    .filter(isPresent)
}

function normalizeHit(
  raw: unknown,
  index: number,
  defaultMatchedBy: ObsidianSearchHit['matchedBy'],
): ObsidianSearchHit | null {
  if (typeof raw === 'string') {
    return {
      path: raw,
      title: basename(raw),
      snippet: '',
      score: 1 / (index + 1),
      matchedBy: defaultMatchedBy,
    }
  }
  if (!isRecord(raw)) return null
  const path =
    (raw['path'] as string | undefined) ??
    (raw['filename'] as string | undefined) ??
    (raw['file'] as string | undefined)
  if (!path) return null
  const title =
    (raw['title'] as string | undefined) ??
    (raw['name'] as string | undefined) ??
    basename(path)
  const snippet =
    (raw['snippet'] as string | undefined) ??
    (raw['context'] as string | undefined) ??
    (raw['preview'] as string | undefined) ??
    ''
  const score =
    typeof raw['score'] === 'number'
      ? (raw['score'] as number)
      : typeof raw['relevance'] === 'number'
        ? (raw['relevance'] as number)
        : 1 / (index + 1)
  const matchedByRaw = raw['matchedBy'] as ObsidianSearchHit['matchedBy'] | undefined
  return {
    path,
    title,
    snippet,
    score,
    matchedBy: matchedByRaw ?? defaultMatchedBy,
  }
}

function normalizeNote(raw: unknown): ObsidianNote | null {
  if (!isRecord(raw)) return null
  const path =
    (raw['path'] as string | undefined) ?? (raw['filename'] as string | undefined)
  if (!path) return null
  const body =
    (raw['content'] as string | undefined) ??
    (raw['body'] as string | undefined) ??
    (raw['text'] as string | undefined) ??
    ''
  const tags = toStringArray(raw['tags'])
  return {
    path,
    title: (raw['title'] as string | undefined) ?? basename(path),
    body,
    tags,
    backlinks: [],
    outlinks: extractWikilinks(body),
  }
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  const tail = idx === -1 ? p : p.slice(idx + 1)
  return tail.replace(/\.md$/i, '')
}
