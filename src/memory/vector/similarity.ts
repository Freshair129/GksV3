/**
 * Cosine similarity + brute-force top-K search.
 *
 * Phase 1: brute force (O(N·d)) is fine for N < ~100k vectors. For >1M we'll
 * plug in HNSW (e.g. hnswlib-node) and keep this interface stable.
 */

import type { VectorDoc, VectorHit, VectorSearchOptions } from '../types.js'

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dim mismatch ${a.length} vs ${b.length}`)
  }
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * In-place L2 normalization. Callers that store unit vectors can skip the
 * sqrt(na)·sqrt(nb) term — left here as a hot-path optimization hook.
 */
export function l2Normalize(v: number[]): number[] {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  if (n === 0) return v
  const inv = 1 / Math.sqrt(n)
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv
  return v
}

export interface TopKOptions extends VectorSearchOptions {
  /** Optional synchronous predicate for metadata filtering (faster than VectorSearchOptions.filter). */
  predicate?: (doc: VectorDoc) => boolean
}

export function topK(
  query: number[],
  docs: readonly VectorDoc[],
  opts: TopKOptions = {},
): VectorHit[] {
  const k = opts.topK ?? 5
  const threshold = opts.scoreThreshold ?? 0
  const filter = opts.filter
  const predicate = opts.predicate

  // Min-heap of size k: [score, doc]. For small k, an array + insertion sort
  // beats a real heap on both constant factors and readability.
  const heap: VectorHit[] = []

  for (const doc of docs) {
    if (predicate && !predicate(doc)) continue
    if (filter && !matchesFilter(doc, filter)) continue

    const score = cosine(query, doc.vector)
    if (score < threshold) continue

    if (heap.length < k) {
      heap.push({ doc, score })
      if (heap.length === k) heap.sort((a, b) => a.score - b.score)
    } else if (score > heap[0]!.score) {
      heap[0] = { doc, score }
      // Re-bubble the new head down to its place.
      let i = 0
      while (i < heap.length - 1 && heap[i]!.score > heap[i + 1]!.score) {
        const tmp = heap[i]!
        heap[i] = heap[i + 1]!
        heap[i + 1] = tmp
        i++
      }
    }
  }

  return heap.sort((a, b) => b.score - a.score)
}

function matchesFilter(doc: VectorDoc, filter: Partial<VectorDoc['metadata']>): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined) continue
    const docVal = doc.metadata[k]
    if (Array.isArray(v)) {
      if (!Array.isArray(docVal)) return false
      for (const needle of v) if (!docVal.includes(needle)) return false
    } else if (docVal !== v) {
      return false
    }
  }
  return true
}
