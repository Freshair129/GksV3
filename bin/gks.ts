#!/usr/bin/env node
/**
 * `gks` — CLI for everyday memory ops. Thin wrapper around MemoryStore /
 * api.ts, mostly for quick ad-hoc retain/recall from a shell.
 *
 * Usage:
 *   gks retain "User prefers dark mode"
 *   gks recall "tri-brain architecture" --top-k=5 --strategy=multi
 *   gks lookup CONCEPT--EVA-TRI-BRAIN
 *   gks propose-inbound INSIGHT--FOO --title="My insight" --body="..."
 *   gks propose-inbound ADR--FOO --title="..." --body="..." \
 *       --linked-symbol=src/x.ts:doThing:42 --linked-symbol=src/y.ts:helper
 *   gks reflect MSP-SESS-260425ABCD
 *   gks init                                # scaffold .brain/ dirs in cwd
 *   gks status                              # show store stats
 *
 * Global flags (apply to every subcommand):
 *   --root=PATH         repo root (default: cwd)
 *   --tenant=ID         active tenant id (defaultNamespace.tenant_id)
 *   --user=ID           user id
 *   --agent=ID          agent id
 *   --provider=...      embedder provider override
 *   --json              raw JSON output instead of pretty text
 */

import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  MemoryStore,
  gksLayout,
  type Namespace,
} from '../src/memory/index.js'
import { recall, retain, reflect } from '../src/memory/api.js'
import { truncate } from '../src/lib/text.js'
import { IssueStore } from '../src/issue/store.js'
import { ISSUE_STATUSES, ISSUE_PRIORITIES, type IssueStatus, type IssuePriority } from '../src/issue/types.js'
import { HotfixStore } from '../src/hotfix/store.js'
import { isOverdue } from '../src/hotfix/types.js'
import { verifyFlow, formatVerifyFlowResult } from '../src/memory/verify-flow.js'
import { validateLinks, formatValidateLinksResult } from '../src/memory/validate-links.js'
import { scaffoldNewFeature } from '../src/scaffold/new-feature.js'

interface GlobalFlags {
  root: string
  namespace: Namespace
  json: boolean
  provider?: 'auto' | 'ollama' | 'openai' | 'mock'
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const subcmd = argv[0]
  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    printUsage()
    process.exit(subcmd ? 0 : 1)
  }

  // Strip the subcmd then parse the rest with shared + per-subcmd flags.
  const subArgv = argv.slice(1)

  switch (subcmd) {
    case 'retain':
      await cmdRetain(subArgv)
      break
    case 'recall':
      await cmdRecall(subArgv)
      break
    case 'lookup':
      await cmdLookup(subArgv)
      break
    case 'lookup-by-symbol':
      await cmdLookupBySymbol(subArgv)
      break
    case 'propose-inbound':
      await cmdProposeInbound(subArgv)
      break
    case 'reflect':
      await cmdReflect(subArgv)
      break
    case 'init':
      await cmdInit(subArgv)
      break
    case 'status':
      await cmdStatus(subArgv)
      break
    case 'issue':
      await cmdIssue(subArgv)
      break
    case 'hotfix':
      await cmdHotfix(subArgv)
      break
    case 'verify-flow':
      await cmdVerifyFlow(subArgv)
      break
    case 'validate':
      await cmdValidate(subArgv)
      break
    case 'new-feature':
      await cmdNewFeature(subArgv)
      break
    default:
      console.error(`gks: unknown subcommand '${subcmd}'`)
      printUsage()
      process.exit(1)
  }
}

// ─── subcommands ───────────────────────────────────────────────────────────

async function cmdRetain(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...GLOBAL_OPTIONS,
      path: { type: 'string' },
      tag: { type: 'string', multiple: true },
      'conflict-policy': { type: 'string' },
      'session-id': { type: 'string' },
    },
  })
  const flags = readGlobals(values)
  const content = readPositionalOrStdin(positionals, 'retain')
  const store = await openStore(flags)
  const result = await retain(store, {
    content,
    metadata: {
      ...(values['path'] ? { path: values['path'] as string } : {}),
      ...(values['tag'] ? { tags: values['tag'] as string[] } : {}),
    },
    ...(flags.namespace && Object.keys(flags.namespace).length > 0 ? { namespace: flags.namespace } : {}),
    ...(values['session-id'] ? { sessionId: values['session-id'] as string } : {}),
    ...(values['conflict-policy']
      ? { conflictPolicy: values['conflict-policy'] as 'auto' | 'supersede' | 'coexist' }
      : {}),
  })
  emit(flags, result, () => {
    console.log(`✓ retained ${result.vectorDocId}`)
    if (result.conflicts.length > 0) {
      console.log(`  ${result.conflicts.length} conflict(s):`)
      for (const c of result.conflicts) {
        console.log(`    ${c.resolution.padEnd(11)} ${c.existingId} (${c.reason})`)
      }
    }
  })
}

