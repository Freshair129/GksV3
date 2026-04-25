/**
 * Unified Memory Interface — Phase 1.
 *
 * Implements the MemoryStore contract from BLUEPRINT--memory §memory_store:
 *   retrieve(query, options), search(query, source), lookup(id),
 *   writeEpisodic(summary), proposeInbound(artifact), appendTrace(sessionId, step).
 *
 * Retrieval strategy (§retrieval_strategy.default_order):
 *   atomic (exact ID)  →  vector (semantic)  →  obsidian (graph)  →  episodic (session)
 *
 * Merge policy: dedup by path-or-id, rerank by cosine + boost if status==stable,
 * cap total results at max_total.
 *
 * Obsidian layer is not wired in Phase 1 (MCP client pending) — calls for
 * source='obsidian' are no-ops so the shape of the API stays stable.
 */

import { resolve, join } from 'node:path'

import type {
  AtomicHit,
  EpisodicMemory,
  InboundArtifact,
  InboundReceipt,
  RetrievalHit,
  RetrievalOptions,
  RetrievalResult,
  TraceStep,
  VectorHit,
} from './types.js'

import { AtomicLayer } from './gks.js'
import { VectorStore } from './vector/index.js'
import type {
  VectorBackend,
  VectorBackendFactory,
} from './vector/backend.js'
import { createEmbedder, type Embedder, type EmbedderOptions } from './vector/embedder.js'
import { EpisodicLayer } from './episodic.js'
import { InboundQueue } from './inbound.js'
import { createReranker, rerank, type Reranker, type RerankerOptions } from './rerank.js'
import {
  withCache,
  type ObsidianAdapter,
  type ObsidianSearchHit,
} from './obsidian-mcp.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('memory')

export interface MemoryStoreOptions {
  /** Repo root — used to resolve default paths under .brain/ and gks/. */
  root: string
  /** Override: path to atomic_index.jsonl (default: <root>/gks/00_index/atomic_index.jsonl) */
  atomicIndexPath?: string
  /** Override: directory for vector stores (default: <root>/.brain/msp/projects/evaAI/vector) */
  vectorDir?: string
  /** Override: episodic memory dir (default: <root>/.brain/msp/projects/evaAI/memory) */
  episodicDir?: string
  /** Override: session trace dir (default: <root>/.brain/msp/projects/evaAI/session) */
  sessionDir?: string
  /** Override: inbound queue dir (default: <root>/.brain/msp/projects/evaAI/inbound) */
  inboundDir?: string
  /** Optional pre-built embedder. If omitted, createEmbedder(embedderOptions) is used lazily. */
  embedder?: Embedder
  embedderOptions?: EmbedderOptions
  /** Default score threshold for semantic search. */
  vectorScoreThreshold?: number
  /** Cap on merged retrieval results (matches BLUEPRINT merge_policy.max_total). */
  maxTotal?: number
  /**
   * Reranker configuration. Omit to use the lexical BM25-lite default
   * (zero-deps, always-available). Pass `{ enabled: false }` to disable.
   */
  reranker?: RerankerOptions & {
    enabled?: boolean
    /** Blend weight — final = (1 - alpha) * firstPass + alpha * rerankerScore. Default 0.6. */
    alpha?: number
    /** Min-max normalize reranker scores before blending. Default true. */
    normalize?: boolean
    /** Rerank only this many first-pass hits (keeps latency bounded). Default 20. */
    limit?: number
  }
  /**
   * Obsidian adapter. Omit to disable the Obsidian source in retrieve()
   * (a no-op, matching Phase 1 behavior). Pass a RestObsidianAdapter or
   * MockObsidianAdapter. The adapter is wrapped in a 120s TTL cache by
   * default — override with `obsidianCacheTtlSeconds`.
   */
  obsidian?: ObsidianAdapter
  /** TTL (seconds) for the Obsidian cache. Default 120 (BLUEPRINT). */
  obsidianCacheTtlSeconds?: number
  /** Max entries in the Obsidian cache (LRU eviction). Default 1000. */
  obsidianCacheMaxEntries?: number
  /**
   * Optional VectorBackend factory. Lets pgvector / HNSW / Turbopuffer
   * adapters plug in without touching MemoryStore. If omitted, we default
   * to the JSONL-backed VectorStore at <vectorDir>/<name>.jsonl.
   */
  vectorBackend?: VectorBackendFactory
}

