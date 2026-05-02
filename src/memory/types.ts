/**
 * Shared types for GKS v3 memory fabric.
 *
 * Reference: BLUEPRINT--memory (Layer 1-4).
 */

export type Phase = 0 | 1 | 2 | 3 | 4 | 5
export type Status = 'raw' | 'draft' | 'stable' | 'deprecated' | 'invalid'

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
  /**
   * Pre-computed ≤200-token summary of the atom body, generated once at
   * promote/retain time. When present, recall() returns this as the hit
   * snippet instead of a body excerpt — same token budget, far better
   * signal. See ADR--SUMMARY-TLDR.
   *
   * Optional. Atoms without a TLDR keep working — recall falls back to
   * the prior body-excerpt / title-only behaviour.
   */
  summary_tldr?: string
  /**
   * SHA-256 (first 16 hex chars) of the body that was summarised. Used
   * by `gks validate --tldr-staleness` to detect bodies that have been
   * edited since the TLDR was generated.
   */
  summary_tldr_body_hash?: string
  /** ISO-8601 timestamp the TLDR was generated. */
  summary_tldr_generated_at?: string
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
  /**
   * Pre-computed ≤200-token summary of the doc body, generated at retain
   * time when `generateTldr: true`. When present, recall returns this as
   * the hit snippet (capped by `snippetMaxChars`). See ADR--SUMMARY-TLDR.
   */
  summary_tldr?: string
  summary_tldr_body_hash?: string
  summary_tldr_generated_at?: string
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

// ─── Episodic v2 (BLUEPRINT--EPISODIC-V2) ────────────────────────────────

/**
 * Schema-version marker on v2 episodic records. v1 files lack this
 * field and are detected by absence (back-compat).
 */
export const EPISODIC_V2_SCHEMA_VERSION = '2.0.0'

/**
 * Predicate keys validated by `validate-links` on episode + turn
 * crosslinks. Matches the convention atom crosslinks already use —
 * orchestrator-defined predicates (e.g. `inspired_by`) pass through
 * untouched with a warning.
 */
export const CORE_EPISODIC_PREDICATES = [
  'discusses',
  'implements',
  'contradicts',
  'supports',
  'derived_from',
  'references',
] as const
export type CoreEpisodicPredicate = (typeof CORE_EPISODIC_PREDICATES)[number]

/**
 * Predicate-keyed crosslinks. Same shape as atom crosslinks: keys
 * are predicate names (open set), values are atom-id arrays. GKS
 * stores them; orchestrators interpret the semantics.
 */
export type EpisodicCrosslinks = Record<string, string[]>

/**
 * Top-level episodic session record. Lives at
 * `<episodicDir>/<session_id>/session.json`. Immutable after
 * `finaliseSession` (i.e. `ended_at` set).
 */
export interface EpisodicSession {
  schema_version: string
  /** Free-form orchestrator id (e.g. "gks-v3", "EVA", "msp"). */
  system: string
  user_id?: string
  instance_id?: string
  session_id: string
  started_at: string
  ended_at?: string
  namespace?: Namespace
  summary?: string
  outcomes?: string[]
  tags?: string[]
}

/**
 * One context-coherent slice of a session. Lives as one line in
 * `<episodicDir>/<session_id>/episodes.jsonl`. Denormalised
 * `turn_count` / `first_turn_id` / `last_turn_id` are maintained
 * by `appendTurn` to avoid a turns.jsonl scan.
 */
export interface Episode {
  episode_id: string
  episode_type: 'interaction' | 'observation' | 'system_event'
  episode_tag?: string[]
  situation_context?: {
    context_id?: string
    interaction_mode?: 'casual' | 'discussion' | 'deep_discussion' | 'crisis'
    stakes_level?: 'low' | 'medium' | 'high'
    time_pressure?: 'low' | 'medium' | 'high'
  }
  crosslinks?: EpisodicCrosslinks
  /** Number of turns whose `episode_id` matches this episode. */
  turn_count: number
  first_turn_id?: string
  last_turn_id?: string
  started_at?: string
  ended_at?: string
  provenance?: {
    /** Free-form ('consolidator', 'MSP', 'agent:foo'). */
    written_by?: string
    llm_contribution?: string[]
    authoritative_fields?: string[]
  }
}

/**
 * One observed message / action within an episode. Lives as one
 * line in `<episodicDir>/<session_id>/turns.jsonl`. The
 * `episode_id` field is the FK to its parent Episode (single
 * source of truth for the episode↔turn relationship).
 */
export interface Turn {
  turn_id: string
  episode_id: string
  /** ISO-8601 timestamp. */
  t: string
  /** Free-form ('user', 'agent', 'tool', 'system', ...). */
  speaker: string
  raw_text?: string
  text_excerpt?: string
  summary?: string
  epistemic_mode?: 'reflect' | 'inquire' | 'explain' | 'explore'
  semantic_frames?: string[]
  salience_anchor?: {
    phrase: string
    /** 0..1 — how much this phrase carried the conversational load. */
    resonance_impact: number
    authority?: string
  }
  action?: {
    action_type?: string
    artifacts?: string[]
    tools_used?: string[]
  }
  crosslinks?: EpisodicCrosslinks
}

/**
 * Single line in `<episodicDir>/_index.jsonl` — one row per session
 * for fast enumeration without stat-walking session directories.
 */
export interface EpisodicIndexRow {
  session_id: string
  schema_version?: string
  started_at: string
  ended_at?: string
  episode_count: number
  turn_count: number
  summary?: string
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
  /**
   * Maximum characters retained in each hit's `snippet` field. Lets callers
   * trade snippet richness for token budget when the recall result is fed
   * straight into an LLM context window.
   *
   *   - default (`undefined`)  → 240 chars (current behaviour)
   *   - `0`                    → "index-only" mode: snippet becomes the title
   *                              (or id) only — typically ~50 chars per hit,
   *                              ~80 % token reduction vs default. Use when
   *                              the agent will follow up with an explicit
   *                              `lookup(id)` for the chosen hits.
   *   - any positive integer   → snippet truncated to that length (with a `…`
   *                              suffix if cut)
   *
   * Atomic and Obsidian hits whose source snippet is already shorter than
   * the cap are returned unchanged.
   */
  snippetMaxChars?: number
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
  /**
   * If true, generate a `summary_tldr` for the new vector doc and stamp
   * it (plus body hash + timestamp) onto the doc's metadata. When true
   * and `tldrGenerator` is omitted, the heuristic generator is used so
   * the call still works offline. See ADR--SUMMARY-TLDR.
   */
  generateTldr?: boolean
  /**
   * Optional TldrGenerator used when `generateTldr` is true. Defaults to
   * the heuristic generator (zero LLM cost) when not provided.
   */
  tldrGenerator?: import('./tldr.js').TldrGenerator
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