async function cmdRecall(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...GLOBAL_OPTIONS,
      'top-k': { type: 'string' },
      threshold: { type: 'string' },
      strategy: { type: 'string' },
      'cross-namespace': { type: 'boolean' },
    },
  })
  const flags = readGlobals(values)
  const query = readPositionalOrStdin(positionals, 'recall')
  const store = await openStore(flags)
  const result = await recall(store, query, {
    ...(values['top-k'] ? { topK: Number(values['top-k']) } : {}),
    ...(values['threshold'] !== undefined ? { scoreThreshold: Number(values['threshold']) } : {}),
    ...(values['strategy']
      ? { strategy: values['strategy'] as 'atomic' | 'vector' | 'episodic' | 'obsidian' | 'multi' }
      : {}),
    ...(flags.namespace && Object.keys(flags.namespace).length > 0 ? { namespace: flags.namespace } : {}),
    ...(values['cross-namespace'] ? { crossNamespace: true } : {}),
  })
  emit(flags, result, () => {
    console.log(`▸ ${result.hits.length} hit(s) (${result.tookMs}ms · ${result.strategy})`)
    for (const h of result.hits) {
      console.log(
        `  ${h.source.padEnd(8)} ${h.score.toFixed(3)} ${h.path ?? h.id}  ${truncate(h.snippet, 80)}`,
      )
    }
  })
}

async function cmdLookup(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: GLOBAL_OPTIONS,
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  if (!id) {
    console.error('gks lookup: missing atomic id (e.g. CONCEPT--EVA-TRI-BRAIN)')
    process.exit(1)
  }
  const store = await openStore(flags)
  const note = await store.lookup(id)
  if (!note) {
    // --json: emit a well-formed result and exit 0 (not-found is data, not
    // a CLI failure — agents reading stdout shouldn't conflate the two).
    // Plain output: pretty + exit 1 so shell pipelines short-circuit.
    if (flags.json) {
      console.log(JSON.stringify({ found: false, note: null }))
      return
    }
    console.log(`✗ ${id} — not found`)
    process.exit(1)
  }
  emit(flags, note, () => {
    console.log(`▸ ${note.id} — ${note.title ?? '(untitled)'}`)
    console.log(`  phase: ${note.phase}  type: ${note.type}  status: ${note.status}`)
    console.log(`  path:  ${note.path}`)
    console.log('')
    console.log(note.body.split('\n').slice(0, 20).join('\n'))
  })
}

async function cmdLookupBySymbol(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: GLOBAL_OPTIONS,
  })
  const flags = readGlobals(values)
  const symbolPath = positionals[0]
  if (!symbolPath) {
    console.error(
      'gks lookup-by-symbol: missing symbol path (e.g. src/x.ts:foo or src/x.ts:foo:42)',
    )
    process.exit(1)
  }
  const store = await openStore(flags)
  const hits = await store.lookupBySymbol(symbolPath)
  emit(
    flags,
    {
      symbol: symbolPath,
      hit_count: hits.length,
      hits: hits.map((h) => ({
        id: h.id,
        type: h.type,
        phase: h.phase,
        status: h.status,
        title: h.title,
        path: h.path,
      })),
    },
    () => {
      if (hits.length === 0) {
        console.log(`(no atoms cite ${symbolPath})`)
        return
      }
      console.log(`${hits.length} atom(s) cite ${symbolPath}:`)
      for (const h of hits) {
        console.log(`  ▸ ${h.id}  [${h.type}/${h.status}]  ${h.title ?? ''}`)
        console.log(`    ${h.path}`)
      }
    },
  )
}

