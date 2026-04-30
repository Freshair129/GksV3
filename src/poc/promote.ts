/**
 * POC→ADR scaffolder — turns a closed POC into an ADR draft in the
 * inbound queue (FEAT--POC-LIGHT-TIER §"Out of scope" item, lifted
 * into scope).
 *
 * Contract:
 *   - POC must be in a terminal state (validated / invalidated / abandoned).
 *     Open / running POCs cannot be promoted — they haven't produced a result.
 *   - The generated ADR's body is pre-filled with Context (the
 *     hypothesis), Decision (placeholder reflecting the resolution),
 *     Consequences (acceptance-criteria outcome), and Alternatives
 *     (placeholder).
 *   - crosslinks.references includes the source POC id so the chain
 *     is auditable both directions.
 *   - Lands in the inbound queue — the human review gate for strict-tier
 *     atoms still applies. The scaffolder reduces blank-page friction;
 *     it does NOT bypass review.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { InboundQueue } from '../memory/inbound.js'
import type { InboundArtifact, Phase } from '../memory/types.js'
import { isClosed, type Poc } from './types.js'

export interface PromoteOptions {
  /** Override the auto-derived ADR slug. */
  adrSlug?: string
  /** Override the auto-derived ADR title. */
  title?: string
  /** Vault id for the inbound artifact; defaults to PocStore root vault. */
  vaultId?: string
}

export interface PromoteResult {
  artifact: InboundArtifact
  proposedId: string
  inboundPath: string
}

/**
 * Read a POC atom from disk.
 */
async function readPoc(pocDir: string, id: string): Promise<Poc> {
  const path = join(pocDir, `${id}.md`)
  const text = await readFile(path, 'utf8')
  if (!text.startsWith('---')) {
    throw new Error(`promotePocToAdr: ${path} missing frontmatter`)
  }
  const end = text.indexOf('\n---', 3)
  if (end === -1) throw new Error(`promotePocToAdr: ${path} unterminated frontmatter`)
  const fm = parseYaml(text.slice(3, end).trim())
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new Error(`promotePocToAdr: ${path} frontmatter is not an object`)
  }
  return fm as unknown as Poc
}

/** Slug normaliser shared with `makePocId` — strips POC-- prefix if present. */
function adrSlugFromPoc(pocId: string): string {
  return pocId.replace(/^POC--/, '').replace(/[^A-Z0-9-]/g, '-')
}

function renderAdrBody(poc: Poc, title: string): string {
  const criteriaList = poc.acceptance_criteria.map((c) => `- ${c}`).join('\n')
  const verdict = (() => {
    switch (poc.status) {
      case 'validated':
        return 'The POC validated the hypothesis. The criteria below all held; lifting the result into a stable architectural decision.'
      case 'invalidated':
        return 'The POC invalidated the hypothesis. The criteria below failed in the way recorded; this ADR captures the *pivot* — what we now believe and why.'
      case 'abandoned':
        return 'The POC was abandoned before the criteria could be evaluated. This ADR captures the lesson learned + the decision to deprioritise.'
      default:
        return ''
    }
  })()

  return [
    `# ADR — ${title}`,
    '',
    '## Context',
    '',
    'Hypothesis under test (from the source POC):',
    '',
    `> ${poc.hypothesis.replace(/\n/g, '\n> ').trim()}`,
    '',
    `Source: \`${poc.id}\` (status: \`${poc.status}\`).`,
    '',
    '## Decision',
    '',
    verdict,
    '',
    '<!-- TODO: state the decision in 1–2 declarative sentences. -->',
    '',
    '## Consequences',
    '',
    '**Acceptance criteria outcome:**',
    '',
    criteriaList,
    '',
    '<!-- TODO: spell out positive + negative consequences. -->',
    '',
    '## Alternatives considered',
    '',
    '<!-- TODO: list alternatives the POC could have tested but didn\'t,',
    '     or pivots that would have been chosen had the POC failed differently. -->',
    '',
    '## References',
    '',
    `- ${poc.id} — the POC this ADR builds on`,
    ...(poc.crosslinks?.derives_from ?? []).map((id) => `- ${id} — original concept the POC derived from`),
    ...(poc.crosslinks?.produces ?? []).map((id) => `- ${id} — produced by the POC`),
    '',
  ].join('\n')
}

/**
 * Scaffold an ADR draft from a closed POC into the inbound queue.
 * Throws if the POC is non-terminal (open / running) — the result must
 * exist before a decision can rest on it.
 */
export async function promotePocToAdr(args: {
  pocId: string
  pocDir: string
  inbound: InboundQueue
  options?: PromoteOptions
}): Promise<PromoteResult> {
  const poc = await readPoc(args.pocDir, args.pocId)
  if (!isClosed(poc)) {
    throw new Error(
      `promotePocToAdr: POC ${poc.id} is in non-terminal status '${poc.status}'. ` +
        `Close it first with: gks poc close ${poc.id} --resolution=validated|invalidated|abandoned`,
    )
  }

  const slug = args.options?.adrSlug ?? adrSlugFromPoc(poc.id)
  const proposedId = `ADR--${slug}`
  const title = args.options?.title ?? poc.title

  const phase: Phase = 2 // ADRs live at P2 by convention

  const artifact: InboundArtifact = {
    proposed_id: proposedId,
    phase,
    type: 'adr',
    title,
    confidence: 0.6,                // medium — pre-filled draft, expects human review
    reason: `Auto-scaffolded from ${poc.id} (resolution: ${poc.status})`,
    body: renderAdrBody(poc, title),
  }

  const receipt = await args.inbound.propose(artifact)
  return { artifact, proposedId, inboundPath: receipt.path }
}
