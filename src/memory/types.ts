/**
 * Shared types for GKS v3 memory fabric.
 *
 * Reference: BLUEPRINT--memory (Layer 1-4).
 */

export type Phase = 0 | 1 | 2 | 3 | 4 | 5 | 6
export type Status = 'raw' | 'draft' | 'stable' | 'deprecated' | 'invalid' | 'superseded'

/**
 * Normalise a status string from external input (CLI flags, frontmatter
 * authored against master-spec wording, MCP requests) into our canonical
 * `Status` enum (ADR-014 item 2).
 *
 * Master-spec §6.3 writes `APPROVED`; the canonical value is `stable`
 * (same semantic — promoted, citable, not draft). `accepted` (used by the
 * ADR README) maps to `stable` too. Unknown values pass through lowercased
 * so callers can decide whether to validate further.
 */
export function normaliseStatus(s: string | undefined | null): string | undefined {
  if (s == null) return undefined
  const lower = s.toLowerCase().trim()
  if (lower === 'approved' || lower === 'accepted') return 'stable'
  return lower
}

/**
 * The chain-walker (`gks verify-flow`) treats these statuses as "the gate
 * is open" — i.e. the atom is promoted, citable, and downstream code may
 * depend on it. Anything else is either pending (draft, raw) or terminal
 * (deprecated, invalid).
 */
export function isApprovedStatus(s: string | undefined | null): boolean {
  const n = normaliseStatus(s)
  return n === 'stable'
}

export type AtomicType =
  | 'concept'
  | 'frame'
  | 'blueprint'
  | 'adr'
  | 'flow'
  | 'audit'
  | 'session'
  | 'rule'
  | 'fact'
  | 'insight'
  | 'hotfix'
  | string

/** One line in gks/00_index/atomic_index.jsonl */
export interface AtomicEntry {
  id: string
  phase: Phase
  type: AtomicType
  status: Status
  vault_id: string
  path: string
  title?: string
  tags?: string[]
  crosslinks?: Record<string, string[]>
  valid_from?: string
  valid_to?: string | null
  /**
   * Code symbols this atom cites. Carried in `atomic_index.jsonl` so
   * `lookupBySymbol(path)` can answer "which atoms govern this code"
   * without re-parsing every atom's frontmatter (see ADR-010).
   */
  linked_symbols?: LinkedSymbol[]
  /**
   * Blueprint-only: file paths the blueprint declares it produces.
   * Treated as file-level citations by reverse lookup (ADR-010).
   */
  geography?: string[]
}

/** Full atomic note (frontmatter + body). */
export interface AtomicNote extends AtomicEntry {
  body: string
}

export interface AtomicFilter {
  phase?: Phase
  type?: AtomicType
  status?: Status
  vault_id?: string
  tag?: string
}

/** Vector store entry (one JSONL line). */
export interface VectorDoc {
  id: string
  source: string
  chunk_id: string
  text: string
  vector: number[]
  metadata: VectorMetadata
}

export interface VectorMetadata {
  path?: string
  title?: string
  heading?: string
  tokens?: number
  hash?: string
  created_at?: string
  tenant_id?: string
  user_id?: string
  session_id?: string
  agent_id?: string
  phase?: Phase
  type?: AtomicType
  status?: Status
  tags?: string[]
  /** Bi-temporal — inclusive lower bound on the "valid in reality" window. */
  valid_from?: string
  /** Bi-temporal — exclusive upper bound. null ⇒ still valid. Set when superseded. */
  valid_to?: string | null
  /** If this doc supersedes another, the ID of the doc it invalidated. */
  superseded_by?: string
  supersedes?: string
  [k: string]: unknown
}

export interface VectorManifest {
  embedder_model: string
  dimension: number
  doc_count: number
  last_updated: string
  file_hashes: Record<string, string>
  /**
   * Schema version of the on-disk JSONL store. Bump on incompatible
   * format changes (renamed required field, changed serialization).
   * Older stores without this field are treated as v1 for back-compat.
   *
   * Versioning policy (semver-like):
   *   major bump → load() refuses; user must run `npm run gks-migrate`
   *   minor bump → load() warns but proceeds (new optional fields)
   *   patch bump → silent (doc-only / typo fixes)
   */
  schema_version?: string
}

export interface VectorSearchOptions {
  topK?: number
  scoreThreshold?: number
  filter?: Partial<VectorMetadata>
}

export interface VectorHit {
  doc: VectorDoc
  score: number
}

export interface AtomicHit {
  note: AtomicNote
  score: number
  matchedBy: 'id' | 'filter'
}

export interface EpisodicMemory {
  id: string
  session_id: string
  started_at: string
  ended_at: string
  duration_min: number
  participants: string[]
  tokens_total?: number
  cost_usd?: number
  tags?: string[]
  linked_atoms?: string[]
  emotion_summary?: string
  outcomes?: string[]
  summary: string
}

/**
 * Reference to a code symbol in the consuming repository. Used by atoms
 * (ADRs / FEATs / FRAMEs) to point at the function / class / type they
 * govern, and by the orchestrator above GKS (e.g. MSP) to correlate
 * recall results with code-intelligence subsystems like GitNexus —
 * see ADR-009 + docs/MSP_RELATIONSHIP.md § "Coexisting with peer subsystems".
 *
 * GKS only stores + serialises these references. It does NOT resolve
 * them (no AST, no call-graph) — that's the orchestrator's job. So a
 * `linked_symbols` entry pointing at a symbol that doesn't exist is
 * not an error here; resolution happens upstream.
 */