export class MemoryStore {
  readonly root: string
  readonly atomic: AtomicLayer
  readonly episodic: EpisodicLayer
  readonly inbound: InboundQueue
  /** Optional Obsidian adapter (wrapped in TTL cache if configured). Null when omitted. */
  readonly obsidian: ObsidianAdapter | null
  /** Absolute dir where vector stores live. Useful for scripts / session hooks. */
  readonly vectorDir: string
  /** Absolute dir where session traces + manifests live. */
  readonly sessionDir: string

  private readonly vectorScoreThreshold: number
  private readonly maxTotal: number
  private readonly embedderOptions: EmbedderOptions | undefined
  private readonly preBuiltEmbedder: Embedder | undefined
  /**
   * `instance` is the canonical source of truth: null ⇒ reranker disabled.
   * alpha/normalize/limit are blend-stage knobs the stage reads at each
   * retrieve() call.
   */
  private readonly rerankBlend: {
    alpha: number
    normalize: boolean
    limit: number
    instance: Reranker | null
  }

  private _embedder: Embedder | null = null
  private readonly stores = new Map<string, VectorBackend>()
  private readonly vectorBackendFactory: VectorBackendFactory | null

  constructor(opts: MemoryStoreOptions) {
    this.root = resolve(opts.root)

    this.atomic = new AtomicLayer({
      indexPath: opts.atomicIndexPath ?? join(this.root, 'gks', '00_index', 'atomic_index.jsonl'),
      gksRoot: join(this.root, 'gks'),
    })

    this.vectorDir =
      opts.vectorDir ?? join(this.root, '.brain', 'msp', 'projects', 'evaAI', 'vector')

    this.sessionDir =
      opts.sessionDir ?? join(this.root, '.brain', 'msp', 'projects', 'evaAI', 'session')

    this.episodic = new EpisodicLayer({
      memoryDir:
        opts.episodicDir ?? join(this.root, '.brain', 'msp', 'projects', 'evaAI', 'memory'),
      sessionDir: this.sessionDir,
    })

    this.inbound = new InboundQueue({
      inboundDir:
        opts.inboundDir ?? join(this.root, '.brain', 'msp', 'projects', 'evaAI', 'inbound'),
      gksRoot: join(this.root, 'gks'),
    })

    this.vectorScoreThreshold = opts.vectorScoreThreshold ?? 0.35
    this.maxTotal = opts.maxTotal ?? 10
    this.embedderOptions = opts.embedderOptions
    this.preBuiltEmbedder = opts.embedder

    const r = opts.reranker ?? {}
    this.rerankBlend = {
      alpha: r.alpha ?? 0.6,
      normalize: r.normalize ?? true,
      limit: r.limit ?? 20,
      instance: r.enabled === false ? null : createReranker(r),
    }

    this.obsidian = opts.obsidian
      ? withCache(opts.obsidian, {
          ttlSeconds: opts.obsidianCacheTtlSeconds ?? 120,
          maxEntries: opts.obsidianCacheMaxEntries ?? 1000,
        })
      : null

    this.vectorBackendFactory = opts.vectorBackend ?? null
  }

  // ─── initialization ────────────────────────────────────────────────────

  async init(): Promise<void> {
    await this.atomic.loadIndex()
    await this.embedder() // lazy trigger so startup surfaces embedder provider choice
    log.info('memory store initialized', {
      atomic_count: this.atomic.size(),
      root: this.root,
    })
  }