async function cmdProposeInbound(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...GLOBAL_OPTIONS,
      title: { type: 'string' },
      body: { type: 'string' },
      type: { type: 'string' },
      phase: { type: 'string' },
      confidence: { type: 'string' },
      'linked-symbol': { type: 'string', multiple: true },
    },
  })
  const flags = readGlobals(values)
  const proposedId = positionals[0]
  if (!proposedId) {
    console.error('gks propose-inbound: missing proposed atomic id (TYPE--SLUG)')
    process.exit(1)
  }
  const linkedSymbols = parseLinkedSymbols(values['linked-symbol'] as string[] | undefined)
  const store = await openStore(flags)
  const receipt = await store.proposeInbound({
    proposed_id: proposedId,
    phase: Number(values['phase'] ?? 1) as 0 | 1 | 2 | 3 | 4 | 5,
    type: (values['type'] as string | undefined) ?? 'insight',
    title: (values['title'] as string | undefined) ?? proposedId,
    body: (values['body'] as string | undefined) ?? '',
    ...(values['confidence'] ? { confidence: Number(values['confidence']) } : {}),
    ...(linkedSymbols.length > 0 ? { linked_symbols: linkedSymbols } : {}),
  })
  emit(flags, receipt, () => {
    console.log(`✓ ${proposedId} → ${receipt.path}`)
    console.log(`  reviewId: ${receipt.reviewId}`)
    if (linkedSymbols.length > 0) {
      console.log(`  linked_symbols: ${linkedSymbols.length}`)
    }
  })
}

/**
 * Parse `--linked-symbol` flag values. Accepted forms:
 *   src/x.ts                                 (file only)
 *   src/x.ts:fnName                          (file + symbol)
 *   src/x.ts:fnName:42                       (file + symbol + line)
 * Multiple flags on the same command line stack into one array.
 */
function parseLinkedSymbols(
  raw: string[] | undefined,
): Array<{ file: string; fn?: string; line?: number }> {
  if (!raw || raw.length === 0) return []
  return raw.map((s) => {
    const parts = s.split(':')
    const file = parts[0]
    if (!file) {
      throw new Error(`gks propose-inbound: invalid --linked-symbol '${s}' (empty file path)`)
    }
    const out: { file: string; fn?: string; line?: number } = { file }
    if (parts[1]) out.fn = parts[1]
    if (parts[2]) {
      const n = Number.parseInt(parts[2], 10)
      if (Number.isFinite(n) && n > 0) out.line = n
    }
    return out
  })
}

async function cmdReflect(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...GLOBAL_OPTIONS,
      'force-consolidate': { type: 'boolean' },
      'no-persist': { type: 'boolean' },
    },
  })
  const flags = readGlobals(values)
  const sessionId = positionals[0]
  if (!sessionId) {
    console.error('gks reflect: missing session id (e.g. MSP-SESS-260425ABCD)')
    process.exit(1)
  }
  const store = await openStore(flags)
  const trace = await store.episodic.readTrace(sessionId)
  if (trace.length === 0) {
    console.error(`gks reflect: no trace found for ${sessionId}`)
    process.exit(1)
  }
  const startedAt = trace[0]!.t
  const endedAt = trace[trace.length - 1]!.t
  const result = await reflect(
    store,
    { sessionId, startedAt, endedAt, participants: [], trace },
    { persist: values['no-persist'] !== true },
  )
  emit(flags, result, () => {
    console.log(`▸ session ${sessionId} consolidated (${result.triggered ? 'triggered' : 'forced'})`)
    console.log(`  trace steps: ${trace.length}`)
    console.log(`  proposals:   ${result.proposals.length}`)
    console.log(`  summary:     ${truncate(result.memory.summary, 240)}`)
  })
}

async function cmdInit(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: GLOBAL_OPTIONS })
  const flags = readGlobals(values)
  const layout = gksLayout(flags.root)
  const dirs = [
    layout.memory,
    layout.session,
    layout.inbound,
    layout.vector,
    layout.audit,
    join(layout.gks, '00_index'),
  ]
  for (const d of dirs) await mkdir(d, { recursive: true })
  emit(flags, { ok: true, root: flags.root, dirs }, () => {
    console.log(`✓ initialised gks store at ${flags.root}`)
    for (const d of dirs) console.log(`  ${d}`)
  })
}

