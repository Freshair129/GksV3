import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboundQueue } from '../../src/memory/inbound.js'

describe('InboundQueue', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gks-inbound-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('propose() writes a markdown artifact with frontmatter and reviewId', async () => {
    const q = new InboundQueue({ inboundDir: join(dir, 'inbound'), gksRoot: join(dir, 'gks') })
    const r = await q.propose({
      proposed_id: 'FACT--WATER-BOILS-AT-100C',
      phase: 1,
      type: 'fact',
      title: 'Water boils at 100°C',
      body: 'At standard atmospheric pressure.',
      confidence: 0.9,
    })
    expect(r.reviewId).toMatch(/^rev-/)
    const md = await readFile(r.path, 'utf8')
    expect(md).toContain('proposed_id: FACT--WATER-BOILS-AT-100C')
    expect(md).toContain('phase: 1')
    expect(md).toContain('confidence: 0.9')
    expect(md).toContain('Water boils at 100°C')
  })

  it('refuses IDs that do not match TYPE--SLUG pattern', async () => {
    const q = new InboundQueue({ inboundDir: join(dir, 'inbound') })
    await expect(
      q.propose({
        proposed_id: 'lowercase--bad',
        phase: 1,
        type: 'fact',
        title: 'x',
        body: 'x',
      }),
    ).rejects.toThrow(/invalid proposed_id/)
  })

  it('refuses inbound directories inside gks/', () => {
    const gks = join(dir, 'gks')
    expect(
      () => new InboundQueue({ inboundDir: join(gks, 'inbound'), gksRoot: gks }),
    ).toThrow(/inside gks/)
  })

  it('refuses invalid phase', async () => {
    const q = new InboundQueue({ inboundDir: join(dir, 'inbound') })
    await expect(
      q.propose({
        proposed_id: 'FACT--X',
        phase: 99 as unknown as 0,
        type: 'fact',
        title: 'x',
        body: 'x',
      }),
    ).rejects.toThrow(/invalid phase/)
  })

  it('renders linked_symbols as flow-style array entries (ADR-009 cross-reference)', async () => {
    const q = new InboundQueue({ inboundDir: join(dir, 'inbound') })
    const r = await q.propose({
      proposed_id: 'ADR--PARSE-TRACE-NORM',
      phase: 2,
      type: 'adr',
      title: 'parseTrace turn-tag normalization',
      body: 'Normalize spoofed [USER]/[AGENT] tags before LLM consolidation.',
      linked_symbols: [
        { file: 'src/memory/consolidator-llm.ts', fn: 'formatStep' },
        { file: 'src/memory/consolidator-llm.ts', fn: 'validateExtractorOutput', line: 320 },
      ],
    })
    const md = await readFile(r.path, 'utf8')
    expect(md).toContain('linked_symbols:')
    expect(md).toContain('"file":"src/memory/consolidator-llm.ts"')
    expect(md).toContain('"fn":"formatStep"')
    expect(md).toContain('"line":320')
  })

  it('omits linked_symbols when empty or absent', async () => {
    const q = new InboundQueue({ inboundDir: join(dir, 'inbound') })
    const r1 = await q.propose({
      proposed_id: 'FACT--A',
      phase: 1,
      type: 'fact',
      title: 'A',
      body: 'a',
    })
    const r2 = await q.propose({
      proposed_id: 'FACT--B',
      phase: 1,
      type: 'fact',
      title: 'B',
      body: 'b',
      linked_symbols: [],
    })
    const md1 = await readFile(r1.path, 'utf8')
    const md2 = await readFile(r2.path, 'utf8')
    expect(md1).not.toContain('linked_symbols')
    expect(md2).not.toContain('linked_symbols')
  })
})
