/**
 * Inbound queue — the ONLY authorized path to propose new atomic notes.
 *
 * Contract from BLUEPRINT--memory §write_rules:
 *   "NEVER write directly to gks/ folders → always via inbound queue"
 *
 * Flow:
 *   agent → proposeInbound() → .brain/msp/projects/evaAI/inbound/<id>.md
 *         → (human review, gks/scripts/promote.ts — not in scope for Phase 1)
 *         → gks/phase<N>/<type>/<slug>.md + atomic_index.jsonl update
 *
 * The write-protect on gks/ + the inbound-only API + the .brain/msp/...
 * default layout exist specifically to leave room for an MSP-shaped
 * Memory OS layer above this storage engine — see docs/MSP_RELATIONSHIP.md
 * before relaxing any of these constraints.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'
import type { InboundArtifact, InboundReceipt, Phase } from './types.js'
import { isAtomicId } from './atomic-id.js'
import { yamlLite } from '../lib/yaml-lite.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('inbound')

export interface InboundQueueOptions {
  inboundDir: string
  /** If this path is under `gks/`, proposeInbound will refuse. */
  gksRoot?: string
}

export class InboundQueue {
  private readonly inboundDir: string
  private readonly gksRoot: string | null

  constructor(opts: InboundQueueOptions) {
    this.inboundDir = resolve(opts.inboundDir)
    this.gksRoot = opts.gksRoot ? resolve(opts.gksRoot) : null

    if (this.gksRoot && this.inboundDir.startsWith(this.gksRoot)) {
      throw new Error(
        `InboundQueue: refusing to use a directory inside gks/ (${this.inboundDir}). ` +
          `Inbound must live OUTSIDE gks/ per write_rules.`,
      )
    }
  }