  async embedder(): Promise<Embedder> {
    if (this._embedder) return this._embedder
    if (this.preBuiltEmbedder) {
      this._embedder = this.preBuiltEmbedder
      return this._embedder
    }
    this._embedder = await createEmbedder(this.embedderOptions ?? {})
    log.info('embedder ready', {
      provider: this._embedder.provider,
      model: this._embedder.model,
      dim: this._embedder.dimension,
    })
    return this._embedder
  }

  /** Get (or create) a named vector store under the configured vectorDir. */
  async getVectorStore(name: 'atomic' | 'obsidian' | 'episodic' | (string & {})): Promise<VectorBackend> {
    const existing = this.stores.get(name)
    if (existing) return existing
    const embedder = await this.embedder()

    let backend: VectorBackend
    if (this.vectorBackendFactory) {
      backend = await this.vectorBackendFactory(name, embedder)
    } else {
      const jsonl = new VectorStore({
        path: join(this.vectorDir, `${name}.jsonl`),
        embedder,
        name,
        scoreThreshold: this.vectorScoreThreshold,
      })
      await jsonl.load()
      backend = jsonl
    }
    this.stores.set(name, backend)
    return backend
  }

  // ─── core methods (BLUEPRINT contract) ─────────────────────────────────

  async lookup(id: string): Promise<ReturnType<AtomicLayer['lookup']>> {
    return this.atomic.lookup(id)
  }

  async search(
    query: string,
    source: 'atomic' | 'vector' | 'episodic',
    opts: { topK?: number; scoreThreshold?: number } = {},
  ): Promise<RetrievalHit[]> {
    if (source === 'atomic') {
      // For atomic, "search" means exact-id match if the query looks like an ID,
      // else an in-memory substring match against titles/tags.
      if (looksLikeAtomicId(query)) {
        const hit = await this.atomic.searchById(query)
        return hit ? [atomicHitToRetrieval(hit)] : []
      }
      const needle = query.toLowerCase()
      const matched = this.atomic
        .filter({})
        .filter(
          (e) =>
            e.id.toLowerCase().includes(needle) ||
            (e.title ?? '').toLowerCase().includes(needle) ||
            (e.tags ?? []).some((t) => t.toLowerCase().includes(needle)),
        )
        .slice(0, opts.topK ?? 5)
      return matched.map((e) => ({
        id: e.id,
        source: 'atomic' as const,
        score: 1.0,
        path: e.path,
        ...(e.title !== undefined ? { title: e.title } : {}),
        snippet: e.title ?? e.id,
        metadata: { phase: e.phase, type: e.type, status: e.status },
      }))
    }

    if (source === 'vector' || source === 'episodic') {
      const storeName = source === 'vector' ? 'atomic' : 'episodic'
      const store = await this.getVectorStore(storeName)
      const hits = await store.search(query, {
        topK: opts.topK ?? 5,
        ...(opts.scoreThreshold !== undefined ? { scoreThreshold: opts.scoreThreshold } : {}),
      })
      return hits.map(vectorHitToRetrieval)
    }

    throw new Error(`unsupported search source: ${source}`)
  }

