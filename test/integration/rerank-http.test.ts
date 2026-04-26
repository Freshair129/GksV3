/**
 * HTTP reranker integration test — opt-in.
 *
 * Skipped unless `GKS_RERANK_ENDPOINT` is set. Set it to a Hugging Face TEI
 * (`BAAI/bge-reranker-v2-m3`) /rerank URL — typically `http://localhost:8080/rerank`
 * after `npm run rerank:up`.
 *
 * Verifies that the HTTP rerank backend already wired in src/memory/rerank.ts
 * actually talks to a real cross-encoder server. Catches breaking changes in
 * the TEI response shape (which has historically wrapped scores in
 * { scores: [] } OR { results: [{score}] } depending on version) — both are
 * supported by the backend.
 */

import { describe, it, expect } from 'vitest'
import { createReranker } from '../../src/memory/index.js'

const ENDPOINT = process.env['GKS_RERANK_ENDPOINT']
const HAS_ENDPOINT = !!ENDPOINT
const describeIfLive = HAS_ENDPOINT ? describe : describe.skip

describeIfLive(`HTTP reranker @ ${ENDPOINT ?? '(unset)'}`, () => {
  // Build the reranker lazily inside each test so vitest's collection phase
  // doesn't try to construct it (and fail) when ENDPOINT is undefined.
  const reranker = () => createReranker({ backend: 'http', endpoint: ENDPOINT! })

  it('ranks the topical document above an unrelated one', async () => {
    const scores = await reranker().score('the capital of France', [
      'Paris is the capital of France.',
      'Quantum mechanics is unrelated to memory systems.',
    ])
    expect(scores).toHaveLength(2)
    expect(scores[0]!).toBeGreaterThan(scores[1]!)
  })

  it('handles multi-doc payloads (10 docs)', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => `doc ${i}: random ${Math.random()}`)
    docs[3] = 'the fox jumps over the lazy dog'
    const scores = await reranker().score('fox lazy dog', docs)
    expect(scores).toHaveLength(10)
    const top = scores.indexOf(Math.max(...scores))
    expect(top).toBe(3)
  })

  it('returns numeric scores for an empty docs array gracefully', async () => {
    // Spec is loose here — different TEI versions may return [] or 400. Both
    // are acceptable; we just verify no crash.
    try {
      const scores = await reranker().score('q', [])
      expect(Array.isArray(scores)).toBe(true)
    } catch (err) {
      expect((err as Error).message).toMatch(/rerank http \d{3}/)
    }
  })
})

describe('HTTP reranker (skipped unless GKS_RERANK_ENDPOINT set)', () => {
  it('explains how to enable', () => {
    if (HAS_ENDPOINT) return
    console.log(
      [
        '',
        '  → Run TEI: npm run rerank:up',
        '  → Wait for healthcheck (~60s on first pull)',
        '  → GKS_RERANK_ENDPOINT=http://localhost:8080/rerank npm test',
        '',
      ].join('\n'),
    )
    expect(true).toBe(true)
  })
})
