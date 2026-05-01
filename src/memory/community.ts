/**
 * Higher-order summaries over atom communities.
 *
 * Implements ADR--COMMUNITY-SUMMARIES + BLUEPRINT--COMMUNITY-SUMMARIES.
 *
 * Pure read-side primitive: BFS-walk the structured crosslinks from a
 * seed, gather member TLDRs (or bodies), feed to a TldrGenerator, return
 * one synthesised narrative + the member id list. No persistence, no
 * schema change — composes the existing AtomicLayer + crosslinks +
 * TldrGenerator pieces.
 *
 * The community is a *structural* neighbourhood (graph walk over
 * crosslink edges) rather than a *semantic* one (vector similarity).
 * That's intentional — semantic neighbourhoods are a different
 * primitive and belong on a separate API.
 */

import type { AtomicEntry, AtomicNote } from './types.js'
import type { TldrGenerator } from './tldr.js'
import { heuristicTldrGenerator } from './tldr.js'

const DEFAULT_HOPS = 1
const MAX_HOPS = 3
const DEFAULT_MAX_MEMBERS = 30
/**
 * Structural crosslink keys that count as "related to" for community
 * walks. We exclude `partially_supersedes` / `partially_superseded_by`
 * because superseded atoms shouldn't pull historical context into a
 * forward-looking synthesis.
 */
export const DEFAULT_COMMUNITY_EDGES = [
  'references',
  'implements',
  'parent_concept',
  'parent_adr',
  'parent_blueprint',
  'resolves',
] as const

export type CommunityEdgeKey = (typeof DEFAULT_COMMUNITY_EDGES)[number] | string

export interface CommunityRequest {
  /** One or more atomic ids to seed the walk. */
  seed: string | string[]
  /** Hop budget (1..3). Default 1. */
  hops?: number
  /** Crosslink keys to follow. Default: all structural edges. */
  edges?: CommunityEdgeKey[]
  /** Use atom bodies instead of summary_tldr. Default false. */
  includeBodies?: boolean
  /** Hard cap on member count. Default 30. */
  maxMembers?: number
  /**
   * Generator used to synthesise the narrative. Default: heuristic
   * (deterministic, zero LLM cost). Pass a createLlmTldrGenerator
   * result for higher-quality synthesis.
   */
  generator?: TldrGenerator
  /** Token cap for the synthesised narrative. Default 500. */
  maxOutputTokens?: number
}

export interface CommunityResult {
  /** Atomic ids included, sorted by phase asc, id asc (deterministic). */
  members: string[]
  /** Synthesised narrative. */
  summary: string
  /** True iff the maxMembers cap kicked in. */
  truncated: boolean
  /** True iff this came from the LRU cache. */
  cached: boolean
  /** Rough input prompt size in tokens (4 chars/token heuristic). */
  inputTokensEstimate: number
  /** Generator name (e.g. 'heuristic', 'llm:anthropic:claude-...'). */
  generator: string
}

/**
 * Minimal AtomicLayer surface this module needs. Declared structurally
 * so tests can stub without importing the full class.
 */
export interface CommunityAtomic {
  getEntry(id: string): AtomicEntry | undefined
  lookup(id: string): Promise<AtomicNote | null>
}

interface WalkOptions {
  hops: number
  edges: readonly string[]
  maxMembers: number
}

/**
 * BFS-walk crosslinks from `seed` up to `hops` hops, following only the
 * specified edge keys. Returns members sorted by phase ascending then
 * id ascending — deterministic across runs. Caps total count at
 * `maxMembers` and reports `truncated: true` when the cap fires.
 */
export function walkCommunity(
  atomic: CommunityAtomic,
  seed: string | string[],
  opts: WalkOptions,
): { members: AtomicEntry[]; truncated: boolean } {
  const seedArr = Array.isArray(seed) ? seed : [seed]
  const visited = new Map<string, AtomicEntry>()
  let truncated = false

  // Seeds first so they always make it into members even if the walk
  // hits the cap quickly.
  const queue: Array<{ id: string; depth: number }> = []
  for (const id of seedArr) queue.push({ id, depth: 0 })

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (visited.has(id)) continue
    const entry = atomic.getEntry(id)
    if (!entry) continue
    if (visited.size >= opts.maxMembers) {
      truncated = true
      break
    }
    visited.set(id, entry)
    if (depth >= opts.hops) continue

    const cl = entry.crosslinks ?? {}
    for (const key of opts.edges) {
      const targets = cl[key] ?? []
      for (const target of targets) {
        if (!visited.has(target)) queue.push({ id: target, depth: depth + 1 })
      }
    }
  }

  const members = [...visited.values()].sort(
    (a, b) => a.phase - b.phase || a.id.localeCompare(b.id),
  )
  return { members, truncated }
}

/**
 * Build the prompt the synthesis LLM (or heuristic) will see. One block
 * per member, in the same deterministic order returned by walkCommunity.
 */
