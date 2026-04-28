/**
 * HotfixStore — file-backed log of hotfix escape-hatch atoms (ADR-014, §6.4).
 *
 * Mirrors IssueStore conventions: read file → parse → mutate → render →
 * atomic write → audit. Hotfixes mutate rarely (open / close), so the API
 * is narrower than IssueStore.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { AuditLog } from '../memory/audit.js'
import { yamlLite } from '../lib/yaml-lite.js'
import { createLogger } from '../lib/logger.js'
import {
  HOTFIX_BACKFILL_MS,
  isOverdue,
  makeHotfixId,
  validateHotfix,
  type Hotfix,
  type HotfixMeta,
} from './types.js'

const log = createLogger('hotfix:store')

export interface HotfixStoreOptions {
  root?: string
  hotfixDir?: string
  audit?: AuditLog | null
}

export interface OpenHotfixArgs {
  commitSha: string
  title: string
  files?: string[]            // file paths the hotfix touched (becomes linked_symbols)
  reason?: string
  ref?: string
  relatedIncidents?: string[]
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function plusMsIso(base: Date, ms: number): string {
  return new Date(base.getTime() + ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function render(h: Hotfix, body: string): string {
  const fm: Record<string, unknown> = {
    id: h.id,
    phase: h.phase,
    type: h.type,
    status: h.status,
    title: h.title,
    created_at: h.created_at,
    valid_from: h.valid_from,
    valid_to: h.valid_to,
  }
  if (h.closed_at) fm['closed_at'] = h.closed_at
  if (h.linked_symbols && h.linked_symbols.length > 0) fm['linked_symbols'] = h.linked_symbols
  if (h.crosslinks) {
    const cl: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(h.crosslinks)) {
      if (Array.isArray(v) && v.length > 0) cl[k] = v
    }
    if (Object.keys(cl).length > 0) fm['crosslinks'] = cl
  }
  fm['meta'] = h.meta
  return `---\n${yamlLite(fm)}\n---\n\n${body}`
}

function defaultBody(h: Hotfix): string {
  return [
    `# HOTFIX — ${h.title}`,
    '',
    '## Why this exists',
    '',
    `Hotfix shipped at ${h.valid_from}. Master-spec §6.4 / ADR-014 require P1–P3`,
    `backfill atoms before ${h.valid_to}, after which pre-commit blocks further`,
    `changes to the affected files.`,
    '',
    '## Backfill checklist',
    '',
    '- [ ] `CONCEPT--<NAME>` written and `stable`',
    `- [ ] \`ADR--<NAME>\` written and \`stable\` (with \`crosslinks.resolves: [${h.id}]\`)`,
    '- [ ] `BLUEPRINT--<NAME>` written and `stable`',
    '',
  ].join('\n')
}

function parseFile(text: string): { fm: Record<string, unknown>; body: string } {
  if (!text.startsWith('---')) throw new Error('HotfixStore: missing frontmatter')
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error('HotfixStore: unterminated frontmatter')
  const parsed = parseYaml(text.slice(3, end).trim())
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('HotfixStore: frontmatter is not an object')
  }
  let bodyStart = end + 4
  while (text[bodyStart] === '\n') bodyStart++
  return { fm: parsed as Record<string, unknown>, body: text.slice(bodyStart) }
}

function fmToHotfix(fm: Record<string, unknown>): Hotfix {
  return fm as unknown as Hotfix
}

export class HotfixStore {
  private readonly dir: string
  private readonly audit: AuditLog | null

  constructor(opts: HotfixStoreOptions = {}) {
    this.dir = opts.hotfixDir ?? join(opts.root ?? process.cwd(), 'gks', 'hotfix')
    this.audit = opts.audit ?? null
  }

  async open(args: OpenHotfixArgs): Promise<Hotfix> {
    const id = makeHotfixId(args.commitSha)
    const now = new Date()
    const valid_from = nowIso()
    const valid_to = plusMsIso(now, HOTFIX_BACKFILL_MS)
    const hotfix: Hotfix = {
      id,
      phase: 5,
      type: 'hotfix',
      status: 'stable',
      title: args.title,
      created_at: valid_from,
      valid_from,
      valid_to,
      meta: {
        commit_sha: args.commitSha,
        ...(args.ref ? { ref: args.ref } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
      } as HotfixMeta,
    }
    if (args.files && args.files.length > 0) {
      hotfix.linked_symbols = args.files.map((file) => ({ file }))
    }
    if (args.relatedIncidents && args.relatedIncidents.length > 0) {
      hotfix.crosslinks = { related_incidents: args.relatedIncidents }
    }

    const result = validateHotfix(hotfix)
    if (!result.valid) throw new Error(`invalid hotfix: ${result.errors.join('; ')}`)

    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, `${id}.md`)
    await writeFile(path, render(hotfix, defaultBody(hotfix)), 'utf8')

    if (this.audit) {
      await this.audit.emit({
        op: 'hotfix_open',
        doc_id: id,
        meta: { commit_sha: args.commitSha, valid_to, files: args.files ?? [] },
      })
    }
    log.info('hotfix opened', { id, valid_to })
    return hotfix
  }

  async list(): Promise<Hotfix[]> {
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: Hotfix[] = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const text = await readFile(join(this.dir, name), 'utf8')
      const { fm } = parseFile(text)
      out.push(fmToHotfix(fm))
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  async listOverdue(now: Date = new Date()): Promise<Hotfix[]> {
    const all = await this.list()
    return all.filter((h) => isOverdue(h, now))
  }

  async close(id: string, resolvedBy: string[]): Promise<Hotfix> {
    const path = join(this.dir, `${id}.md`)
    const text = await readFile(path, 'utf8')
    const { fm, body } = parseFile(text)
    const hotfix = fmToHotfix(fm)
    hotfix.closed_at = nowIso()
    hotfix.crosslinks = {
      ...(hotfix.crosslinks ?? {}),
      resolved_by: [...new Set([...(hotfix.crosslinks?.resolved_by ?? []), ...resolvedBy])],
    }
    await writeFile(path, render(hotfix, body), 'utf8')
    if (this.audit) {
      await this.audit.emit({
        op: 'hotfix_close',
        doc_id: id,
        meta: { resolved_by: hotfix.crosslinks.resolved_by },
      })
    }
    return hotfix
  }
}

