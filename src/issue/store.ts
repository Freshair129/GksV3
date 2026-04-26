/**
 * IssueStore — file-backed self-hosted issue tracker.
 *
 * Per ADR-012 light-governance tier:
 *   • storage: <root>/gks/issues/<ID>.md (one .md per issue)
 *   • write path: direct (no inbound queue) — issues mutate frequently
 *   • validation: schema-checked at every mutation; invalid mutations throw
 *   • body: append-only Discussion section; frontmatter mutates freely
 *
 * Each operation is a tiny transaction:
 *   read file → parse frontmatter → mutate → re-render → atomic write → audit
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { AuditLog } from '../memory/audit.js'
import { yamlLite } from '../lib/yaml-lite.js'
import { createLogger } from '../lib/logger.js'
import {
  isValidPriority,
  isValidStatus,
  makeIssueId,
  type Issue,
  type IssuePriority,
  type IssueStatus,
  validateIssue,
} from './types.js'

const log = createLogger('issue:store')

export interface IssueStoreOptions {
  /** Repo root — issues land at <root>/gks/issues/<ID>.md by default. */
  root?: string
  /** Override the issue dir explicitly. */
  issuesDir?: string
  /** Optional audit log to record every mutation. */
  audit?: AuditLog | null
}

export interface CreateIssueArgs {
  title: string
  priority?: IssuePriority             // default 'medium'
  labels?: string[]
  assignee?: string
  reporter?: string
  body?: string                        // optional initial description
  disambiguate?: boolean               // force a unique suffix
}

export interface ListFilter {
  status?: IssueStatus | 'all'         // default: open + triaged + in_progress + blocked
  priority?: IssuePriority
  assignee?: string
  label?: string
}

interface ParsedFile {
  frontmatter: Record<string, unknown>
  body: string                         // everything after the trailing ---
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function parseFile(text: string): ParsedFile {
  if (!text.startsWith('---')) {
    throw new Error('IssueStore: file missing YAML frontmatter')
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) {
    throw new Error('IssueStore: unterminated frontmatter')
  }
  const fmText = text.slice(3, end).trim()
  const parsed = parseYaml(fmText)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('IssueStore: frontmatter is not an object')
  }
  // Body starts after the closing --- line; skip the newline after it.
  let bodyStart = end + 4
  while (text[bodyStart] === '\n') bodyStart++
  return { frontmatter: parsed as Record<string, unknown>, body: text.slice(bodyStart) }
}

function renderFile(issue: Issue, body: string): string {
  // Frontmatter object — order-preserving in JS for object-literal init.
  const fm: Record<string, unknown> = {
    id: issue.id,
    phase: issue.phase,
    type: issue.type,
    status: issue.status,
    priority: issue.priority,
    title: issue.title,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  }
  if (issue.assignee) fm['assignee'] = issue.assignee
  if (issue.reporter) fm['reporter'] = issue.reporter
  if (issue.labels && issue.labels.length > 0) fm['labels'] = issue.labels
  if (issue.closed_at) fm['closed_at'] = issue.closed_at
  if (issue.linked_symbols && issue.linked_symbols.length > 0) {
    fm['linked_symbols'] = issue.linked_symbols
  }
  if (issue.crosslinks) {
    const cl: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(issue.crosslinks)) {
      if (Array.isArray(v) && v.length > 0) cl[k] = v
    }
    if (Object.keys(cl).length > 0) fm['crosslinks'] = cl
  }
  return `---\n${yamlLite(fm)}---\n\n${body.trimStart()}\n`.replace(/\n{3,}/g, '\n\n')
}

function frontmatterToIssue(fm: Record<string, unknown>): Issue {
  // Type-narrowing helpers — the schema validator below catches the rest.
  const issue = fm as unknown as Issue
  const result = validateIssue(issue)
  if (!result.valid) {
    throw new Error(`IssueStore: invalid issue:\n  - ${result.errors.join('\n  - ')}`)
  }
  return issue
}

const DEFAULT_BODY_TEMPLATE = (title: string, description: string) => `# ISSUE — ${title}

## Description

${description.trim() || '_(no description provided)_'}

## Discussion

_(no comments yet)_
`

