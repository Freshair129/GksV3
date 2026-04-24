/**
 * Shared types for GKS v3 memory fabric.
 *
 * Reference: BLUEPRINT--memory (Layer 1-4), FRAME--TRI-BRAIN-ARCHITECTURE §3.3.
 */

export type Phase = 0 | 1 | 2 | 3 | 4 | 5
export type Status = 'raw' | 'draft' | 'stable' | 'deprecated' | 'invalid'

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
  user_id?: string
  session_id?: string
  agent_id?: string
  phase?: Phase
  type?: AtomicType
  status?: Status
  tags?: string[]
  [k: string]: unknown
}

export interface VectorManifest {
  embedder_model: string
  dimension: number
  doc_count: number
  last_updated: string
  file_hashes: Record<string, string>
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

export interface InboundArtifact {
  proposed_id: string
  phase: Phase
  type: AtomicType
  title: string
  body: string
  source_session?: string
  confidence?: number
  reason?: string
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

export interface RetrievalOptions {
  strategy?: RetrievalStrategy
  topK?: number
  scoreThreshold?: number
  namespace?: {
    user_id?: string
    session_id?: string
    agent_id?: string
  }
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
  snippet: string
  metadata?: Record<string, unknown>
}

export interface RetainInput {
  content: string
  metadata?: Partial<VectorMetadata>
  proposeInbound?: boolean
  inboundType?: AtomicType
  inboundPhase?: Phase
  sessionId?: string
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
  resolution: 'kept_both' | 'marked_invalid' | 'versioned'
}
