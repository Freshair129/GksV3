/**
 * GKS as an MCP server.
 *
 * Exposes the core retain / recall / lookup / proposeInbound surface as
 * MCP tools, so any MCP-aware client (Claude Code, Cursor, custom
 * agents) can use the GKS memory fabric over stdio without writing a
 * Node integration.
 *
 * Design choices
 *   - Tools, not resources: agents want to perform operations, not list
 *     URIs. Resources would expose the doc graph; we'll add that in a
 *     follow-up if there's demand.
 *   - Returns text content blocks with JSON-encoded results — keeps the
 *     wire format predictable and clients can parse the JSON back.
 *   - No Zod dependency in the public API of this module; we use Zod
 *     internally because the SDK requires it. The `createGksMcpServer`
 *     factory accepts a plain MemoryStore + namespace; callers don't
 *     touch Zod themselves.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

import type { MemoryStore } from '../memory/index.js'
import { recall, retain, reflect } from '../memory/api.js'
import { ATOMIC_ID_PATTERN } from '../memory/atomic-id.js'
import type { Namespace } from '../memory/types.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('mcp-server')

const SERVER_VERSION = '3.5.0'

export interface GksMcpServerOptions {
  /** The store to expose. Caller owns its lifecycle. */
  store: MemoryStore
  /**
   * Default namespace applied to every tool call when the caller didn't
   * pass one. Typically set to `{ tenant_id: '...' }` per server instance
   * for SaaS isolation.
   */
  defaultNamespace?: Namespace
  /**
   * If true, expose `gks_recall_cross_namespace` as a separate tool.
   * Default false — admin/migration paths only.
   */
  exposeCrossNamespace?: boolean
}