async function cmdStatus(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: GLOBAL_OPTIONS })
  const flags = readGlobals(values)
  const store = await openStore(flags)
  const atomicCount = store.atomic.size()
  const vector = await store.getVectorStore('atomic')
  const manifest = vector.getManifest()
  const status = {
    root: store.root,
    namespace: store.defaultNamespace,
    atomic_index_size: atomicCount,
    vector_doc_count: manifest.doc_count,
    embedder: { model: manifest.embedder_model, dim: manifest.dimension },
    schema_version: manifest.schema_version ?? '1.0.0',
  }
  emit(flags, status, () => {
    console.log(`▸ gks store @ ${status.root}`)
    console.log(`  namespace:        ${JSON.stringify(status.namespace)}`)
    console.log(`  atomic notes:     ${status.atomic_index_size}`)
    console.log(`  vector docs:      ${status.vector_doc_count}`)
    console.log(`  embedder:         ${status.embedder.model} (dim ${status.embedder.dim})`)
    console.log(`  schema_version:   ${status.schema_version}`)
  })
}

// ─── issue tracker (light-tier per ADR-012) ────────────────────────────────

async function cmdIssue(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub) {
    console.error(
      'gks issue: missing subcommand. Try: new | list | show | comment | status | assign | close | dashboard',
    )
    process.exit(1)
  }
  const rest = argv.slice(1)
  switch (sub) {
    case 'new': await cmdIssueNew(rest); break
    case 'list': await cmdIssueList(rest); break
    case 'show': await cmdIssueShow(rest); break
    case 'comment': await cmdIssueComment(rest); break
    case 'status': await cmdIssueStatus(rest); break
    case 'assign': await cmdIssueAssign(rest); break
    case 'close': await cmdIssueClose(rest); break
    case 'dashboard': await cmdIssueDashboard(rest); break
    default:
      console.error(`gks issue: unknown subcommand '${sub}'`)
      process.exit(1)
  }
}

function openIssueStore(flags: GlobalFlags): IssueStore {
  return new IssueStore({ root: flags.root })
}

function issueActor(flags: GlobalFlags): string {
  return flags.namespace.user_id ? `MSP-USR-${flags.namespace.user_id}`
       : flags.namespace.agent_id ? `MSP-AGT-${flags.namespace.agent_id}`
       : 'MSP-USR-CLI'
}

async function cmdIssueNew(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...GLOBAL_OPTIONS,
      title: { type: 'string' },
      priority: { type: 'string' },
      label: { type: 'string', multiple: true },
      assignee: { type: 'string' },
      reporter: { type: 'string' },
      body: { type: 'string' },
    },
  })
  const flags = readGlobals(values)
  const title = (values['title'] as string | undefined) ?? positionals.join(' ').trim()
  if (!title) {
    console.error('gks issue new: missing title (positional or --title=)')
    process.exit(1)
  }
  const priority = (values['priority'] as string | undefined) ?? 'medium'
  const store = openIssueStore(flags)
  const issue = await store.create({
    title,
    priority: priority as IssuePriority,
    ...(values['label'] ? { labels: values['label'] as string[] } : {}),
    ...(values['assignee'] ? { assignee: values['assignee'] as string } : {}),
    ...(values['reporter'] ? { reporter: values['reporter'] as string } : { reporter: issueActor(flags) }),
    ...(values['body'] ? { body: values['body'] as string } : {}),
  })
  emit(flags, issue, () => {
    console.log(`✓ ${issue.id}  [${issue.status}/${issue.priority}]  ${issue.title}`)
    console.log(`  ${join(store.getDir(), `${issue.id}.md`)}`)
  })
}

async function cmdIssueList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      ...GLOBAL_OPTIONS,
      status: { type: 'string' },
      priority: { type: 'string' },
      assignee: { type: 'string' },
      label: { type: 'string' },
    },
  })
  const flags = readGlobals(values)
  const store = openIssueStore(flags)
  const issues = await store.list({
    ...(values['status'] ? { status: values['status'] as IssueStatus | 'all' } : {}),
    ...(values['priority'] ? { priority: values['priority'] as IssuePriority } : {}),
    ...(values['assignee'] ? { assignee: values['assignee'] as string } : {}),
    ...(values['label'] ? { label: values['label'] as string } : {}),
  })
  emit(flags, { count: issues.length, issues }, () => {
    if (issues.length === 0) {
      console.log('(no issues match)')
      return
    }
    for (const i of issues) {
      const tag = i.labels && i.labels.length > 0 ? `[${i.labels.join(',')}] ` : ''
      console.log(
        `  ${i.status.padEnd(13)} ${i.priority.padEnd(7)} ${i.id.padEnd(40)} ${tag}${i.title}`,
      )
    }
  })
}

