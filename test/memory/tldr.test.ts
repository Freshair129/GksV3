/**
 * Tests for TldrGenerator + the summary_tldr round-trip described in
 * BLUEPRINT--SUMMARY-TLDR §verification_plan (V1–V7).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, cp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  bodyHash,
  createLlmTldrGenerator,
  generateTldrStamp,
  heuristicTldrGenerator,
} from '../../src/memory/tldr.js'
import type { LlmClient } from '../../src/memory/consolidator-llm.js'

import { MemoryStore } from '../../src/memory/index.js'
import { mockEmbedder } from '../../src/memory/vector/embedder.js'
import { retain, recall } from '../../src/memory/api.js'

const FIXTURES = resolve(__dirname, '..', 'fixtures', 'gks')

function mockClient(text: string): LlmClient {
  return {
    name: 'mock-tldr-client',
    async generate() {
      return text
    },
  }
}

function failingClient(): LlmClient {
  return {
    name: 'failing-tldr-client',
    async generate() {
      throw new Error('boom')
    },
  }
}

const SAMPLE_BODY = `# Heading we should drop

This is the first sentence of a long body. The second sentence carries the
core claim about why TL;DR matters. We add more filler to push past 200
chars and trigger truncation when the cap is small.

## Section we also strip

\`\`\`ts
const code = 'should be removed'
\`\`\`
`

describe('heuristicTldrGenerator', () => {
  it('strips frontmatter, headings, and code blocks; keeps prose', async () => {
    const g = heuristicTldrGenerator()
    const out = await g.summarize(SAMPLE_BODY)
    expect(out).not.toContain('#')
    expect(out).not.toContain('```')
    expect(out).toContain('first sentence')
  })

  it('truncates a single oversized sentence with an ellipsis', async () => {
    const g = heuristicTldrGenerator()
    // One huge sentence (no separators) bypasses sentence-count cap and
    // forces the maxChars truncation path.
    const long = 'word '.repeat(500).trim()
    const out = await g.summarize(long, { maxTokens: 30 })
    expect(out.length).toBeLessThanOrEqual(30 * 4 + 1)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string on empty body', async () => {
    const g = heuristicTldrGenerator()
    expect(await g.summarize('')).toBe('')
    expect(await g.summarize('   \n\n   ')).toBe('')
  })
})

describe('createLlmTldrGenerator', () => {
  it('passes through the LLM output, trimmed and de-fenced', async () => {
    const g = createLlmTldrGenerator({
      client: mockClient('```\nClean summary text.\n```'),
    })
    const out = await g.summarize('body content')
    expect(out).toBe('Clean summary text.')
  })

  it('strips leading TL;DR: / Summary: prefixes', async () => {
    const g1 = createLlmTldrGenerator({ client: mockClient('TL;DR: actual content here.') })
    expect(await g1.summarize('x')).toBe('actual content here.')

    const g2 = createLlmTldrGenerator({ client: mockClient('Summary — actual content.') })
    expect(await g2.summarize('x')).toBe('actual content.')
  })

  it('falls back to heuristic on client error (V4)', async () => {
    const g = createLlmTldrGenerator({ client: failingClient() })
    const out = await g.summarize(SAMPLE_BODY)
    expect(out).toContain('first sentence') // heuristic kept the prose
  })

  it('falls back to heuristic when LLM returns empty/whitespace', async () => {
    const g = createLlmTldrGenerator({ client: mockClient('   \n\n   ') })
    const out = await g.summarize(SAMPLE_BODY)
    expect(out).toContain('first sentence')
  })
})

describe('bodyHash + generateTldrStamp', () => {
  it('hashes deterministically; same body → same hash', () => {
    expect(bodyHash('hello')).toBe(bodyHash('hello'))
    expect(bodyHash('hello').length).toBe(16)
    expect(bodyHash('hello')).not.toBe(bodyHash('hello!'))
  })

  it('stamp carries summary, hash, and timestamp', async () => {
    const g = heuristicTldrGenerator()
    const stamp = await generateTldrStamp(g, SAMPLE_BODY)
    expect(stamp.summary_tldr.length).toBeGreaterThan(0)
    expect(stamp.summary_tldr_body_hash).toBe(bodyHash(SAMPLE_BODY))
    expect(stamp.summary_tldr_generated_at).toMatch(/^20\d{2}-\d{2}-\d{2}T/)
  })
})

// ─── End-to-end against MemoryStore (V1, V2, V5) ──────────────────────────

describe('MemoryStore retain() + recall() with summary_tldr', () => {
  let cleanup: string[] = []

  beforeEach(() => {
    cleanup = []
  })

  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  async function withStore() {
    const root = await mkdtemp(join(tmpdir(), 'gks-tldr-'))
    cleanup.push(root)
    await mkdir(join(root, 'gks'), { recursive: true })
    await cp(FIXTURES, join(root, 'gks'), { recursive: true })
    const store = new MemoryStore({ root, embedder: mockEmbedder(64) })
    await store.init()
    return { store, root }
  }

  it('V1: retain(generateTldr:true) populates summary_tldr; recall returns it as snippet', async () => {
    const { store } = await withStore()
    const longBody =
      'The bi-temporal resolver in GKS marks superseded docs by setting valid_to ' +
      'to the moment a contradicting fact was retained. The old doc stays in the ' +
      'store but recall filters it out by default. This preserves audit trail.'
    await retain(store, {
      content: longBody,
      metadata: { path: 'tldr-fact.md', title: 'Bi-temporal Audit Trail' },
      generateTldr: true,
    })

    const res = await recall(store, 'bi-temporal audit trail superseded', {
      topK: 3,
      scoreThreshold: -1,
    })
    const hit = res.hits.find((h) => h.path === 'tldr-fact.md')
    expect(hit).toBeDefined()
    // Heuristic TLDR keeps the first sentences — should contain "bi-temporal"
    expect(hit!.snippet.toLowerCase()).toContain('bi-temporal')
    // metadata.summary_tldr should be present (vector hits expose metadata)
    expect(hit!.metadata?.['summary_tldr']).toBeDefined()
  })

  it('V2: recall falls back to body excerpt when summary_tldr is absent', async () => {
    const { store } = await withStore()
    await retain(store, {
      content: 'No TLDR here. Just a body that should still be retrievable.',
      metadata: { path: 'no-tldr.md', title: 'No TLDR' },
      // generateTldr omitted → no summary_tldr field
    })
    const res = await recall(store, 'no tldr body retrievable', {
      topK: 3,
      scoreThreshold: -1,
    })
    const hit = res.hits.find((h) => h.path === 'no-tldr.md')
    expect(hit).toBeDefined()
    expect(hit!.metadata?.['summary_tldr']).toBeUndefined()
    expect(hit!.snippet.length).toBeGreaterThan(0)
    expect(hit!.snippet.toLowerCase()).toContain('body')
  })

  it('V5: recall snippetMaxChars cap still wins over the TLDR length', async () => {
    const { store } = await withStore()
    const body = 'A. '.repeat(120) + 'End sentence with marker XYZ.'
    await retain(store, {
      content: body,
      metadata: { path: 'long-tldr.md', title: 'Long TLDR' },
      generateTldr: true,
    })
    const res = await recall(store, 'marker XYZ', {
      topK: 3,
      scoreThreshold: -1,
      snippetMaxChars: 40,
    })
    const hit = res.hits.find((h) => h.path === 'long-tldr.md')
    expect(hit).toBeDefined()
    expect(hit!.snippet.length).toBeLessThanOrEqual(40)
    // Index-only mode (snippetMaxChars=0) prefers title over TLDR.
    const idxRes = await recall(store, 'marker XYZ', {
      topK: 3,
      scoreThreshold: -1,
      snippetMaxChars: 0,
    })
    const idxHit = idxRes.hits.find((h) => h.path === 'long-tldr.md')
    expect(idxHit!.snippet).toBe('Long TLDR')
  })
})

// ─── End-to-end against InboundQueue.promote() (V6, V7) ──────────────────

describe('InboundQueue.promote() with --generate-tldr', () => {
  let cleanup: string[] = []

  beforeEach(() => {
    cleanup = []
  })

  afterEach(async () => {
    for (const d of cleanup) await rm(d, { recursive: true, force: true })
  })

  async function withStore() {
    const root = await mkdtemp(join(tmpdir(), 'gks-tldr-promote-'))
    cleanup.push(root)
    await mkdir(join(root, 'gks'), { recursive: true })
    await cp(FIXTURES, join(root, 'gks'), { recursive: true })
    const store = new MemoryStore({ root, embedder: mockEmbedder(64) })
    await store.init()
    return { store, root }
  }

  it('V6: promote(generateTldr:true) stamps frontmatter into the canonical file', async () => {
    const { store, root } = await withStore()
    await store.proposeInbound({
      proposed_id: 'INSIGHT--PROMOTE-TLDR',
      phase: 1,
      type: 'insight',
      title: 'Promote TLDR Insight',
      body:
        'This insight asserts that promoting an inbound atom with --generate-tldr ' +
        'produces a populated summary_tldr field in the canonical gks/<type>/ file.',
    })
    const res = await store.inbound.promote('INSIGHT--PROMOTE-TLDR', {
      generateTldr: true,
      tldrGenerator: heuristicTldrGenerator(),
      vaultId: 'default',
    })
    const md = await readFile(res.dest, 'utf8')
    expect(md).toMatch(/summary_tldr:/)
    expect(md).toMatch(/summary_tldr_body_hash:/)
    expect(md).toMatch(/summary_tldr_generated_at:/)
    expect(md).toContain('promoting an inbound atom')
    // Cleanup the gks/<type>/ file we created so it doesn't leak between tests.
    await rm(join(root, 'gks', 'insight'), { recursive: true, force: true })
  })

  it('V6b: promote(generateTldr:true) without tldrGenerator throws', async () => {
    const { store } = await withStore()
    await store.proposeInbound({
      proposed_id: 'INSIGHT--MISSING-GEN',
      phase: 1,
      type: 'insight',
      title: 'Missing Generator',
      body: 'No generator was supplied; promote should refuse.',
    })
    await expect(
      store.inbound.promote('INSIGHT--MISSING-GEN', { generateTldr: true }),
    ).rejects.toThrow(/requires tldrGenerator/)
  })

  it('V7: rebuilt atomic_index.jsonl carries summary_tldr fields', async () => {
    const { store, root } = await withStore()
    await store.proposeInbound({
      proposed_id: 'INSIGHT--INDEX-CARRIES-TLDR',
      phase: 1,
      type: 'insight',
      title: 'Index Carries TLDR',
      body:
        'When the indexer runs over a promoted atom that has summary_tldr in ' +
        'frontmatter, the resulting JSONL row must include those fields.',
    })
    await store.inbound.promote('INSIGHT--INDEX-CARRIES-TLDR', {
      generateTldr: true,
      tldrGenerator: heuristicTldrGenerator(),
      vaultId: 'default',
    })

    // Run the re-indexer programmatically (subprocess; same as `npm run msp:index`).
    const indexerScript = resolve(__dirname, '..', '..', 'scripts', 'msp', 're-indexer.ts')
    execFileSync('npx', ['tsx', indexerScript, `--root=${root}`], {
      stdio: 'pipe',
      env: { ...process.env },
    })

    const indexPath = join(root, 'gks', '00_index', 'atomic_index.jsonl')
    const indexText = await readFile(indexPath, 'utf8')
    const insightRow = indexText
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r['id'] === 'INSIGHT--INDEX-CARRIES-TLDR')

    expect(insightRow).toBeDefined()
    expect(typeof insightRow!['summary_tldr']).toBe('string')
    expect((insightRow!['summary_tldr'] as string).length).toBeGreaterThan(0)
    expect(typeof insightRow!['summary_tldr_body_hash']).toBe('string')
    expect(typeof insightRow!['summary_tldr_generated_at']).toBe('string')

    // Cleanup
    await rm(join(root, 'gks', 'insight'), { recursive: true, force: true })
  }, 30_000)
})

// ─── Staleness detection (V3, AC7) ────────────────────────────────────────

describe('--tldr-staleness', () => {
  it('bodyHash mismatches when the body is edited after stamping', async () => {
    const original = 'Original body sentence.'
    const stamp = await generateTldrStamp(heuristicTldrGenerator(), original)
    expect(stamp.summary_tldr_body_hash).toBe(bodyHash(original))
    const edited = original + ' New addition.'
    expect(stamp.summary_tldr_body_hash).not.toBe(bodyHash(edited))
  })

  it('end-to-end CLI: edit body → validate --tldr-staleness exits 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gks-stale-'))
    try {
      await mkdir(join(root, 'gks', 'insight'), { recursive: true })
      // Hand-write an atom with mismatched hash.
      const stalePath = join(root, 'gks', 'insight', 'INSIGHT--STALE-DEMO.md')
      const goodHash = bodyHash('A different body than what is on disk now.')
      await writeFile(
        stalePath,
        [
          '---',
          'id: INSIGHT--STALE-DEMO',
          'phase: 1',
          'type: insight',
          'status: stable',
          'vault_id: default',
          'title: Stale Demo',
          `summary_tldr: A summary that is now stale.`,
          `summary_tldr_body_hash: "${goodHash}"`,
          `summary_tldr_generated_at: "2026-04-30T10:00:00.000Z"`,
          '---',
          '',
          '# Stale Demo',
          '',
          'This is the actual body — it does NOT hash to the stored value.',
          '',
        ].join('\n'),
        'utf8',
      )
      // Index it.
      const indexerScript = resolve(__dirname, '..', '..', 'scripts', 'msp', 're-indexer.ts')
      execFileSync('npx', ['tsx', indexerScript, `--root=${root}`], { stdio: 'pipe' })

      // Run validate --tldr-staleness; expect exit 1.
      const cliScript = resolve(__dirname, '..', '..', 'bin', 'gks.ts')
      let exitCode = 0
      let stdout = ''
      try {
        stdout = execFileSync('npx', ['tsx', cliScript, 'validate', '--tldr-staleness', `--root=${root}`], {
          stdio: 'pipe',
          encoding: 'utf8',
        })
      } catch (err) {
        const e = err as { status?: number; stdout?: string }
        exitCode = e.status ?? 1
        stdout = e.stdout ?? ''
      }
      expect(exitCode).toBe(1)
      expect(stdout).toContain('STALE')
      expect(stdout).toContain('INSIGHT--STALE-DEMO')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