  /**
   * Multi-source retrieval. Runs atomic + vector (+ episodic if requested) in
   * parallel, merges, dedupes, reranks, and caps to maxTotal.
   */
  async retrieve(query: string, opts: RetrievalOptions = {}): Promise<RetrievalResult> {
    const started = Date.now()
    const strategy = opts.strategy ?? 'multi'
    const topK = opts.topK ?? 5
    const sources = opts.sources ?? defaultSources(strategy, this.obsidian != null)

    const tasks: Array<Promise<RetrievalHit[]>> = []

    if (sources.includes('atomic')) {
      tasks.push(
        (async () => {
          if (looksLikeAtomicId(query)) {
            const hit = await this.atomic.searchById(query)
            return hit ? [atomicHitToRetrieval(hit)] : []
          }
          return []
        })(),
      )
    }

    if (sources.includes('vector')) {
      tasks.push(
        (async () => {
          const store = await this.getVectorStore('atomic')
          const vectorHits = await store.search(query, {
            topK,
            ...(opts.scoreThreshold !== undefined ? { scoreThreshold: opts.scoreThreshold } : {}),
            ...(opts.namespace ? { filter: opts.namespace } : {}),
          })
          return vectorHits.map(vectorHitToRetrieval)
        })(),
      )
    }

    if (sources.includes('episodic')) {
      tasks.push(
        (async () => {
          const store = await this.getVectorStore('episodic')
          const hits = await store.search(query, {
            topK,
            ...(opts.scoreThreshold !== undefined ? { scoreThreshold: opts.scoreThreshold } : {}),
            ...(opts.namespace ? { filter: opts.namespace } : {}),
          })
          return hits.map(vectorHitToRetrieval)
        })(),
      )
    }

    if (sources.includes('obsidian') && this.obsidian) {
      tasks.push(
        (async () => {
          try {
            const hits = await this.obsidian!.search(query, { limit: topK })
            return hits.map(obsidianHitToRetrieval)
          } catch (err) {
            log.warn('obsidian source failed, continuing without', {
              err: (err as Error).message,
            })
            return []
          }
        })(),
      )
    }

    const resultsPerSource = await Promise.all(tasks)
    const dedupMax = opts.topK ? Math.min(opts.topK, this.maxTotal) : this.maxTotal

    // Pull enough candidates for the reranker to have room to reorder; cap
    // to dedupMax if the reranker is disabled.
    const blend = this.rerankBlend
    const preRerankMax = blend.instance ? Math.max(dedupMax, blend.limit) : dedupMax

    const candidates = mergeAndRerank(resultsPerSource.flat(), {
      boostStable: opts.boostStable ?? true,
      maxTotal: preRerankMax,
    })

    const reranked = blend.instance
      ? await rerank(
          blend.instance,
          {
            query,
            hits: candidates,
            getText: (h) => h.snippet,
            getScore: (h) => h.score,
            withScore: (h, s) => ({ ...h, score: s }),
          },
          {
            alpha: blend.alpha,
            normalize: blend.normalize,
            limit: blend.limit,
          },
        )
      : candidates

    return {
      query,
      hits: reranked.slice(0, dedupMax),
      strategy,
      tookMs: Date.now() - started,
    }
  }

  async writeEpisodic(memory: EpisodicMemory): Promise<void> {
    await this.episodic.writeEpisodic(memory)
  }

  async proposeInbound(artifact: InboundArtifact): Promise<InboundReceipt> {
    return this.inbound.propose(artifact)
  }

