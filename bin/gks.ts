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
  type Namespace,
} from '../src/memory/index.js'
import { recall, retain, reflect } from '../src/memory/api.js'
import { createLogger } from '../src/lib/logger.js'

const log = createLogger('cli:gks')

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
    },
  })
  const flags = readGlobals(values)
  const proposedId = positionals[0]
  if (!proposedId) {
    console.error('gks propose-inbound: missing proposed atomic id (TYPE--SLUG)')
    process.exit(1)
  }
  const store = await openStore(flags)
  const receipt = await store.proposeInbound({
    proposed_id: proposedId,
    phase: Number(values['phase'] ?? 1) as 0 | 1 | 2 | 3 | 4 | 5,
    type: (values['type'] as string | undefined) ?? 'insight',
    title: (values['title'] as string | undefined) ?? proposedId,
    body: (values['body'] as string | undefined) ?? '',
    ...(values['confidence'] ? { confidence: Number(values['confidence']) } : {}),
  })
  emit(flags, receipt, () => {
    console.log(`✓ ${proposedId} → ${receipt.path}`)
    console.log(`  reviewId: ${receipt.reviewId}`)
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
  const dirs = [
    join(flags.root, '.brain', 'msp', 'projects', 'evaAI', 'memory'),
    join(flags.root, '.brain', 'msp', 'projects', 'evaAI', 'session'),
    join(flags.root, '.brain', 'msp', 'projects', 'evaAI', 'inbound'),
    join(flags.root, '.brain', 'msp', 'projects', 'evaAI', 'vector'),
    join(flags.root, '.brain', 'msp', 'projects', 'evaAI', 'audit'),
    join(flags.root, 'gks', '00_index'),
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

function printUsage(): void {
  console.log(`gks — memory ops CLI

Subcommands
  retain CONTENT [--path=...] [--tag=...] [--conflict-policy=...]
  recall QUERY    [--top-k=5] [--threshold=...] [--strategy=multi] [--cross-namespace]
  lookup ID
  propose-inbound TYPE--SLUG --title="..." --body="..." [--phase=1] [--type=insight]
  reflect SESSION_ID [--force-consolidate] [--no-persist]
  init                                       scaffold .brain/ dirs in --root
  status                                     show store stats

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

void log

main().catch((err) => {
  console.error('gks:', (err as Error).message)
  if (process.env['GKS_DEBUG']) console.error((err as Error).stack)
  process.exit(1)
})
