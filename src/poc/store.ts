/**
 * DRAFT — sketch for src/poc/store.ts
 * Lands here only if ADR--ADD-POC-PREFIX is accepted + promoted.
 *
 * PocStore — file-backed log of time-boxed POC atoms.
 *
 * Mirrors HotfixStore conventions: read file → parse → mutate → render →
 * atomic write → audit. POCs mutate slightly more than hotfixes
 * (open → running → close) but the API stays narrow.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { AuditLog } from '../memory/audit.js'
import type { LinkedSymbol } from '../memory/types.js'
import { yamlLite } from '../lib/yaml-lite.js'
import { createLogger } from '../lib/logger.js'
import {
  isOverdue,
  makePocId,
  validatePoc,
  type Poc,
  type PocStatus,
} from './types.js'

const log = createLogger('poc:store')

export interface PocStoreOptions {
  root?: string
  pocDir?: string
  audit?: AuditLog | null
}

export interface OpenPocArgs {
  slug: string                     // becomes POC--<SLUG>
  title: string
  hypothesis: string
  acceptanceCriteria: string[]
  deadline: string                 // ISO-8601 UTC — REQUIRED, no default
  files?: string[]                 // experiment code paths → linked_symbols
  derivesFrom?: string[]           // CONCEPT-- ids
}

export interface ClosePocArgs {
  resolution: 'validated' | 'invalidated' | 'abandoned'
  feedsInto?: string[]             // ADR-- ids the result informs
  produces?: string[]              // BLUEPRINT-- / AUDIT-- ids the POC produced
  notes?: string                   // appended to body under ## Result
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function render(p: Poc, body: string): string {
  const fm: Record<string, unknown> = {
    id: p.id,
    phase: p.phase,
    type: p.type,
    status: p.status,
    title: p.title,
    hypothesis: p.hypothesis,
    acceptance_criteria: p.acceptance_criteria,
    time_box: p.time_box,
  }
  if (p.linked_symbols && p.linked_symbols.length > 0) fm['linked_symbols'] = p.linked_symbols
  if (p.crosslinks) {
    const cl: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(p.crosslinks)) {
      if (Array.isArray(v) && v.length > 0) cl[k] = v
    }
    if (Object.keys(cl).length > 0) fm['crosslinks'] = cl
  }
  return `---\n${yamlLite(fm)}\n---\n\n${body}`
}

function defaultBody(p: Poc): string {
  const criteria = p.acceptance_criteria.map((c) => `- [ ] ${c}`).join('\n')
  return [
    `# POC — ${p.title}`,
    '',
    '## Hypothesis',
    '',
    p.hypothesis,
    '',
    '## Acceptance criteria',
    '',
    criteria,
    '',
    '## Time box',
    '',
    `- Opened: ${p.time_box.opened_at}`,
    `- Deadline: ${p.time_box.deadline}`,
    `- Closed: (filled at close)`,
    '',
    '## Result',
    '',
    '(Filled at closure.)',
    '',
  ].join('\n')
}

function parseFile(text: string): { fm: Record<string, unknown>; body: string } {
  if (!text.startsWith('---')) throw new Error('PocStore: missing frontmatter')
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error('PocStore: unterminated frontmatter')
  const parsed = parseYaml(text.slice(3, end).trim())
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PocStore: frontmatter is not an object')
  }
  let bodyStart = end + 4
  while (text[bodyStart] === '\n') bodyStart++
  return { fm: parsed as Record<string, unknown>, body: text.slice(bodyStart) }
}

function fmToPoc(fm: Record<string, unknown>): Poc {
  return fm as unknown as Poc
}

export class PocStore {
  private readonly dir: string
  private readonly audit: AuditLog | null

  constructor(opts: PocStoreOptions = {}) {
    this.dir = opts.pocDir ?? join(opts.root ?? process.cwd(), 'gks', 'poc')
    this.audit = opts.audit ?? null
  }

  async open(args: OpenPocArgs): Promise<Poc> {
    const id = makePocId(args.slug)
    const opened_at = nowIso()
    const linked_symbols: LinkedSymbol[] | undefined =
      args.files && args.files.length > 0 ? args.files.map((file) => ({ file })) : undefined

    const poc: Poc = {
      id,
      phase: 1,
      type: 'poc',
      status: 'open',
      title: args.title,
      hypothesis: args.hypothesis,
      acceptance_criteria: args.acceptanceCriteria,
      time_box: { opened_at, deadline: args.deadline, closed_at: null },
      ...(linked_symbols ? { linked_symbols } : {}),
      ...(args.derivesFrom && args.derivesFrom.length > 0
        ? { crosslinks: { derives_from: args.derivesFrom } }
        : {}),
    }

    const result = validatePoc(poc)
    if (!result.valid) throw new Error(`invalid poc: ${result.errors.join('; ')}`)

    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, `${id}.md`)
    await writeFile(path, render(poc, defaultBody(poc)), 'utf8')

    if (this.audit) {
      await this.audit.emit({
        op: 'poc_open',
        doc_id: id,
        meta: { deadline: args.deadline, files: args.files ?? [] },
      })
    }
    log.info('poc opened', { id, deadline: args.deadline })
    return poc
  }

  async start(id: string): Promise<Poc> {
    const poc = await this.transition(id, 'running')
    if (this.audit) {
      await this.audit.emit({ op: 'poc_start', doc_id: id })
    }
    log.info('poc started', { id })
    return poc
  }

  async close(id: string, args: ClosePocArgs): Promise<Poc> {
    const path = join(this.dir, `${id}.md`)
    const text = await readFile(path, 'utf8')
    const { fm, body } = parseFile(text)
    const poc = fmToPoc(fm)

    poc.status = args.resolution
    poc.time_box = { ...poc.time_box, closed_at: nowIso() }
    poc.crosslinks = {
      ...(poc.crosslinks ?? {}),
      ...(args.feedsInto && args.feedsInto.length > 0
        ? {
            feeds_into: [
              ...new Set([...(poc.crosslinks?.feeds_into ?? []), ...args.feedsInto]),
            ],
          }
        : {}),
      ...(args.produces && args.produces.length > 0
        ? {
            produces: [
              ...new Set([...(poc.crosslinks?.produces ?? []), ...args.produces]),
            ],
          }
        : {}),
    }

    const result = validatePoc(poc)
    if (!result.valid) throw new Error(`invalid poc on close: ${result.errors.join('; ')}`)

    const updatedBody = args.notes
      ? body.replace(/## Result\s*\n\s*\(Filled at closure\.\)/, `## Result\n\n${args.notes}`)
      : body
    await writeFile(path, render(poc, updatedBody), 'utf8')

    if (this.audit) {
      await this.audit.emit({
        op: 'poc_close',
        doc_id: id,
        meta: {
          resolution: args.resolution,
          feeds_into: poc.crosslinks?.feeds_into ?? [],
        },
      })
    }
    log.info('poc closed', { id, resolution: args.resolution })
    return poc
  }

  async list(): Promise<Poc[]> {
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: Poc[] = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const text = await readFile(join(this.dir, name), 'utf8')
      const { fm } = parseFile(text)
      out.push(fmToPoc(fm))
    }
    return out.sort((a, b) => b.time_box.opened_at.localeCompare(a.time_box.opened_at))
  }

  async listOverdue(now: Date = new Date()): Promise<Poc[]> {
    const all = await this.list()
    return all.filter((p) => isOverdue(p, now))
  }

  /** Internal — used by start() and any future state transitions. */
  private async transition(id: string, status: PocStatus): Promise<Poc> {
    const path = join(this.dir, `${id}.md`)
    const text = await readFile(path, 'utf8')
    const { fm, body } = parseFile(text)
    const poc = fmToPoc(fm)
    poc.status = status
    const result = validatePoc(poc)
    if (!result.valid) {
      throw new Error(`invalid poc on transition to ${status}: ${result.errors.join('; ')}`)
    }
    await writeFile(path, render(poc, body), 'utf8')
    return poc
  }
}