  async appendTrace(sessionId: string, step: Omit<TraceStep, 'session_id' | 't'> & { t?: string }): Promise<void> {
    await this.episodic.appendTrace(sessionId, step)
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

const ATOMIC_ID = /^[A-Z][A-Z0-9_]*--[A-Z0-9][A-Z0-9_\-]*$/

function looksLikeAtomicId(s: string): boolean {
  return ATOMIC_ID.test(s.trim())
}

function defaultSources(
  strategy: RetrievalOptions['strategy'],
  hasObsidian: boolean,
): Array<'atomic' | 'vector' | 'episodic' | 'obsidian'> {
  switch (strategy) {
    case 'atomic':
      return ['atomic']
    case 'vector':
      return ['vector']
    case 'episodic':
      return ['episodic']
    case 'obsidian':
      return ['obsidian']
    case 'multi':
    default:
      return hasObsidian
        ? ['atomic', 'vector', 'episodic', 'obsidian']
        : ['atomic', 'vector', 'episodic']
  }
}

function atomicHitToRetrieval(h: AtomicHit): RetrievalHit {
  const { note } = h
  return {
    id: note.id,
    source: 'atomic',
    score: h.score,
    path: note.path,
    ...(note.title !== undefined ? { title: note.title } : {}),
    snippet: note.title ?? note.id,
    metadata: {
      phase: note.phase,
      type: note.type,
      status: note.status,
      matchedBy: h.matchedBy,
    },
  }
}

function vectorHitToRetrieval(h: VectorHit): RetrievalHit {
  const m = h.doc.metadata
  return {
    id: h.doc.id,
    source: m['type'] === 'episodic' ? 'episodic' : 'vector',
    score: h.score,
    ...(typeof m['path'] === 'string' ? { path: m['path'] } : {}),
    ...(typeof m['title'] === 'string' ? { title: m['title'] as string } : {}),
    snippet: snippetFrom(h.doc.text, 240),
    metadata: m,
  }
}

function obsidianHitToRetrieval(h: ObsidianSearchHit): RetrievalHit {
  return {
    id: h.path,
    source: 'obsidian',
    score: h.score,
    path: h.path,
    title: h.title,
    snippet: h.snippet,
    metadata: { matchedBy: h.matchedBy },
  }
}

function snippetFrom(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max - 1) + '…'
}

/** Dedup by (path || id), rerank with optional stable-boost, cap to maxTotal. */
function mergeAndRerank(
  hits: RetrievalHit[],
  opts: { boostStable: boolean; maxTotal: number },
): RetrievalHit[] {
  const byKey = new Map<string, RetrievalHit>()
  for (const h of hits) {
    const key = h.path ?? h.id
    const prev = byKey.get(key)
    if (!prev || h.score > prev.score) byKey.set(key, h)
  }
  const scored = [...byKey.values()].map((h) => {
    const status = (h.metadata?.['status'] as string | undefined) ?? undefined
    const boost = opts.boostStable && status === 'stable' ? 0.05 : 0
    return { h, s: h.score + boost }
  })
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, opts.maxTotal).map(({ h, s }) => ({ ...h, score: s }))
}

/** Re-export concrete layer types so callers can `import { ... } from '.../memory'`. */
export { AtomicLayer } from './gks.js'
export { VectorStore } from './vector/index.js'
export type { VectorBackend, VectorBackendFactory, VectorBackendAddItem } from './vector/backend.js'
export { createPgvectorBackend, vectorToPg, pgToVector } from './vector/pgvector.js'
export type { PgvectorBackendOptions } from './vector/pgvector.js'
export { createHnswBackend } from './vector/hnsw.js'
export type { HnswBackendOptions } from './vector/hnsw.js'
export { createPgGraphBackend } from './graph/pg.js'
export type { PgGraphBackendOptions } from './graph/pg.js'
export { EpisodicLayer } from './episodic.js'
export { InboundQueue } from './inbound.js'
export { createEmbedder, mockEmbedder } from './vector/embedder.js'
export type { Embedder, EmbedderOptions, EmbedderInfo } from './vector/embedder.js'
export { createReranker, rerank } from './rerank.js'
export type { Reranker, RerankerOptions } from './rerank.js'
export { createAnthropicClient, createLlmExtractor } from './consolidator-llm.js'
export type {
  LlmClient,
  AnthropicClientOptions,
  LlmExtractorOptions,
} from './consolidator-llm.js'
export {
  createMockObsidianAdapter,
  createRestObsidianAdapter,
  withCache as wrapObsidianWithCache,
  wikilinkToPath,
  extractWikilinks,
} from './obsidian-mcp.js'
export { createMCPObsidianAdapter } from './obsidian-mcp-stdio.js'
export type { MCPObsidianOptions, MCPClientLike } from './obsidian-mcp-stdio.js'
export { startSession, endSession } from './session.js'
export type {
  SessionMetadata,
  StartSessionOptions,
  StartSessionReport,
  EndSessionOptions,
  EndSessionReport,
} from './session.js'
export { GraphStore } from './graph.js'
export type {
  GraphBackend,
  GraphNode,
  GraphEdge,
  AddNodeArgs,
  AddEdgeArgs,
  GraphQuery,
  NeighborQuery,
  NeighborResult,
  GraphStoreOptions,
} from './graph.js'
export type {
  ObsidianAdapter,
  ObsidianNote,
  ObsidianSearchHit,
  RestObsidianOptions,
  MockVault,
} from './obsidian-mcp.js'
export * from './types.js'
