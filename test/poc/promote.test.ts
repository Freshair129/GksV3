/**
 * promotePocToAdr — verify the POC→ADR scaffolder produces a
 * well-formed inbound candidate from a closed POC, and refuses to
 * scaffold non-terminal POCs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PocStore } from '../../src/poc/store.js'
import { promotePocToAdr } from '../../src/poc/promote.js'
import { InboundQueue } from '../../src/memory/inbound.js'

const FUTURE = '2099-01-01T00:00:00Z'

describe('promotePocToAdr', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-poc-promote-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('refuses to scaffold a POC in non-terminal status', async () => {
    const store = new PocStore({ root })
    const inbound = new InboundQueue({
      inboundDir: join(root, '.brain', 'inbound'),
      gksRoot: join(root, 'gks'),
    })
    await store.open({
      slug: 'demo',
      title: 'Demo',
      hypothesis: 'h',
      acceptanceCriteria: ['c'],
      deadline: FUTURE,
    })

    await expect(
      promotePocToAdr({
        pocId: 'POC--DEMO',
        pocDir: join(root, 'gks', 'poc'),
        inbound,
      }),
    ).rejects.toThrow(/non-terminal status 'open'/)
  })

  it('scaffolds an ADR draft from a validated POC and writes to inbound', async () => {
    const store = new PocStore({ root })
    const inbound = new InboundQueue({
      inboundDir: join(root, '.brain', 'inbound'),
      gksRoot: join(root, 'gks'),
    })
    await store.open({
      slug: 'rerank',
      title: 'BM25 reranker matches cross-encoder top-3',
      hypothesis: 'BM25 with top-50 retains cross-encoder recall@10 within 5pp',
      acceptanceCriteria: [
        'recall@10 within 5pp on validation set',
        'p99 latency < 1/10th of cross-encoder',
      ],
      deadline: FUTURE,
      derivesFrom: ['CONCEPT--RERANK-PERF'],
    })
    await store.start('POC--RERANK')
    await store.close('POC--RERANK', {
      resolution: 'validated',
      feedsInto: ['ADR--RERANK-CHEAP-DEFAULT'],
      produces: ['AUDIT--RERANK-RESULTS'],
    })

    const result = await promotePocToAdr({
      pocId: 'POC--RERANK',
      pocDir: join(root, 'gks', 'poc'),
      inbound,
    })

    expect(result.proposedId).toBe('ADR--RERANK')
    expect(result.inboundPath).toMatch(/ADR--RERANK\.rev-/)

    const text = await readFile(result.inboundPath, 'utf8')
    expect(text).toContain('proposed_id: ADR--RERANK')
    expect(text).toContain('type: adr')
    expect(text).toContain('phase: 2')
    expect(text).toContain('# ADR — BM25 reranker matches cross-encoder top-3')
    // Hypothesis quoted into Context
    expect(text).toContain('BM25 with top-50 retains cross-encoder recall@10 within 5pp')
    // Verdict reflects status=validated
    expect(text).toContain('validated the hypothesis')
    // Acceptance criteria carried forward
    expect(text).toContain('recall@10 within 5pp on validation set')
    expect(text).toContain('p99 latency < 1/10th of cross-encoder')
    // References crosslink to source POC + derives_from
    expect(text).toContain('POC--RERANK')
    expect(text).toContain('CONCEPT--RERANK-PERF')
  })

  it('verdict text varies by resolution', async () => {
    const store = new PocStore({ root })
    const inbound = new InboundQueue({
      inboundDir: join(root, '.brain', 'inbound'),
      gksRoot: join(root, 'gks'),
    })

    for (const [slug, resolution, expectedSubstring] of [
      ['inv', 'invalidated', 'invalidated the hypothesis'],
      ['ab', 'abandoned', 'abandoned before the criteria'],
    ] as const) {
      await store.open({
        slug,
        title: `t-${slug}`,
        hypothesis: 'h',
        acceptanceCriteria: ['c'],
        deadline: FUTURE,
      })
      await store.close(`POC--${slug.toUpperCase()}`, { resolution })
      const result = await promotePocToAdr({
        pocId: `POC--${slug.toUpperCase()}`,
        pocDir: join(root, 'gks', 'poc'),
        inbound,
      })
      const text = await readFile(result.inboundPath, 'utf8')
      expect(text).toContain(expectedSubstring)
    }
  })

  it('honours --slug and --title overrides', async () => {
    const store = new PocStore({ root })
    const inbound = new InboundQueue({
      inboundDir: join(root, '.brain', 'inbound'),
      gksRoot: join(root, 'gks'),
    })
    await store.open({
      slug: 'foo',
      title: 'foo',
      hypothesis: 'h',
      acceptanceCriteria: ['c'],
      deadline: FUTURE,
    })
    await store.close('POC--FOO', { resolution: 'validated' })

    const result = await promotePocToAdr({
      pocId: 'POC--FOO',
      pocDir: join(root, 'gks', 'poc'),
      inbound,
      options: { adrSlug: 'CUSTOM-NAME', title: 'Custom title' },
    })
    expect(result.proposedId).toBe('ADR--CUSTOM-NAME')
    const text = await readFile(result.inboundPath, 'utf8')
    expect(text).toContain('# ADR — Custom title')
  })
})