async function cmdIssueShow(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: GLOBAL_OPTIONS,
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  if (!id) {
    console.error('gks issue show: missing id')
    process.exit(1)
  }
  const store = openIssueStore(flags)
  const { issue, body } = await store.show(id)
  emit(flags, { ...issue, body }, () => {
    console.log(`▸ ${issue.id} — ${issue.title}`)
    console.log(`  status:      ${issue.status}`)
    console.log(`  priority:    ${issue.priority}`)
    if (issue.assignee) console.log(`  assignee:    ${issue.assignee}`)
    if (issue.labels) console.log(`  labels:      ${issue.labels.join(', ')}`)
    console.log(`  created:     ${issue.created_at}`)
    console.log(`  updated:     ${issue.updated_at}`)
    if (issue.closed_at) console.log(`  closed:      ${issue.closed_at}`)
    console.log('')
    console.log(body.split('\n').slice(0, 50).join('\n'))
  })
}

async function cmdIssueComment(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: GLOBAL_OPTIONS,
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  const text = positionals.slice(1).join(' ').trim()
  if (!id || !text) {
    console.error('gks issue comment: usage: gks issue comment <ID> "<text>"')
    process.exit(1)
  }
  const store = openIssueStore(flags)
  const issue = await store.comment(id, text, issueActor(flags))
  emit(flags, issue, () => console.log(`✓ commented on ${issue.id}`))
}

async function cmdIssueStatus(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: GLOBAL_OPTIONS,
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  const newStatus = positionals[1]
  if (!id || !newStatus) {
    console.error(
      `gks issue status: usage: gks issue status <ID> <new-status>\n  status ∈ ${ISSUE_STATUSES.join(' | ')}`,
    )
    process.exit(1)
  }
  const store = openIssueStore(flags)
  const issue = await store.setStatus(id, newStatus as IssueStatus, issueActor(flags))
  emit(flags, issue, () => console.log(`✓ ${issue.id} → ${issue.status}`))
}

async function cmdIssueAssign(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: GLOBAL_OPTIONS,
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  const assignee = positionals[1]
  if (!id || !assignee) {
    console.error('gks issue assign: usage: gks issue assign <ID> <assignee>')
    process.exit(1)
  }
  const store = openIssueStore(flags)
  const issue = await store.assign(id, assignee, issueActor(flags))
  emit(flags, issue, () => console.log(`✓ ${issue.id} assignee → ${issue.assignee}`))
}

async function cmdIssueClose(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...GLOBAL_OPTIONS, 'resolved-by': { type: 'string' } },
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  if (!id) {
    console.error('gks issue close: missing id')
    process.exit(1)
  }
  const store = openIssueStore(flags)
  const resolvedBy = values['resolved-by'] as string | undefined
  const issue = await store.close(id, issueActor(flags), resolvedBy)
  emit(flags, issue, () => {
    console.log(`✓ ${issue.id} closed${resolvedBy ? ` (resolved by ${resolvedBy})` : ''}`)
  })
}

async function cmdIssueDashboard(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, md: { type: 'boolean' } } })
  const flags = readGlobals(values)
  const store = openIssueStore(flags)
  const all = await store.list({ status: 'all' })
  const counts: Record<string, number> = {}
  for (const status of ISSUE_STATUSES) counts[status] = 0
  for (const i of all) counts[i.status] = (counts[i.status] ?? 0) + 1
  if (values['md']) {
    console.log('# Issue dashboard\n')
    console.log('| Status | Count |')
    console.log('|---|---:|')
    for (const s of ISSUE_STATUSES) console.log(`| ${s} | ${counts[s]} |`)
    return
  }
  emit(flags, { total: all.length, by_status: counts }, () => {
    console.log(`Issue dashboard — ${all.length} total`)
    for (const s of ISSUE_STATUSES) console.log(`  ${s.padEnd(13)} ${counts[s]}`)
  })
}

// ─── hotfix escape hatch (light-tier per ADR-014) ──────────────────────────

async function cmdHotfix(argv: string[]): Promise<void> {
  const sub = argv[0]
  if (!sub) {
    console.error('gks hotfix: missing subcommand. Try: open | list | close | check')
    process.exit(1)
  }
  const rest = argv.slice(1)
  switch (sub) {
    case 'open': await cmdHotfixOpen(rest); break
    case 'list': await cmdHotfixList(rest); break
    case 'close': await cmdHotfixClose(rest); break
    case 'check': await cmdHotfixCheck(rest); break
    default:
      console.error(`gks hotfix: unknown subcommand '${sub}'`)
      process.exit(1)
  }
}

