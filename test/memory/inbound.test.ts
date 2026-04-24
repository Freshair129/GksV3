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
})
