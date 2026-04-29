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
  AtomicEntry,
  AtomicHit,
  EpisodicMemory,
  InboundArtifact,
  InboundReceipt,
  Namespace,
  RetrievalHit,
  RetrievalOptions,
  RetrievalResult,
  TraceStep,
  VectorHit,
  VectorMetadata,
} from './types.js'

import { AtomicLayer } from './gks.js'
import { AuditLog, type AuditLogOptions, type AuditEvent } from './audit.js'
import { VectorStore } from './vector/index.js'
import type {
  VectorBackend,
  VectorBackendFactory,
} from './vector/backend.js'
import {
  createEmbedder,
  wrapEmbedderWithCostTracker,
  type Embedder,
  type EmbedderOptions,
} from './vector/embedder.js'
import { CostTracker, type CostTrackerOptions } from '../lib/cost-tracker.js'
import { EpisodicLayer } from './episodic.js'
import { InboundQueue } from './inbound.js'
import { ATOMIC_ID_PATTERN, isAtomicId } from './atomic-id.js'
import { createReranker, rerank, type Reranker, type RerankerOptions } from './rerank.js'
import {
  withCache,
  type ObsidianAdapter,
  type ObsidianSearchHit,
} from './obsidian-mcp.js'
import { createLogger } from '../lib/logger.js'
import {
  METRIC_NAMES,
  incrementCounter,
  recordHistogram,
  withSpan,
} from '../lib/telemetry.js'

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
  /**
   * Default namespace applied when retain() / retrieve() callers don't
   * pass one. Empty `{}` means "global" — retrieve() returns docs from
   * any namespace AND new docs are stamped with no namespace fields.
   * For multi-tenant deployments, set { tenant_id: '...' } here per
   * request-scoped MemoryStore instance.
   */
  defaultNamespace?: Namespace
  /**
   * Audit log configuration. Pass `{}` to enable with defaults
   * (writes to <root>/.brain/.../audit/audit-YYYY-MM-DD.jsonl).
   * Omit entirely to disable auditing — appropriate for offline tests
   * but NOT for production.
   */
  audit?: Partial<AuditLogOptions> | false
  /**
   * Cost / token tracker. Pass `{}` to enable with the default pricing
   * table. Set to `false` to disable. When enabled, each retain / recall
   * / reflect call's embedder + LLM usage gets accumulated; endSession
   * flushes the snapshot into session.json.
   */
  cost?: CostTrackerOptions | false
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
  /** Default namespace applied when retain/retrieve callers don't pass one. */
  readonly defaultNamespace: Namespace
  /** Append-only audit log. Null when audit:false was passed. */
  readonly audit: AuditLog | null
  /** Cost / token tracker. Null when cost:false was passed. */
  readonly costTracker: CostTracker | null

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
  private _embedderPending: Promise<Embedder> | null = null
  private readonly stores = new Map<string, VectorBackend>()
  private readonly storesPending = new Map<string, Promise<VectorBackend>>()
  private readonly vectorBackendFactory: VectorBackendFactory | null

  constructor(opts: MemoryStoreOptions) {
    this.root = resolve(opts.root)
    const layout = gksLayout(this.root)

    this.atomic = new AtomicLayer({
      indexPath: opts.atomicIndexPath ?? layout.atomicIndex,
      gksRoot: layout.gks,
    })

    this.vectorDir = opts.vectorDir ?? layout.vector
    this.sessionDir = opts.sessionDir ?? layout.session

    this.episodic = new EpisodicLayer({
      memoryDir: opts.episodicDir ?? layout.memory,
      sessionDir: this.sessionDir,
    })

    this.inbound = new InboundQueue({
      inboundDir: opts.inboundDir ?? layout.inbound,
      gksRoot: layout.gks,
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
    this.defaultNamespace = opts.defaultNamespace ?? {}
    if (opts.audit === false) {
      this.audit = null
    } else {
      this.audit = new AuditLog({
        dir: opts.audit?.dir ?? layout.audit,
        ...(opts.audit?.onEvent ? { onEvent: opts.audit.onEvent } : {}),
        ...(opts.audit?.maxQueryLength !== undefined
          ? { maxQueryLength: opts.audit.maxQueryLength }
          : {}),
        ...(opts.audit?.disableDisk !== undefined
          ? { disableDisk: opts.audit.disableDisk }
          : {}),
      })
    }

    this.costTracker = opts.cost === false ? null : new CostTracker(opts.cost ?? {})
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
    if (this._embedderPending) return this._embedderPending
    this._embedderPending = (async () => {
      const raw = this.preBuiltEmbedder ?? (await createEmbedder(this.embedderOptions ?? {}))
      const wrapped = this.costTracker
        ? wrapEmbedderWithCostTracker(
            raw,
            this.costTracker,
            this.defaultNamespace.tenant_id
              ? { tenant_id: this.defaultNamespace.tenant_id }
              : {},
          )
        : raw
      this._embedder = wrapped
      log.info('embedder ready', {
        provider: wrapped.provider,
        model: wrapped.model,
        dim: wrapped.dimension,
        cost_tracker: this.costTracker !== null,
      })
      return wrapped
    })()
    try {
      return await this._embedderPending
    } finally {
      this._embedderPending = null
    }
  }

  /** Get (or create) a named vector store under the configured vectorDir. */
  async getVectorStore(name: 'atomic' | 'obsidian' | 'episodic' | (string & {})): Promise<VectorBackend> {
    const existing = this.stores.get(name)
    if (existing) return existing
    const inFlight = this.storesPending.get(name)
    if (inFlight) return inFlight

    const promise = (async () => {
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
    })()
    this.storesPending.set(name, promise)
    try {
      return await promise
    } finally {
      this.storesPending.delete(name)
    }
  }

  // ─── core methods (BLUEPRINT contract) ─────────────────────────────────

  /**
   * Exact-id lookup against the atomic index.
   *
   * SECURITY / SCOPE: atomic notes are GLOBAL by design — they live in the
   * shared `gks/` tree, not under a tenant directory. A caller in tenant A
   * who knows tenant B's atomic ID will retrieve B's canonical note. This
   * is intentional: atomic notes are the canonical, reviewed knowledge base
   * (concept definitions, ADRs, public facts) and are meant to be sharable.
   *
   * If you need per-tenant private notes, store them via `retain()` (which
   * stamps namespace) and discover them via `recall()` — never put
   * tenant-private content into atomic.
   */
  async lookup(id: string): Promise<ReturnType<AtomicLayer['lookup']>> {
    const result = await this.atomic.lookup(id)
    if (this.audit) {
      await this.audit.emit({
        op: 'lookup',
        doc_id: id,
        meta: { found: result != null },
      })
    }
    return result
  }

  /**
   * Reverse citation lookup — given a code symbol path like
   * `src/x.ts:foo[:42]`, return every indexed atom whose `linked_symbols`
   * or (for blueprints) `geography` cites that path. Closes the
   * bidirectional traceability loop with GitNexus's AST-level
   * `detect_changes` per ADR-010.
   *
   * GKS does NOT verify the symbol exists in the codebase — that's the
   * orchestrator's job (typically via GitNexus). A citation pointing at
   * a since-renamed function is itself a drift signal worth surfacing.
   */
  async lookupBySymbol(symbolPath: string): Promise<AtomicEntry[]> {
    await this.atomic.loadIndex()
    const hits = this.atomic.searchBySymbol(symbolPath)
    if (this.audit) {
      await this.audit.emit({
        op: 'lookup_by_symbol',
        meta: { symbol: symbolPath, hit_count: hits.length },
      })
    }
    return hits
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
    return withSpan(
      'gks.recall',
      {
        'gks.query_length': query.length,
        'gks.strategy': opts.strategy ?? 'multi',
        'gks.top_k': opts.topK ?? 5,
      },
      (span) => this.retrieveInner(query, opts, span),
    )
  }

  private async retrieveInner(
    query: string,
    opts: RetrievalOptions,
    span: { setAttributes(attrs: Record<string, unknown>): unknown },
  ): Promise<RetrievalResult> {
    const started = Date.now()
    const strategy = opts.strategy ?? 'multi'
    const topK = opts.topK ?? 5
    const sources = opts.sources ?? defaultSources(strategy, this.obsidian != null)

    // Resolve effective namespace + filter mode.
    //   crossNamespace=true  → no filter (admin / cross-tenant analytics)
    //   namespace passed     → use that
    //   else                 → fall back to defaultNamespace
    const activeNamespace: Namespace = opts.crossNamespace
      ? {}
      : opts.namespace ?? this.defaultNamespace
    const namespaceFilter = opts.crossNamespace ? undefined : namespaceAsFilter(activeNamespace)

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
            ...(namespaceFilter ? { filter: namespaceFilter } : {}),
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
            ...(namespaceFilter ? { filter: namespaceFilter } : {}),
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

    const finalHits = reranked.slice(0, dedupMax)
    const tookMs = Date.now() - started
    span.setAttributes({
      'gks.hit_count': finalHits.length,
      'gks.candidate_count': candidates.length,
      'gks.took_ms': tookMs,
      'gks.cross_namespace': !!opts.crossNamespace,
      ...namespaceAsAttrs(activeNamespace, 'gks.ns'),
    })
    recordHistogram(METRIC_NAMES.recallLatency, tookMs, {
      strategy,
      ...(activeNamespace.tenant_id ? { tenant_id: activeNamespace.tenant_id } : {}),
    })
    incrementCounter(METRIC_NAMES.recallHits, finalHits.length, { strategy })

    if (this.audit) {
      await this.audit.emit({
        op: 'recall',
        ...(opts.crossNamespace
          ? {}
          : Object.keys(activeNamespace).length > 0
            ? { namespace: activeNamespace }
            : {}),
        query,
        hit_count: finalHits.length,
        strategy,
        ...(opts.crossNamespace ? { meta: { cross_namespace: true } } : {}),
      })
    }

    return {
      query,
      hits: finalHits,
      strategy,
      tookMs,
    }
  }

  async writeEpisodic(memory: EpisodicMemory): Promise<void> {
    await this.episodic.writeEpisodic(memory)
    if (this.audit) {
      await this.audit.emit({
        op: 'write_episodic',
        doc_id: memory.id,
        meta: { session_id: memory.session_id, duration_min: memory.duration_min },
      })
    }
  }

  async proposeInbound(artifact: InboundArtifact): Promise<InboundReceipt> {
    const receipt = await this.inbound.propose(artifact)
    if (this.audit) {
      await this.audit.emit({
        op: 'propose_inbound',
        doc_id: artifact.proposed_id,
        review_id: receipt.reviewId,
        meta: {
          phase: artifact.phase,
          type: artifact.type,
          ...(artifact.source_session ? { source_session: artifact.source_session } : {}),
        },
      })
    }
    return receipt
  }

  async appendTrace(sessionId: string, step: Omit<TraceStep, 'session_id' | 't'> & { t?: string }): Promise<void> {
    await this.episodic.appendTrace(sessionId, step)
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function looksLikeAtomicId(s: string): boolean {
  return isAtomicId(s.trim())
}

/**
 * Standard on-disk layout for the EVA Tri-Brain memory fabric. Single source
 * of truth so the CLI scaffold, MCP server, and MemoryStore defaults all agree
 * on `<root>/.brain/msp/projects/evaAI/...`.
 *
 * The path shape is intentionally chosen to interop with MSP-shaped Memory OS
 * layers (the canonical one being EVA's MSP). See docs/MSP_RELATIONSHIP.md.
 */
export function gksLayout(root: string): {
  root: string
  brain: string
  vector: string
  session: string
  memory: string
  inbound: string
  audit: string
  gks: string
  atomicIndex: string
} {
  const r = resolve(root)
  const brain = join(r, '.brain', 'msp', 'projects', 'evaAI')
  return {
    root: r,
    brain,
    vector: join(brain, 'vector'),
    session: join(brain, 'session'),
    memory: join(brain, 'memory'),
    inbound: join(brain, 'inbound'),
    audit: join(brain, 'audit'),
    gks: join(r, 'gks'),
    atomicIndex: join(r, 'gks', '00_index', 'atomic_index.jsonl'),
  }
}

/**
 * Convert a Namespace into a metadata-filter object: only includes the
 * keys that are actually set, so an empty namespace produces no filter
 * (returns undefined).
 */
export function namespaceAsFilter(ns: Namespace): Partial<VectorMetadata> | undefined {
  const out: Record<string, string> = {}
  if (ns.tenant_id !== undefined) out['tenant_id'] = ns.tenant_id
  if (ns.user_id !== undefined) out['user_id'] = ns.user_id
  if (ns.session_id !== undefined) out['session_id'] = ns.session_id
  if (ns.agent_id !== undefined) out['agent_id'] = ns.agent_id
  return Object.keys(out).length > 0 ? (out as Partial<VectorMetadata>) : undefined
}

/** Stamp namespace fields onto a VectorMetadata-shaped object (only the set keys). */
export function applyNamespace(
  metadata: Partial<VectorMetadata>,
  ns: Namespace,
): Partial<VectorMetadata> {
  return {
    ...metadata,
    ...(ns.tenant_id !== undefined ? { tenant_id: ns.tenant_id } : {}),
    ...(ns.user_id !== undefined ? { user_id: ns.user_id } : {}),
    ...(ns.session_id !== undefined ? { session_id: ns.session_id } : {}),
    ...(ns.agent_id !== undefined ? { agent_id: ns.agent_id } : {}),
  }
}

function namespaceAsAttrs(ns: Namespace, prefix: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (ns.tenant_id !== undefined) out[`${prefix}.tenant_id`] = ns.tenant_id
  if (ns.user_id !== undefined) out[`${prefix}.user_id`] = ns.user_id
  if (ns.session_id !== undefined) out[`${prefix}.session_id`] = ns.session_id
  if (ns.agent_id !== undefined) out[`${prefix}.agent_id`] = ns.agent_id
  return out
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

/**
 * Score boost added when a hit's metadata.status === 'stable'. Tunable: a
 * higher value pushes promoted/canonical notes harder above raw vector hits.
 * Picked empirically on the LoCoMo + LongMemEval fixtures.
 */
const STABLE_BOOST = 0.05

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
    const boost = opts.boostStable && status === 'stable' ? STABLE_BOOST : 0
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
export { ATOMIC_ID_PATTERN, isAtomicId, assertAtomicId } from './atomic-id.js'
export { createEmbedder, mockEmbedder } from './vector/embedder.js'
export { createNomicEmbedder } from './vector/embedder-nomic.js'
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
export {
  withSpan,
  recordHistogram,
  incrementCounter,
  timeAsync,
  METRIC_NAMES,
} from '../lib/telemetry.js'
export { setupTelemetry } from '../lib/telemetry-setup.js'
export type {
  SetupTelemetryOptions,
  SetupResult as TelemetrySetupResult,
} from '../lib/telemetry-setup.js'
export { retain, recall, reflect } from './api.js'
export type { ReflectOptions, ReflectResult } from './api.js'

export { AuditLog } from './audit.js'
export type { AuditEvent, AuditOp, AuditLogOptions } from './audit.js'
export {
  CURRENT_SCHEMA_VERSION,
  SchemaVersionMismatchError,
  checkSchemaCompatibility,
  enforceSchemaCompatibility,
} from '../lib/schema-version.js'
export type { Compatibility as SchemaCompatibility } from '../lib/schema-version.js'
export { CostTracker, DEFAULT_PRICING, estimateTokens as estimateCostTokens } from '../lib/cost-tracker.js'
export type {
  CostTrackerOptions,
  CostRecord,
  CostSummary,
  ProviderTotal,
  ModelPricing,
  PricingKey,
} from '../lib/cost-tracker.js'

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
