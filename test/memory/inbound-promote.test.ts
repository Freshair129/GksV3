/**
 * InboundQueue.list / readById / promote tests (ADR-014 item 5 follow-up).
 *
 * Promotion is the missing piece WORKFLOW.md and ONBOARDING.md have been
 * documenting all along — these tests pin its contract:
 *   • list() returns one row per inbound file, sorted by proposed_at
 *   • promote() moves the file to gks/<type>/<id>.md, strips review
 *     metadata, sets status: stable, drops the auto-prepended title H1
 *   • promote() refuses if gks/<type>/<id>.md already exists (unless force)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InboundQueue } from '../../src/memory/inbound.js'
import type { InboundArtifact } from '../../src/memory/types.js'

describe('InboundQueue list / promote', () => {
  let root = ''
  let inbound: InboundQueue

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-inbound-promote-'))
    await mkdir(join(root, 'gks'), { recursive: true })
    inbound = new InboundQueue({
      inboundDir: join(root, 'inbound'),
      gksRoot: join(root, 'gks'),
    })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function adrArtifact(slug: string): InboundArtifact {
    return {
      proposed_id: `ADR--${slug}`,
      phase: 2,
      type: 'adr',
      title: slug.toLowerCase(),
      body: `# ADR — ${slug.toLowerCase()}\n\n## Context\n\nplaceholder\n`,
    }
  }

  it('list() returns one entry per inbound file, sorted by proposed_at', async () => {
    await inbound.propose(adrArtifact('A-FIRST'))
    await new Promise((r) => setTimeout(r, 5))
    await inbound.propose(adrArtifact('B-SECOND'))
    const rows = await inbound.list()
    expect(rows.map((r) => r.proposed_id)).toEqual(['ADR--A-FIRST', 'ADR--B-SECOND'])
    expect(rows[0]!.type).toBe('adr')
  })

  it('readById() returns text + path for an existing candidate', async () => {
    await inbound.propose(adrArtifact('READ'))
    const found = await inbound.readById('ADR--READ')
    expect(found).not.toBeNull()
    expect(found!.text).toContain('proposed_id: ADR--READ')
    expect(found!.path).toContain('ADR--READ')
  })

  it('promote() moves to gks/<type>/<id>.md with stripped review metadata', async () => {
    await inbound.propose(adrArtifact('P1'))
    const r = await inbound.promote('ADR--P1')
    expect(r.dest).toBe(join(root, 'gks', 'adr', 'ADR--P1.md'))
    const text = await readFile(r.dest, 'utf8')
    expect(text).toContain('id: ADR--P1')
    expect(text).toContain('status: stable')
    expect(text).not.toContain('proposed_id:')
    expect(text).not.toContain('review_id:')
    expect(text).not.toContain('proposed_at:')
    // Body keeps the descriptive H1, not the auto-prepended title H1.
    expect(text).toMatch(/\n#\s+ADR\s+—\s+p1\b/)
    // Inbound file is gone after promotion.
    await expect(stat(r.source)).rejects.toThrow()
    expect((await inbound.list()).length).toBe(0)
  })

  it('promote() refuses to overwrite an existing destination unless force=true', async () => {
    await inbound.propose(adrArtifact('OVER'))
    await mkdir(join(root, 'gks', 'adr'), { recursive: true })
    await writeFile(join(root, 'gks', 'adr', 'ADR--OVER.md'), 'existing\n')
    await expect(inbound.promote('ADR--OVER')).rejects.toThrow(/already exists/)
    // With force=true, it goes through (and we re-propose since the first
    // attempt didn't delete the inbound file because it threw).
    await inbound.promote('ADR--OVER', { force: true })
    const text = await readFile(join(root, 'gks', 'adr', 'ADR--OVER.md'), 'utf8')
    expect(text).toContain('id: ADR--OVER')
  })

  it('promote() rejects when the candidate id is missing', async () => {
    await expect(inbound.promote('ADR--GHOST')).rejects.toThrow(/no inbound candidate/)
  })

  it('promote() preserves crosslinks + linked_symbols + tags when present', async () => {
    await inbound.propose({
      proposed_id: 'ADR--CROSSY',
      phase: 2,
      type: 'adr',
      title: 'crossy',
      body: '# ADR — crossy\n\nbody\n',
      linked_symbols: [{ file: 'src/x.ts', fn: 'doIt' }],
    })
    const r = await inbound.promote('ADR--CROSSY')
    const text = await readFile(r.dest, 'utf8')
    expect(text).toContain('linked_symbols:')
    expect(text).toContain('src/x.ts')
  })
})
