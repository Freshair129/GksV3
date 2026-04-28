/**
 * `gks new-feature` scaffolder (ADR-014 item 5).
 *
 * One command, four atom candidates dropped into the inbound queue:
 *
 *   CONCEPT--<NAME>      why we need this           (P1)
 *   ADR--<NAME>          what we decided            (P2)
 *   FEAT--<NAME>         the feature wiring         (P2)
 *   BLUEPRINT--<NAME>    geography pre-filled        (P3)
 *
 * Tasks (P4) are NOT scaffolded by default — they're shaped by the
 * blueprint and shouldn't be guessed. Pass `--task <slug>` (repeated)
 * to drop empty TASK-- candidates that reference the new blueprint.
 *
 * The scaffolder writes through `InboundQueue.propose()` — same path
 * an agent's `proposeInbound()` call takes — so reviewers see the
 * candidates the same way.
 */

import type { InboundArtifact, LinkedSymbol } from '../memory/types.js'
import type { InboundQueue } from '../memory/inbound.js'

export interface NewFeatureArgs {
  /** Slug used in every atom id, uppercased + dashed (e.g. RATE-LIMIT). */
  slug: string
  /** One-line title shared across the four atoms. */
  title: string
  /** Free text for the CONCEPT body (problem + hypothesis). */
  conceptBody?: string
  /** Free text for the ADR body (decision + alternatives). */
  adrBody?: string
  /** File paths the BLUEPRINT will govern. Becomes geography + linked_symbols. */
  blueprintFiles?: string[]
  /** Optional task slugs (e.g. ["VALIDATE-INPUT", "ERROR-MAPPER"]). */
  tasks?: string[]
}

export interface ScaffoldResult {
  proposed: Array<{ id: string; path: string; reviewId: string }>
}

const TEMPLATE = {
  concept: (title: string, body?: string) =>
    `# CONCEPT — ${title}\n\n## Problem\n\n${body ?? '<why does this need to exist?>'}\n\n## Hypothesis\n\n<what changes if we ship it?>\n`,
  adr: (title: string, body?: string) =>
    `# ADR — ${title}\n\n## Context\n\n${body ?? '<the situation forcing the decision>'}\n\n## Decision\n\n<what we will do>\n\n## Consequences\n\n<positive / negative>\n\n## Alternatives considered\n\n1. <alternative> — *rejected.*\n`,
  feat: (title: string) =>
    `# FEAT — ${title}\n\n## User-facing behaviour\n\nGiven … when … then …\n\n## Acceptance criteria\n\n- [ ] criterion 1\n- [ ] criterion 2\n`,
  blueprint: (title: string, files: string[]) => {
    const geography = files.map((f) => `  - ${JSON.stringify(f)}`).join('\n')
    return `# BLUEPRINT — ${title}\n\n\`\`\`yaml\nmetadata:\n  title: "${title}"\narchitectural_pattern: <pattern>\ndata_logic: <data flow>\ngeography:\n${geography || '  - <file path>'}\napi_contracts: []\nverification_plan: []\n\`\`\`\n`
  },
  task: (title: string, parent: string) =>
    `# TASK — ${title}\n\n## Spec\n\n<one concern, ≤ 400 tokens>\n\n## Acceptance criteria\n\n- [ ] criterion 1\n- [ ] criterion 2 (≥ 2 required)\n\n## Geography\n\nFiles allowed (must be a subset of \`${parent}\`'s geography).\n`,
}

/** Shared linked_symbols built from --blueprint-files. */
function fileSymbols(files: string[] | undefined): LinkedSymbol[] | undefined {
  if (!files || files.length === 0) return undefined
  return files.map((file) => ({ file }))
}

export async function scaffoldNewFeature(
  inbound: InboundQueue,
  args: NewFeatureArgs,
): Promise<ScaffoldResult> {
  const slug = args.slug.toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(slug)) {
    throw new Error(`new-feature: invalid slug '${args.slug}' (must match [A-Z0-9][A-Z0-9_-]*)`)
  }
  const conceptId = `CONCEPT--${slug}`
  const adrId = `ADR--${slug}`
  const featId = `FEAT--${slug}`
  const blueprintId = `BLUEPRINT--${slug}`
  const symbols = fileSymbols(args.blueprintFiles)

  const artifacts: InboundArtifact[] = [
    {
      proposed_id: conceptId,
      phase: 1,
      type: 'concept',
      title: args.title,
      body: TEMPLATE.concept(args.title, args.conceptBody),
    },
    {
      proposed_id: adrId,
      phase: 2,
      type: 'adr',
      title: args.title,
      body: TEMPLATE.adr(args.title, args.adrBody),
    },
    {
      proposed_id: featId,
      phase: 2,
      type: 'feat',
      title: args.title,
      body: TEMPLATE.feat(args.title),
      ...(symbols ? { linked_symbols: symbols } : {}),
    },
    {
      proposed_id: blueprintId,
      phase: 3,
      type: 'blueprint',
      title: args.title,
      body: TEMPLATE.blueprint(args.title, args.blueprintFiles ?? []),
      ...(symbols ? { linked_symbols: symbols } : {}),
    },
  ]

  for (const taskSlug of args.tasks ?? []) {
    const ts = taskSlug.toUpperCase()
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(ts)) {
      throw new Error(`new-feature: invalid task slug '${taskSlug}'`)
    }
    artifacts.push({
      proposed_id: `TASK--${slug}-${ts}`,
      phase: 4,
      type: 'task',
      title: `${args.title} — ${ts.toLowerCase()}`,
      body: TEMPLATE.task(`${args.title} — ${ts.toLowerCase()}`, blueprintId),
    })
  }

  const proposed: ScaffoldResult['proposed'] = []
  for (const a of artifacts) {
    const receipt = await inbound.propose(a)
    proposed.push({ id: a.proposed_id, path: receipt.path, reviewId: receipt.reviewId })
  }
  return { proposed }
}