function openHotfixStore(flags: GlobalFlags): HotfixStore {
  return new HotfixStore({ root: flags.root })
}

async function cmdHotfixOpen(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...GLOBAL_OPTIONS,
      sha: { type: 'string' },
      title: { type: 'string' },
      file: { type: 'string', multiple: true },
      reason: { type: 'string' },
      ref: { type: 'string' },
      'related-incident': { type: 'string', multiple: true },
    },
  })
  const flags = readGlobals(values)
  const sha = (values['sha'] as string | undefined) ?? positionals[0]
  if (!sha) {
    console.error('gks hotfix open: missing --sha=... (or positional commit SHA)')
    process.exit(1)
  }
  const title = (values['title'] as string | undefined) ?? `Hotfix at ${sha.slice(0, 7)}`
  const store = openHotfixStore(flags)
  const hotfix = await store.open({
    commitSha: sha,
    title,
    files: values['file'] as string[] | undefined,
    reason: values['reason'] as string | undefined,
    ref: values['ref'] as string | undefined,
    relatedIncidents: values['related-incident'] as string[] | undefined,
  })
  emit(flags, hotfix, () => {
    console.log(`opened ${hotfix.id}`)
    console.log(`  valid_to: ${hotfix.valid_to}  (48h backfill window)`)
    if (hotfix.linked_symbols?.length) {
      console.log(`  files:    ${hotfix.linked_symbols.map((s) => s.file).join(', ')}`)
    }
  })
}

async function cmdHotfixList(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { ...GLOBAL_OPTIONS, overdue: { type: 'boolean' }, pending: { type: 'boolean' } },
  })
  const flags = readGlobals(values)
  const store = openHotfixStore(flags)
  const all = values['overdue'] ? await store.listOverdue() : await store.list()
  const filtered = values['pending'] ? all.filter((h) => !h.closed_at) : all
  emit(flags, filtered, () => {
    if (filtered.length === 0) {
      console.log('no hotfixes')
      return
    }
    const now = new Date()
    for (const h of filtered) {
      const overdue = isOverdue(h, now) ? ' [OVERDUE]' : ''
      const closed = h.closed_at ? ' [closed]' : ''
      console.log(`${h.id}  valid_to=${h.valid_to}${overdue}${closed}  ${h.title}`)
    }
  })
}

async function cmdHotfixClose(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ...GLOBAL_OPTIONS, 'resolved-by': { type: 'string', multiple: true } },
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  if (!id) {
    console.error('gks hotfix close: missing HOTFIX-- id')
    process.exit(1)
  }
  const resolvedBy = (values['resolved-by'] as string[] | undefined) ?? []
  if (resolvedBy.length === 0) {
    console.error('gks hotfix close: --resolved-by=... is required (e.g. ADR--MY-FIX)')
    process.exit(1)
  }
  const store = openHotfixStore(flags)
  const hotfix = await store.close(id, resolvedBy)
  emit(flags, hotfix, () => {
    console.log(`closed ${hotfix.id}  resolved_by=${hotfix.crosslinks?.resolved_by?.join(', ')}`)
  })
}

/**
 * Pre-commit gate: exits non-zero if any overdue hotfix touches the
 * supplied --file paths. Used by examples/drift-detection/hotfix-gate.sh.
 */
async function cmdHotfixCheck(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { ...GLOBAL_OPTIONS, file: { type: 'string', multiple: true } },
  })
  const flags = readGlobals(values)
  const files = new Set(((values['file'] as string[] | undefined) ?? []).map((f) => f.trim()).filter(Boolean))
  const store = openHotfixStore(flags)
  const overdue = await store.listOverdue()
  const blocking = overdue.filter((h) => {
    if (files.size === 0) return true
    const touched = h.linked_symbols?.map((s) => s.file) ?? []
    return touched.some((f) => files.has(f))
  })
  if (blocking.length === 0) {
    if (!flags.json) console.log('hotfix gate: clear')
    return
  }
  emit(flags, { blocking }, () => {
    console.error(`hotfix gate: ${blocking.length} overdue hotfix(es) block this commit`)
    for (const h of blocking) {
      console.error(`  ${h.id}  valid_to=${h.valid_to}  ${h.title}`)
      console.error(`    backfill missing — write CONCEPT/ADR/BLUEPRINT then \`gks hotfix close ${h.id} --resolved-by=...\``)
    }
  })
  process.exit(1)
}