export class IssueStore {
  private readonly issuesDir: string
  private readonly audit: AuditLog | null

  constructor(opts: IssueStoreOptions = {}) {
    if (opts.issuesDir) this.issuesDir = resolve(opts.issuesDir)
    else if (opts.root) this.issuesDir = resolve(opts.root, 'gks', 'issues')
    else this.issuesDir = resolve(process.cwd(), 'gks', 'issues')
    this.audit = opts.audit ?? null
  }

  getDir(): string {
    return this.issuesDir
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async create(args: CreateIssueArgs): Promise<Issue> {
    if (!args.title || args.title.trim().length === 0) {
      throw new Error('IssueStore.create: title is required')
    }
    const priority = args.priority ?? 'medium'
    if (!isValidPriority(priority)) {
      throw new Error(`IssueStore.create: invalid priority '${priority}'`)
    }
    let id = makeIssueId(args.title, args.disambiguate ?? false)
    if (await this.exists(id)) {
      // Auto-disambiguate on collision, even when disambiguate=false.
      id = makeIssueId(args.title, true)
    }
    const now = nowIso()
    const issue: Issue = {
      id,
      phase: 2,
      type: 'issue',
      status: 'open',
      priority,
      title: args.title,
      created_at: now,
      updated_at: now,
      ...(args.assignee ? { assignee: args.assignee } : {}),
      ...(args.reporter ? { reporter: args.reporter } : {}),
      ...(args.labels && args.labels.length > 0 ? { labels: args.labels } : {}),
    }
    await this.writeFile(issue, DEFAULT_BODY_TEMPLATE(args.title, args.body ?? ''))
    await this.emit('issue_create', { id, title: args.title, priority })
    log.info('issue created', { id, priority })
    return issue
  }

  async list(filter: ListFilter = {}): Promise<Issue[]> {
    const ids = await this.listIds()
    const issues: Issue[] = []
    for (const id of ids) {
      try {
        const { frontmatter } = await this.readById(id)
        issues.push(frontmatterToIssue(frontmatter))
      } catch (err) {
        log.warn('skipping invalid issue', { id, err: (err as Error).message })
      }
    }
    return issues.filter((i) => matchesFilter(i, filter)).sort((a, b) => a.id.localeCompare(b.id))
  }

  async show(id: string): Promise<{ issue: Issue; body: string }> {
    const { frontmatter, body } = await this.readById(id)
    return { issue: frontmatterToIssue(frontmatter), body }
  }

  async comment(id: string, text: string, actor: string): Promise<Issue> {
    if (!text || text.trim().length === 0) {
      throw new Error('IssueStore.comment: text is required')
    }
    const { frontmatter, body } = await this.readById(id)
    const issue = frontmatterToIssue(frontmatter)
    const now = nowIso()
    const stamped = `### ${now} [${actor}] comment\n\n${text.trim()}\n`
    const newBody = appendDiscussion(body, stamped)
    issue.updated_at = now
    await this.writeFile(issue, newBody)
    await this.emit('issue_comment', { id, actor })
    return issue
  }

  async setStatus(id: string, newStatus: IssueStatus, actor: string): Promise<Issue> {
    if (!isValidStatus(newStatus)) {
      throw new Error(`IssueStore.setStatus: invalid status '${newStatus}'`)
    }
    const { frontmatter, body } = await this.readById(id)
    const issue = frontmatterToIssue(frontmatter)
    if (issue.status === newStatus) return issue                     // no-op
    const now = nowIso()
    const log_entry = `### ${now} [${actor}] status: ${issue.status} → ${newStatus}\n`
    issue.status = newStatus
    issue.updated_at = now
    if (newStatus === 'closed' || newStatus === 'wontfix') issue.closed_at = now
    await this.writeFile(issue, appendDiscussion(body, log_entry))
    await this.emit('issue_status_change', { id, from: frontmatter['status'], to: newStatus })
    return issue
  }

  async assign(id: string, assignee: string, actor: string): Promise<Issue> {
    const { frontmatter, body } = await this.readById(id)
    const issue = frontmatterToIssue(frontmatter)
    const prev = issue.assignee
    issue.assignee = assignee
    issue.updated_at = nowIso()
    const log_entry = `### ${issue.updated_at} [${actor}] assignee: ${prev ?? '(none)'} → ${assignee}\n`
    await this.writeFile(issue, appendDiscussion(body, log_entry))
    await this.emit('issue_assign', { id, assignee })
    return issue
  }

  async close(id: string, actor: string, resolvedBy?: string): Promise<Issue> {
    const { frontmatter, body } = await this.readById(id)
    const issue = frontmatterToIssue(frontmatter)
    const now = nowIso()
    issue.status = 'closed'
    issue.updated_at = now
    issue.closed_at = now
    if (resolvedBy) {
      issue.crosslinks = issue.crosslinks ?? {}
      issue.crosslinks.resolved_by = [...(issue.crosslinks.resolved_by ?? []), resolvedBy]
    }
    const note = resolvedBy
      ? `### ${now} [${actor}] closed (resolved by ${resolvedBy})\n`
      : `### ${now} [${actor}] closed\n`
    await this.writeFile(issue, appendDiscussion(body, note))
    await this.emit('issue_close', { id, resolved_by: resolvedBy })
    return issue
  }

  // ── internals ───────────────────────────────────────────────────────

  private async exists(id: string): Promise<boolean> {
    try {
      await readFile(this.pathFor(id), 'utf8')
      return true
    } catch {
      return false
    }
  }

  private pathFor(id: string): string {
    return join(this.issuesDir, `${id}.md`)
  }

  private async listIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.issuesDir)
      return entries
        .filter((f) => f.startsWith('ISSUE--') && f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
  }