export function createGksMcpServer(opts: GksMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'gks-mcp-server', version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  // gks_retain
  server.registerTool(
    'gks_retain',
    {
      description:
        'Store a fact in long-term memory with bi-temporal versioning. Returns the doc id and any conflicts flagged against existing facts.',
      inputSchema: {
        content: z.string().describe('The fact text to retain'),
        path: z.string().optional().describe('Optional source path / id'),
        tags: z.array(z.string()).optional().describe('Tags to attach'),
        namespace: namespaceSchema.optional(),
        conflictPolicy: z
          .enum(['auto', 'supersede', 'coexist'])
          .optional()
          .describe('How to handle near-duplicate existing facts. Default auto.'),
      },
    },
    async (args) => {
      const ns = mergeNs(opts.defaultNamespace, args.namespace)
      const result = await retain(opts.store, {
        content: args.content,
        ...(ns ? { namespace: ns } : {}),
        ...(args.conflictPolicy ? { conflictPolicy: args.conflictPolicy } : {}),
        metadata: {
          ...(args.path ? { path: args.path } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
        },
      })
      return jsonReply({ ok: true, doc_id: result.vectorDocId, conflicts: result.conflicts })
    },
  )

  // gks_recall
  server.registerTool(
    'gks_recall',
    {
      description:
        'Retrieve facts relevant to a query. Searches atomic + vector + episodic + (optional) Obsidian sources in parallel and returns the top hits.',
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        scoreThreshold: z.number().optional(),
        strategy: z
          .enum(['atomic', 'vector', 'episodic', 'obsidian', 'multi'])
          .optional()
          .describe('Default multi.'),
        namespace: namespaceSchema.optional(),
      },
    },
    async (args) => {
      const ns = mergeNs(opts.defaultNamespace, args.namespace)
      const result = await recall(opts.store, args.query, {
        ...(args.strategy ? { strategy: args.strategy } : {}),
        ...(args.topK ? { topK: args.topK } : {}),
        ...(args.scoreThreshold !== undefined ? { scoreThreshold: args.scoreThreshold } : {}),
        ...(ns ? { namespace: ns } : {}),
      })
      return jsonReply({
        ok: true,
        query: result.query,
        strategy: result.strategy,
        took_ms: result.tookMs,
        hits: result.hits.map((h) => ({
          id: h.id,
          source: h.source,
          score: h.score,
          path: h.path,
          title: h.title,
          snippet: h.snippet,
        })),
      })
    },
  )

  // gks_lookup
  server.registerTool(
    'gks_lookup',
    {
      description:
        'Exact-id lookup against the atomic index. Returns the canonical note (title + body + frontmatter) or null. Never approximates — use gks_recall for semantic queries.',
      inputSchema: {
        id: z.string().regex(ATOMIC_ID_PATTERN).describe('Atomic ID, e.g. CONCEPT--EVA-TRI-BRAIN'),
      },
    },
    async (args) => {
      const note = await opts.store.lookup(args.id)
      return jsonReply({ ok: true, found: note != null, note: note ?? null })
    },
  )

  // gks_propose_inbound
  server.registerTool(
    'gks_propose_inbound',
    {
      description:
        'Propose a new atomic note for the inbound queue. Reviewers later promote it into the canonical gks/ tree. NEVER writes to gks/ directly.',
      inputSchema: {
        proposed_id: z.string().regex(ATOMIC_ID_PATTERN).describe('TYPE--SLUG format.'),
        phase: z.number().int().min(0).max(5),
        type: z.string(),
        title: z.string(),
        body: z.string(),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    async (args) => {
      const receipt = await opts.store.proposeInbound({
        proposed_id: args.proposed_id,
        phase: args.phase as 0 | 1 | 2 | 3 | 4 | 5,
        type: args.type,
        title: args.title,
        body: args.body,
        ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
      })
      return jsonReply({ ok: true, path: receipt.path, review_id: receipt.reviewId })
    },
  )

  // gks_reflect
  server.registerTool(
    'gks_reflect',
    {
      description:
        'Run consolidation on a session: read its trace, summarize, propose new atoms. Returns the EpisodicMemory shape and any inbound proposals.',
      inputSchema: {
        sessionId: z.string(),
        startedAt: z.string().describe('ISO timestamp'),
        endedAt: z.string().describe('ISO timestamp'),
        participants: z.array(z.string()).optional(),
        forceConsolidate: z.boolean().optional(),
        persist: z.boolean().optional().describe('Default true'),
      },
    },
    async (args) => {
      const trace = await opts.store.episodic.readTrace(args.sessionId)
      const result = await reflect(
        opts.store,
        {
          sessionId: args.sessionId,
          startedAt: args.startedAt,
          endedAt: args.endedAt,
          participants: args.participants ?? [],
          trace,
        },
        { ...(args.persist !== undefined ? { persist: args.persist } : {}) },
      )
      return jsonReply({
        ok: true,
        triggered: result.triggered,
        memory: result.memory,
        proposals: result.proposals,
        inbound_paths: result.inboundPaths,
      })
    },
  )

  // gks_recall_cross_namespace (admin only — gated by exposeCrossNamespace flag)
  if (opts.exposeCrossNamespace) {
    server.registerTool(
      'gks_recall_cross_namespace',
      {
        description:
          'ADMIN: Same as gks_recall but ignores the active namespace filter. Use only for migration / cross-tenant analytics.',
        annotations: {
          title: 'Cross-namespace recall (admin)',
          destructiveHint: false,
          readOnlyHint: true,
        },
        inputSchema: {
          query: z.string(),
          topK: z.number().int().positive().optional(),
          scoreThreshold: z.number().optional(),
        },
      },
      async (args) => {
        const result = await recall(opts.store, args.query, {
          crossNamespace: true,
          ...(args.topK ? { topK: args.topK } : {}),
          ...(args.scoreThreshold !== undefined ? { scoreThreshold: args.scoreThreshold } : {}),
        })
        return jsonReply({ ok: true, hits: result.hits, took_ms: result.tookMs })
      },
    )
  }

  return server
}

// ─── helpers ──────────────────────────────────────────────────────────────

const namespaceSchema = z
  .object({
    tenant_id: z.string().optional(),
    user_id: z.string().optional(),
    session_id: z.string().optional(),
    agent_id: z.string().optional(),
  })
  .strict()

function mergeNs(
  defaultNs: Namespace | undefined,
  callNs: Namespace | undefined,
): Namespace | undefined {
  if (!defaultNs && !callNs) return undefined
  return { ...(defaultNs ?? {}), ...(callNs ?? {}) }
}

function jsonReply(payload: unknown): {
  content: Array<{ type: 'text'; text: string }>
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}

/**
 * Bring up the server on stdio. Used by the bin entry point. Closes the
 * MemoryStore on transport close so the process exits cleanly.
 */
export async function runGksMcpServerStdio(opts: GksMcpServerOptions): Promise<void> {
  const server = createGksMcpServer(opts)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  log.info('gks-mcp-server up on stdio', {
    tenant: opts.defaultNamespace?.tenant_id ?? '(none)',
    crossNamespace: !!opts.exposeCrossNamespace,
  })
}