// ─── chain walker (ADR-014 item 3) ─────────────────────────────────────────

async function cmdVerifyFlow(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: GLOBAL_OPTIONS,
  })
  const flags = readGlobals(values)
  const id = positionals[0]
  if (!id) {
    console.error('gks verify-flow: missing atom id (e.g. FEAT--MY-FEATURE)')
    process.exit(1)
  }
  const store = await openStore(flags)
  // We need direct access to the index map; open the AtomicLayer via
  // MemoryStore.atomic.
  const atomic = store.atomic
  await atomic.loadIndex()
  const byId = new Map<string, ReturnType<typeof atomic.filter>[number]>()
  for (const e of atomic.filter({})) byId.set(e.id, e)
  const result = verifyFlow(id, byId)
  emit(flags, result, () => {
    for (const line of formatVerifyFlowResult(result)) console.log(line)
  })
  if (!result.ok) process.exit(1)
}

// ─── link checker (ADR-014 item 6) ─────────────────────────────────────────

async function cmdValidate(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { ...GLOBAL_OPTIONS, links: { type: 'boolean' } },
  })
  const flags = readGlobals(values)
  // Default mode is --links — it's the only check we ship today.
  const store = await openStore(flags)
  await store.atomic.loadIndex()
  const byId = new Map<string, ReturnType<typeof store.atomic.filter>[number]>()
  for (const e of store.atomic.filter({})) byId.set(e.id, e)
  const result = validateLinks(byId)
  emit(flags, result, () => {
    for (const line of formatValidateLinksResult(result)) console.log(line)
  })
  if (!result.ok) process.exit(1)
}

// ─── new-feature scaffolder (ADR-014 item 5) ───────────────────────────────

async function cmdNewFeature(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ...GLOBAL_OPTIONS,
      slug: { type: 'string' },
      title: { type: 'string' },
      concept: { type: 'string' },
      adr: { type: 'string' },
      'blueprint-file': { type: 'string', multiple: true },
      task: { type: 'string', multiple: true },
      'task-tracker': { type: 'string' },
    },
  })
  const flags = readGlobals(values)
  const slug = (values['slug'] as string | undefined) ?? positionals[0]
  if (!slug) {
    console.error('gks new-feature: missing slug (positional or --slug=...)')
    process.exit(1)
  }
  const title = (values['title'] as string | undefined) ?? slug
  const trackerInput = (values['task-tracker'] as string | undefined) ?? 'msp'
  if (!['local', 'msp', 'external'].includes(trackerInput)) {
    console.error(`gks new-feature: invalid --task-tracker '${trackerInput}' (expected local|msp|external)`)
    process.exit(1)
  }
  const store = await openStore(flags)
  const result = await scaffoldNewFeature(store.inbound, {
    slug,
    title,
    conceptBody: values['concept'] as string | undefined,
    adrBody: values['adr'] as string | undefined,
    blueprintFiles: values['blueprint-file'] as string[] | undefined,
    tasks: values['task'] as string[] | undefined,
    taskTracker: trackerInput as 'local' | 'msp' | 'external',
    repoRoot: flags.root,
    namespace: flags.namespace.tenant_id ?? 'default',
  })
  emit(flags, result, () => {
    console.log(`scaffolded ${result.proposed.length} candidate atom(s) in inbound queue:`)
    for (const p of result.proposed) {
      console.log(`  ${p.id.padEnd(36)}  ${p.path}`)
    }
    if (result.tasksWritten?.length) {
      console.log('')
      console.log(`wrote ${result.tasksWritten.length} microtask file(s) (tracker=local, outside gks/):`)
      for (const t of result.tasksWritten) console.log(`  ${t.slug.padEnd(28)}  ${t.path}`)
    }
    if (result.trackerGuidance?.length) {
      console.log('')
      for (const line of result.trackerGuidance) console.log(line)
    }
    console.log('')
    console.log('Review and promote atoms with `gks inbound list` / `gks inbound promote`.')
  })
}

// ─── shared helpers ────────────────────────────────────────────────────────