export interface LinkedSymbol {
  /** Repo-relative file path, e.g. "src/memory/consolidator-llm.ts". */
  file: string
  /** Optional symbol name within the file, e.g. "formatStep". */
  fn?: string
  /** Optional one-based line number, helpful for fast jump-to-source. */
  line?: number
}

export interface InboundArtifact {
  proposed_id: string
  phase: Phase
  type: AtomicType
  title: string
  body: string
  source_session?: string
  confidence?: number
  reason?: string
  /**
   * Active namespace at the time of proposal. Stamped automatically by
   * api.ts retain() so reviewers know which tenant/user/agent submitted
   * the candidate atom — promoted into the canonical gks/ tree only after
   * human review.
   */
  namespace?: Namespace
  /**
   * Code symbols this atom governs / references. See LinkedSymbol docs
   * + ADR-009 for the GKS↔code-intelligence boundary.
   */
  linked_symbols?: LinkedSymbol[]
}

export interface InboundReceipt {
  path: string
  reviewId: string
}

export interface TraceStep {
  t: string
  session_id: string
  kind: 'user' | 'agent' | 'tool' | 'brain' | 'memory' | 'system'
  content: string
  metadata?: Record<string, unknown>
}

export type RetrievalStrategy =
  | 'atomic'
  | 'vector'
  | 'episodic'
  | 'obsidian'
  | 'multi'

/**
 * Multi-tenancy partition key.
 *
 * Composite by design — different installations want isolation at
 * different granularities. SaaS deployments lean on `tenant_id`; single-
 * tenant agents typically scope by `agent_id` + `session_id`. None are
 * mandatory; an empty namespace ({}) means "global / default tenant".
 *
 * The active namespace is enforced as a metadata filter on every
 * retrieve() — cross-namespace reads require explicit
 * `crossNamespace: true`.
 */
export interface Namespace {
  tenant_id?: string
  user_id?: string
  session_id?: string
  agent_id?: string
}

export interface RetrievalOptions {
  strategy?: RetrievalStrategy
  topK?: number
  scoreThreshold?: number
  /**
   * Namespace filter. Defaults to the MemoryStore's `defaultNamespace`
   * (which itself defaults to `{}`). Set fields constrain the result set
   * to docs whose stamped namespace matches.
   */
  namespace?: Namespace
  /**
   * Bypass the namespace filter — return docs from any namespace. Use only
   * for admin / migration / cross-tenant analytics paths.
   */
  crossNamespace?: boolean
  boostStable?: boolean
  sources?: Array<'atomic' | 'vector' | 'episodic' | 'obsidian'>
}

export interface RetrievalResult {
  query: string
  hits: RetrievalHit[]
  strategy: RetrievalStrategy
  tookMs: number
}

export interface RetrievalHit {
  id: string
  source: 'atomic' | 'vector' | 'episodic' | 'obsidian'
  score: number
  path?: string
  title?: string
  /**
   * SECURITY: snippet text is sourced from user-controlled memory (retain
   * inputs, session traces, Obsidian notes). When passed into a downstream
   * LLM prompt, treat as untrusted — frame it explicitly (e.g. quoted
   * blocks, "RETRIEVED CONTENT BEGIN/END" markers) so an attacker can't use
   * a planted note to override the agent's instructions.
   */
  snippet: string
  metadata?: Record<string, unknown>
}

export interface RetainInput {
  content: string
  metadata?: Partial<VectorMetadata>
  proposeInbound?: boolean
  inboundType?: AtomicType
  inboundPhase?: Phase
  /**
   * @deprecated Pass via `namespace.session_id` instead. Kept working for
   * back-compat — sets metadata.session_id and namespace.session_id.
   */
  sessionId?: string
  /**
   * Tenant / user / session / agent isolation key. If omitted, falls back
   * to the MemoryStore's `defaultNamespace`. Stamped onto the doc's
   * metadata so subsequent retrieve() calls in this namespace see it.
   */
  namespace?: Namespace
  /**
   * Bi-temporal conflict policy. Default 'auto':
   *   auto         → invalidate semantic near-duplicates whose content contradicts the new one
   *   supersede    → always mark cosine ≥ threshold matches as superseded by this new doc
   *   coexist      → keep both (Phase 1 behavior)
   */
  conflictPolicy?: 'auto' | 'supersede' | 'coexist'
  /** Threshold at which cosine similarity triggers conflict handling. Default 0.92. */
  conflictThreshold?: number
  /** Optional explicit valid_from for the new doc. Defaults to now. */
  validFrom?: string
  /**
   * Code symbols this retain governs. Forwarded onto the InboundArtifact
   * (when proposeInbound is true) and rendered into the proposal's
   * frontmatter. Resolution against an actual codebase is the
   * orchestrator's job (see ADR-009).
   */
  linkedSymbols?: LinkedSymbol[]
}

export interface RetainResult {
  vectorDocId?: string
  inboundPath?: string
  conflicts: ConflictRecord[]
}

export interface ConflictRecord {
  existingId: string
  existingPath: string
  reason: string
  resolution: 'kept_both' | 'marked_invalid' | 'versioned' | 'superseded'
  /** When the existing doc was marked invalid (ISO). */
  superseded_at?: string
}
