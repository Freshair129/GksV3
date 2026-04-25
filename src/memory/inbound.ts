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
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
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
  if (!Number.isInteger(phase) || phase < 0 || phase > 5) {
    throw new Error(`InboundQueue: invalid phase ${phase}, must be integer 0..5`)
  }
}