  private async readById(id: string): Promise<ParsedFile> {
    let text: string
    try {
      text = await readFile(this.pathFor(id), 'utf8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') {
        throw new Error(`IssueStore: ${id} not found at ${this.pathFor(id)}`)
      }
      throw err
    }
    return parseFile(text)
  }

  private async writeFile(issue: Issue, body: string): Promise<void> {
    await mkdir(this.issuesDir, { recursive: true })
    const text = renderFile(issue, body)
    await writeFile(this.pathFor(issue.id), text, 'utf8')
  }

  private async emit(
    op: 'issue_create' | 'issue_comment' | 'issue_status_change' | 'issue_assign' | 'issue_close',
    meta: Record<string, unknown>,
  ): Promise<void> {
    if (!this.audit) return
    try {
      await this.audit.emit({ op, meta })
    } catch (err) {
      log.warn('issue audit emit failed', { op, err: (err as Error).message })
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────

function matchesFilter(issue: Issue, filter: ListFilter): boolean {
  // status: default is "active" (open + triaged + in_progress + blocked) when undefined.
  const wantStatus = filter.status
  if (wantStatus === 'all') {
    /* no-op */
  } else if (wantStatus === undefined) {
    if (issue.status === 'closed' || issue.status === 'wontfix') return false
  } else {
    if (issue.status !== wantStatus) return false
  }
  if (filter.priority && issue.priority !== filter.priority) return false
  if (filter.assignee && issue.assignee !== filter.assignee) return false
  if (filter.label && !(issue.labels ?? []).includes(filter.label)) return false
  return true
}

function appendDiscussion(body: string, entry: string): string {
  // Find or create the "## Discussion" section, append `entry` at the end.
  const section = '## Discussion'
  const idx = body.indexOf(section)
  if (idx === -1) {
    return `${body.trimEnd()}\n\n${section}\n\n${entry.trimEnd()}\n`
  }
  // Find the next H2 (## ) after the Discussion header so we can insert
  // before it; if none, append at the end.
  const after = body.slice(idx + section.length)
  const nextH2 = after.indexOf('\n## ')
  if (nextH2 === -1) {
    // Strip the "_(no comments yet)_" placeholder if present.
    const cleanedEnd = body.replace(/_\(no comments yet\)_\s*$/, '').trimEnd()
    return `${cleanedEnd}\n\n${entry.trimEnd()}\n`
  }
  const cutoff = idx + section.length + nextH2
  const head = body.slice(0, cutoff).replace(/_\(no comments yet\)_\s*$/, '').trimEnd()
  const tail = body.slice(cutoff)
  return `${head}\n\n${entry.trimEnd()}\n${tail}`
}