const GLOBAL_OPTIONS = {
  root: { type: 'string' },
  tenant: { type: 'string' },
  user: { type: 'string' },
  agent: { type: 'string' },
  provider: { type: 'string' },
  json: { type: 'boolean' },
} as const

function readGlobals(values: Record<string, unknown>): GlobalFlags {
  const root = resolve(
    (values['root'] as string | undefined) ?? process.env['GKS_ROOT'] ?? process.cwd(),
  )
  const namespace: Namespace = {
    ...(values['tenant'] ? { tenant_id: values['tenant'] as string } : {}),
    ...(values['user'] ? { user_id: values['user'] as string } : {}),
    ...(values['agent'] ? { agent_id: values['agent'] as string } : {}),
  }
  return {
    root,
    namespace,
    json: values['json'] === true,
    ...(values['provider']
      ? { provider: values['provider'] as GlobalFlags['provider'] }
      : {}),
  }
}

async function openStore(flags: GlobalFlags): Promise<MemoryStore> {
  const store = new MemoryStore({
    root: flags.root,
    ...(Object.keys(flags.namespace).length > 0 ? { defaultNamespace: flags.namespace } : {}),
    ...(flags.provider && flags.provider !== 'auto'
      ? { embedderOptions: { forceProvider: flags.provider } }
      : {}),
  })
  await store.init()
  return store
}

function emit(flags: GlobalFlags, payload: unknown, pretty: () => void): void {
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    pretty()
  }
}

function readPositionalOrStdin(positionals: string[], op: string): string {
  if (positionals.length > 0) return positionals.join(' ')
  if (process.stdin.isTTY) {
    console.error(`gks ${op}: missing argument and stdin is a TTY`)
    process.exit(1)
  }
  // Synchronous stdin read — small inputs; CLI agents usually pipe one line.
  const buf = readFileSync(0)
  return buf.toString('utf8').trim()
}

function printUsage(): void {
  console.log(`gks — memory ops CLI

Subcommands
  retain CONTENT [--path=...] [--tag=...] [--conflict-policy=...]
  recall QUERY    [--top-k=5] [--threshold=...] [--strategy=multi] [--cross-namespace]
  lookup ID
  lookup-by-symbol src/x.ts[:fn[:line]]    reverse: which atoms cite this code?
  propose-inbound TYPE--SLUG --title="..." --body="..." [--phase=1] [--type=insight]
                                             [--linked-symbol=src/x.ts:fn:line ...]
  reflect SESSION_ID [--force-consolidate] [--no-persist]
  init                                       scaffold .brain/ dirs in --root
  status                                     show store stats
  issue new "TITLE" [--priority=...] [--label=...] ...   create an ISSUE--
  issue list [--status=open|closed|all] [--priority=...] [--label=...] [--assignee=...]
  issue show ID                              full issue + Discussion
  issue comment ID "TEXT"                    append to Discussion
  issue status ID NEW_STATUS                 open|triaged|in_progress|blocked|closed|wontfix
  issue assign ID ASSIGNEE
  issue close ID [--resolved-by=ADR-...]
  issue dashboard [--md]                     count by status
  hotfix open SHA --title="..." [--file=...] [--reason=...] [--ref=...]
  hotfix list [--overdue] [--pending]
  hotfix close HOTFIX--XXXXXXX --resolved-by=ADR-... [--resolved-by=BLUEPRINT-...]
  hotfix check --file=src/x.ts [--file=src/y.ts]   pre-commit gate; exit-1 if overdue
  verify-flow ID                              walk crosslinks; exit-1 if any node not stable
  validate [--links]                          read-only crosslink integrity check
  new-feature SLUG --title="..." [--concept=...] [--adr=...] [--blueprint-file=src/x.ts ...]
                  [--task=slug ...] [--task-tracker=local|msp|external (default msp)]
                                              scaffold CONCEPT/ADR/FEAT/BLUEPRINT into inbound queue
                                              microtasks (if any) go to the orchestrator (ADR-015)

Global flags
  --root=PATH      repo root (default: cwd, or GKS_ROOT env)
  --tenant=ID      tenant_id stamped on every retain/recall
  --user=ID        user_id
  --agent=ID       agent_id
  --provider=auto|ollama|openai|mock
  --json           machine-readable output

Pass content/queries as positional arg or via stdin.
`)
}

main().catch((err) => {
  console.error('gks:', (err as Error).message)
  if (process.env['GKS_DEBUG']) console.error((err as Error).stack)
  process.exit(1)
})
