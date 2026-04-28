/**
 * `gks new-feature` scaffolder (ADR-014 item 5; task handling per ADR-015).
 *
 * One command, four atom candidates dropped into the inbound queue:
 *
 *   CONCEPT--<NAME>      why we need this           (P1)
 *   ADR--<NAME>          what we decided            (P2)
 *   FEAT--<NAME>         the feature wiring         (P2)
 *   BLUEPRINT--<NAME>    geography pre-filled        (P3)
 *
 * Microtasks (P4) are NOT atoms (ADR-015) — they are execution state
 * owned by the orchestrator. When `--task-tracker=local` is passed and
 * `--task=<slug>` entries are supplied, this scaffolder writes
 * `T<n>_<slug>.task.yaml` skeletons into `<root>/.brain/<ns>/tasks/<slug>/`
 * (outside `gks/`). Other tracker modes (`msp`, `external`) emit guidance
 * lines and leave tracker integration to the orchestrator.
 *
 * The four atom candidates flow through `InboundQueue.propose()` — the
 * same path an agent's `proposeInbound()` call takes — so reviewers see
 * them the same way.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { InboundArtifact, LinkedSymbol } from '../memory/types.js'
import type { InboundQueue } from '../memory/inbound.js'

export type TaskTracker = 'local' | 'msp' | 'external'

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
  /** Optional task slugs. With `--task-tracker=local`, dropped as
   *  `T<n>_<slug>.task.yaml` skeletons in `.brain/<ns>/tasks/<slug>/`. */
  tasks?: string[]
  /** Where live task state lives. Default 'msp' (no files written). */
  taskTracker?: TaskTracker
  /** Repo root (used by tracker=local to find the task directory). */
  repoRoot?: string
  /** Namespace under .brain/<ns>/. Defaults to 'default'. */
  namespace?: string
}

export interface ScaffoldResult {
  proposed: Array<{ id: string; path: string; reviewId: string }>
  /** Task-tracker side-effects (only when tracker=local). */
  tasksWritten?: Array<{ slug: string; path: string }>
  /** Free-form guidance for trackers that GKS doesn't write (msp/external). */
  trackerGuidance?: string[]
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
  microtaskYaml: (slug: string, parent: string, blueprintFiles: string[]) => {
    const geography = blueprintFiles.length > 0
      ? blueprintFiles.map((f) => `  - ${JSON.stringify(f)}`).join('\n')
      : '  # subset of parent BLUEPRINT geography'
    return [
      `# Microtask (execution state — owned by orchestrator per ADR-015)`,
      `# Lives outside gks/. Update freely; close it when the code merges.`,
      ``,
      `id: ${slug}`,
      `parent_blueprint: ${parent}`,
      `status: open                  # open | in_progress | blocked | done`,
      `assignee:                     # MSP-AGT-... or MSP-USR-...`,
      `created_at: ${new Date().toISOString()}`,
      `prompt: |`,
      `  <≤ 400-token instruction for the agent>`,
      `acceptance:`,
      `  - <falsifiable criterion 1>`,
      `  - <falsifiable criterion 2 (≥ 2 required)>`,
      `geography:`,
      geography,
      ``,
    ].join('\n')
  },
}

function fileSymbols(files: string[] | undefined): LinkedSymbol[] | undefined {
  if (!files || files.length === 0) return undefined
  return files.map((file) => ({ file }))
}

function validateSlug(slug: string, label: string): string {
  const upper = slug.toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(upper)) {
    throw new Error(`new-feature: invalid ${label} '${slug}' (must match [A-Z0-9][A-Z0-9_-]*)`)
  }
  return upper
}

export async function scaffoldNewFeature(
  inbound: InboundQueue,
  args: NewFeatureArgs,
): Promise<ScaffoldResult> {
  const slug = validateSlug(args.slug, 'slug')
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

  const proposed: ScaffoldResult['proposed'] = []
  for (const a of artifacts) {
    const receipt = await inbound.propose(a)
    proposed.push({ id: a.proposed_id, path: receipt.path, reviewId: receipt.reviewId })
  }

  const result: ScaffoldResult = { proposed }
  const tasks = args.tasks ?? []
  if (tasks.length === 0) return result

  // Validate task slugs even when not writing files — fail fast.
  const taskSlugs = tasks.map((t) => validateSlug(t, 'task slug'))
  const tracker: TaskTracker = args.taskTracker ?? 'msp'

  if (tracker === 'local') {
    const root = args.repoRoot ?? process.cwd()
    const ns = args.namespace ?? 'default'
    const taskDir = join(root, '.brain', ns, 'tasks', slug.toLowerCase())
    await mkdir(taskDir, { recursive: true })
    const written: NonNullable<ScaffoldResult['tasksWritten']> = []
    let n = 1
    for (const ts of taskSlugs) {
      const filename = `T${n}_${ts.toLowerCase()}.task.yaml`
      const path = join(taskDir, filename)
      const yaml = TEMPLATE.microtaskYaml(ts, blueprintId, args.blueprintFiles ?? [])
      await writeFile(path, yaml, 'utf8')
      written.push({ slug: ts, path })
      n++
    }
    result.tasksWritten = written
  } else if (tracker === 'msp') {
    result.trackerGuidance = [
      `Microtasks not written: tracker=msp.`,
      `Hand off to the orchestrator (e.g. MSP) — pass each slug into its task API:`,
      ...taskSlugs.map((ts) => `  - ${ts}  (parent: ${blueprintId})`),
    ]
  } else {
    result.trackerGuidance = [
      `Microtasks not written: tracker=external.`,
      `Create them in the external tracker (Linear / Jira / Asana) and reference ${blueprintId} from each:`,
      ...taskSlugs.map((ts) => `  - ${ts}  (parent: ${blueprintId})`),
    ]
  }

  return result
}