export async function buildCommunityPrompt(
  atomic: CommunityAtomic,
  members: AtomicEntry[],
  includeBodies: boolean,
): Promise<{ text: string; usedTldrCount: number; usedBodyCount: number }> {
  const blocks: string[] = []
  let usedTldrCount = 0
  let usedBodyCount = 0
  for (const m of members) {
    let body: string | undefined
    // Prefer summary_tldr unless caller explicitly wants bodies, OR
    // the atom has no TLDR and we should fall back to body content.
    if (!includeBodies && m.summary_tldr) {
      body = m.summary_tldr
      usedTldrCount++
    } else {
      const note = await atomic.lookup(m.id)
      const noteBody = note?.body
        ?.replace(/^---\n[\s\S]*?\n---\n?/, '')
        ?.replace(/^#\s+.*\n/, '')
        ?.trim()
      if (noteBody) {
        body = noteBody
        usedBodyCount++
      }
    }
    if (!body) continue
    const titleLine = m.title ? ` — ${m.title}` : ''
    blocks.push(`Atom: ${m.id}${titleLine}\n${body}`)
  }
  return { text: blocks.join('\n\n'), usedTldrCount, usedBodyCount }
}

/**
 * Heuristic synthesis: bullet-list the first sentence of each member's
 * TLDR (or body fallback). Used as the default generator's output for
 * communities — deterministic, zero-LLM-cost, valid markdown.
 */
function heuristicCommunitySynth(members: AtomicEntry[]): string {
  const firstSentence = (s: string): string => {
    const m = /[^.!?]+[.!?]/.exec(s.trim())
    return (m ? m[0] : s.trim()).trim()
  }
  return members
    .map((m) => {
      const text = m.summary_tldr ?? m.title ?? m.id
      return `- **${m.id}**: ${firstSentence(text)}`
    })
    .join('\n')
}

// ─── LRU cache for the synth result ───────────────────────────────────────

interface CacheEntry {
  result: CommunityResult
  /** monotonic counter for LRU ordering */
  touched: number
}

const CACHE_MAX = 64

export class CommunityCache {
  private map = new Map<string, CacheEntry>()
  private clock = 0

  get(key: string): CommunityResult | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    e.touched = ++this.clock
    return { ...e.result, cached: true }
  }

  set(key: string, result: CommunityResult): void {
    if (this.map.size >= CACHE_MAX) {
      // Evict the least-recently-touched entry.
      let oldestKey: string | null = null
      let oldestTouched = Infinity
      for (const [k, v] of this.map) {
        if (v.touched < oldestTouched) {
          oldestTouched = v.touched
          oldestKey = k
        }
      }
      if (oldestKey) this.map.delete(oldestKey)
    }
    this.map.set(key, { result: { ...result, cached: false }, touched: ++this.clock })
  }

  size(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
    this.clock = 0
  }
}

function cacheKey(memberIds: string[], generatorName: string, includeBodies: boolean): string {
  return `${[...memberIds].sort().join(',')}|${generatorName}|${includeBodies ? 'body' : 'tldr'}`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ─── public entry point ──────────────────────────────────────────────────

const COMMUNITY_SYSTEM_PROMPT = `You are synthesising a knowledge-atom community for the GKS v3 system.

You'll receive several short atom summaries below. Produce a single
coherent narrative that:
  - Captures the joint claim across the atoms (not a list of bullets).
  - Mentions atom ids (e.g. ADR--FOO) where they ground specific points.
  - Stays under the requested token budget.
  - Never invents details that aren't in the atoms.

Plain prose, no markdown headings, no JSON. Respond with ONLY the
synthesis text.`

export interface SummarizeCommunityDeps {
  atomic: CommunityAtomic
  cache: CommunityCache
}

export async function summarizeCommunity(
  deps: SummarizeCommunityDeps,
  req: CommunityRequest,
): Promise<CommunityResult> {
  const hops = Math.min(MAX_HOPS, Math.max(0, req.hops ?? DEFAULT_HOPS))
  const edges = (req.edges ?? DEFAULT_COMMUNITY_EDGES) as readonly string[]
  const maxMembers = Math.max(1, req.maxMembers ?? DEFAULT_MAX_MEMBERS)
  const includeBodies = req.includeBodies ?? false
  const generator = req.generator ?? heuristicTldrGenerator()
  const maxOutputTokens = req.maxOutputTokens ?? 500

  const { members, truncated } = walkCommunity(deps.atomic, req.seed, {
    hops,
    edges,
    maxMembers,
  })

  if (members.length === 0) {
    return {
      members: [],
      summary: '',
      truncated: false,
      cached: false,
      inputTokensEstimate: 0,
      generator: generator.name,
    }
  }

  const memberIds = members.map((m) => m.id)
  const key = cacheKey(memberIds, generator.name, includeBodies)
  const cached = deps.cache.get(key)
  if (cached) return cached

  const { text, usedTldrCount, usedBodyCount } = await buildCommunityPrompt(
    deps.atomic,
    members,
    includeBodies,
  )

  let summary: string
  if (generator.name === 'heuristic') {
    summary = heuristicCommunitySynth(members)
  } else {
    // LLM-backed generator: feed the combined prompt as the "body" and
    // pass a hint via the type field so the generator's prompt is
    // distinguishable from the per-atom case.
    summary = await generator.summarize(text, {
      type: 'community',
      maxTokens: maxOutputTokens,
    })
    // Fall back to heuristic if the LLM produced nothing useful.
    if (!summary || summary.trim().length === 0) {
      summary = heuristicCommunitySynth(members)
    }
  }

  void usedTldrCount
  void usedBodyCount

  const result: CommunityResult = {
    members: memberIds,
    summary,
    truncated,
    cached: false,
    inputTokensEstimate: estimateTokens(text),
    generator: generator.name,
  }
  deps.cache.set(key, result)
  // Reading from `cache.get(key)` would now report `cached: true`; the
  // *first* return shouldn't, hence the explicit copy below.
  return { ...result, cached: false }
}

export { COMMUNITY_SYSTEM_PROMPT }