  async propose(artifact: InboundArtifact): Promise<InboundReceipt> {
    validateId(artifact.proposed_id)
    validatePhase(artifact.phase)

    await mkdir(this.inboundDir, { recursive: true })

    const reviewId = `rev-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const filename = `${artifact.proposed_id}.${reviewId}.md`
    const path = join(this.inboundDir, filename)

    const md = renderArtifactMarkdown(artifact, reviewId)
    await writeFile(path, md, 'utf8')

    log.info('inbound artifact queued', {
      proposed_id: artifact.proposed_id,
      reviewId,
      path,
    })

    return { path, reviewId }
  }

  async read(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  /**
   * List candidates currently waiting for review. Returns one entry per
   * inbound file with the parsed frontmatter — so callers can render a
   * dashboard or filter by type/age without re-parsing.
   */
  async list(): Promise<InboundCandidate[]> {
    let names: string[] = []
    try {
      names = await readdir(this.inboundDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const out: InboundCandidate[] = []
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const path = join(this.inboundDir, name)
      const text = await readFile(path, 'utf8')
      const parsed = parseInboundFile(text)
      if (!parsed) continue
      out.push({
        path,
        proposed_id: parsed.fm['proposed_id'] as string,
        review_id: parsed.fm['review_id'] as string,
        type: parsed.fm['type'] as string,
        phase: parsed.fm['phase'] as Phase,
        proposed_at: parsed.fm['proposed_at'] as string | undefined,
      })
    }
    return out.sort((a, b) => (a.proposed_at ?? '').localeCompare(b.proposed_at ?? ''))
  }

  /**
   * Read a single candidate by `proposed_id`. Returns the raw file text
   * (frontmatter + body). Throws if multiple files share the id (caller
   * is expected to delete duplicates or rename them).
   */
  async readById(proposedId: string): Promise<{ path: string; text: string } | null> {
    const candidates = await this.list()
    const matches = candidates.filter((c) => c.proposed_id === proposedId)
    if (matches.length === 0) return null
    if (matches.length > 1) {
      throw new Error(
        `InboundQueue: ${matches.length} candidates share proposed_id '${proposedId}'. ` +
          `Resolve manually before promoting.`,
      )
    }
    return { path: matches[0]!.path, text: await readFile(matches[0]!.path, 'utf8') }
  }

  /**
   * Promote a candidate from inbound to its canonical home in
   * `gks/<type>/<id>.md`. Strips review-only frontmatter
   * (`review_id`, `proposed_at`, `source_session`, `confidence`,
   * tenant/user/session/agent ids) and renames `proposed_id → id`. Sets
   * `status: 'stable'` unless the caller supplies an override. Body is
   * preserved verbatim. Re-indexing is the caller's job.
   *
   * Idempotency: if `gks/<type>/<id>.md` already exists, refuses unless
   * `force: true`.
   */
  async promote(
    proposedId: string,
    opts: PromoteOptions = {},
  ): Promise<PromoteResult> {
    if (!this.gksRoot) {
      throw new Error('InboundQueue: cannot promote without a gksRoot configured')
    }
    const found = await this.readById(proposedId)
    if (!found) throw new Error(`InboundQueue: no inbound candidate '${proposedId}'`)
    const parsed = parseInboundFile(found.text)
    if (!parsed) throw new Error(`InboundQueue: cannot parse inbound file ${found.path}`)

    const fm = parsed.fm
    const type = fm['type'] as string | undefined
    if (!type) throw new Error(`InboundQueue: candidate ${proposedId} missing 'type'`)

    const dest = join(this.gksRoot, type, `${proposedId}.md`)
    try {
      await readFile(dest)
      if (!opts.force) {
        throw new Error(
          `InboundQueue: ${dest} already exists. Pass --force to overwrite.`,
        )
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    const titleFromBody = parsed.body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim()

    const promoted: Record<string, unknown> = {
      id: proposedId,
      phase: fm['phase'],
      type,
      status: opts.status ?? 'stable',
      vault_id: opts.vaultId ?? 'default',
    }
    if (fm['title']) promoted['title'] = fm['title']
    else if (titleFromBody) promoted['title'] = titleFromBody
    for (const k of ['tags', 'crosslinks', 'linked_symbols', 'geography', 'created_at']) {
      if (fm[k] !== undefined) promoted[k] = fm[k]
    }
    if (!promoted['created_at']) promoted['created_at'] = new Date().toISOString()

    const out = `---\n${yamlLite(promoted)}---\n\n${parsed.body.trim()}\n`
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, out, 'utf8')
    await rm(found.path)

    log.info('inbound candidate promoted', { proposed_id: proposedId, dest })
    return { id: proposedId, source: found.path, dest }
  }
}

export interface InboundCandidate {
  path: string
  proposed_id: string
  review_id: string
  type: string
  phase: Phase
  proposed_at?: string
}

export interface PromoteOptions {
  /** Default 'stable'; override if reviewer wants to land as draft. */
  status?: string
  /** Default 'default'. */
  vaultId?: string
  /** Allow overwriting an existing gks/<type>/<id>.md. Default false. */
  force?: boolean
}

export interface PromoteResult {
  id: string
  source: string
  dest: string
}

function parseInboundFile(text: string): { fm: Record<string, unknown>; body: string } | null {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const fmText = text.slice(3, end).trim()
  let fm: unknown
  try {
    fm = parseYaml(fmText)
  } catch {
    return null
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return null
  let bodyStart = end + 4
  while (text[bodyStart] === '\n') bodyStart++
  let body = text.slice(bodyStart)
  // Strip the auto-appended "## Proposal Rationale" trailer added by propose().
  const idx = body.search(/\n## Proposal Rationale\b/)
  if (idx !== -1) body = body.slice(0, idx).trimEnd()
  // propose() prepends "# {title}\n\n" to the body. When the body already
  // contains its own H1 (scaffolder templates always do), promotion ends
  // up with two consecutive H1s. Drop the auto-prepended one so the
  // canonical atom keeps a single descriptive heading.
  const firstH1 = body.match(/^#\s+.+?\s*\n/)
  if (firstH1) {
    const remainder = body.slice(firstH1[0].length).trimStart()
    if (/^#\s+/.test(remainder)) body = remainder
  }
  return { fm: fm as Record<string, unknown>, body }
}

function renderArtifactMarkdown(a: InboundArtifact, reviewId: string): string {
  // Stamp namespace fields so reviewers know which tenant proposed the
  // candidate atom. yamlLite escapes any colon/hash/newline in scalar values
  // so attacker-controlled fields can't break out of their frontmatter slot.
  const fm: Record<string, unknown> = {
    proposed_id: a.proposed_id,
    phase: a.phase,
    type: a.type,
    status: 'raw',
    review_id: reviewId,
    proposed_at: new Date().toISOString(),
  }
  if (a.source_session) fm['source_session'] = a.source_session
  if (a.confidence !== undefined) fm['confidence'] = a.confidence
  if (a.namespace?.tenant_id) fm['tenant_id'] = a.namespace.tenant_id
  if (a.namespace?.user_id) fm['user_id'] = a.namespace.user_id
  if (a.namespace?.session_id) fm['session_id'] = a.namespace.session_id
  if (a.namespace?.agent_id) fm['agent_id'] = a.namespace.agent_id
  // Code symbols this atom governs/references (see ADR-009). Stored
  // as JSON inside YAML to keep nested objects readable.
  if (a.linked_symbols && a.linked_symbols.length > 0) {
    fm['linked_symbols'] = a.linked_symbols
  }

  const reason = a.reason ? `\n## Proposal Rationale\n\n${a.reason}\n` : ''
  return `---\n${yamlLite(fm)}---\n\n# ${a.title}\n\n${a.body.trim()}\n${reason}`
}

function validateId(id: string): void {
  if (!isAtomicId(id)) {
    throw new Error(
      `InboundQueue: invalid proposed_id '${id}'. Must match TYPE--SLUG (e.g. CONCEPT--FOO-BAR).`,
    )
  }
}

function validatePhase(phase: Phase): void {
  if (!Number.isInteger(phase) || phase < 0 || phase > 6) {
    throw new Error(`InboundQueue: invalid phase ${phase}, must be integer 0..6`)
  }
}
