/**
 * Bidirectional doc/code drift detector — the application that
 * ADR-010 envisioned.
 *
 * Pipeline (per ADR-009 — orchestrator combines two peer subsystems):
 *
 *   git diff (or stdin) ─→ list of changed code paths
 *                            │
 *                ┌───────────┴────────────┐
 *                ▼                        ▼
 *        gks.lookupBySymbol       graph.neighbors (cached
 *        (which atoms cite        GitNexus call edges —
 *        this code?)              which code is downstream?)
 *                │                        │
 *                └───────────┬────────────┘
 *                            ▼
 *                 risk-classified report
 *                  HIGH / MEDIUM / LOW / NONE
 *
 * GKS knows nothing about GitNexus (per ADR-009). This script lives
 * outside `src/` and acts as the orchestrator that fans out to both,
 * then merges. The graph data shown here would in production be
 * synced periodically by `examples/gitnexus-graph-cache/sync.ts`.
 *
 * Usage:
 *   tsx check-drift.ts --root=fixtures \
 *       --graph=fixtures/code-graph.jsonl \
 *       --paths=src/memory/consolidator-llm.ts:formatStep
 *   echo "src/x.ts:foo" | tsx check-drift.ts --stdin --root=...
 *   git diff --name-only main | tsx check-drift.ts --stdin --root=...
 *
 * Exit code:
 *   0  no HIGH or MEDIUM citations (safe to push)
 *   1  HIGH or MEDIUM citations exist (review docs before pushing)
 *   2  argument / I/O error
 */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  GraphStore,
  MemoryStore,
  type AtomicEntry,
} from '../../src/memory/index.js'

// ── Risk classification ────────────────────────────────────────────────────
//
// Maps atom types to severity. Conservative defaults: governance docs
// (ADR / BLUEPRINT) are HIGH because shipping code that drifts from them
// breaks the doc-before-code contract; design docs (FEAT / CONCEPT / FLOW)
// are MEDIUM because a stale spec misleads reviewers; insights / facts /
// frames are LOW (informative but rarely load-bearing).

type Risk = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'

function riskOf(type: string): Risk {
  const t = type.toLowerCase()
  if (t === 'adr' || t === 'blueprint') return 'HIGH'
  if (t === 'feat' || t === 'concept' || t === 'flow') return 'MEDIUM'
  if (t === 'insight' || t === 'fact' || t === 'frame') return 'LOW'
  return 'LOW'
}

const RISK_RANK: Record<Risk, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 }
const max = (a: Risk, b: Risk): Risk => (RISK_RANK[a] >= RISK_RANK[b] ? a : b)

// ── Paths from input ───────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => (data += chunk))
    process.stdin.on('end', () => resolve(data))
  })
}

function splitPaths(raw: string): string[] {
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ── Graph impact (downstream callers) ──────────────────────────────────────
//
// Given a code path like "src/memory/inbound.ts:propose", look up its
// node in the cached call graph and walk inbound edges (who calls this?).
// Returns a flat list of caller node IDs, deduped.

function symbolToNodeId(symbolPath: string): string {
  // Convention from examples/gitnexus-graph-cache/fixtures: fn:<file>:<name>
  // We only build node IDs when both file + fn are present.
  return `fn:${symbolPath}`
}

async function inboundCallers(graph: GraphStore, symbolPath: string, depth: number): Promise<string[]> {
  const nodeId = symbolToNodeId(symbolPath)
  if (!graph.getNode(nodeId)) return []
  const hits = graph.neighbors(nodeId, { direction: 'in', depth, rel: 'calls' })
  return hits.map((h) => h.node.id)
}

// ── Per-path drift report ──────────────────────────────────────────────────

interface DriftReport {
  path: string
  citing: AtomicEntry[]
  callers: string[]
  risk: Risk
}

async function checkPath(
  store: MemoryStore,
  graph: GraphStore | null,
  path: string,
  depth: number,
): Promise<DriftReport> {
  const citing = await store.lookupBySymbol(path)
  const callers = graph ? await inboundCallers(graph, path, depth) : []
  const risk = citing.reduce<Risk>((acc, e) => max(acc, riskOf(e.type)), 'NONE')
  return { path, citing, callers, risk }
}

// ── Output ─────────────────────────────────────────────────────────────────

function emitText(reports: DriftReport[]): void {
  for (const r of reports) {
    console.log(`  ${r.risk.padEnd(7)} ${r.path}`)
    for (const a of r.citing) {
      console.log(`            ▸ ${a.id.padEnd(36)} ${a.title ?? ''}`)
    }
    if (r.callers.length > 0) {
      console.log(`            ↑ called by: ${r.callers.join(', ')}`)
    }
  }
  const high = reports.filter((r) => r.risk === 'HIGH').length
  const medium = reports.filter((r) => r.risk === 'MEDIUM').length
  console.log('')
  if (high + medium > 0) {
    console.log(
      `⚠ ${high + medium} path(s) need doc review before push (${high} HIGH, ${medium} MEDIUM).`,
    )
  } else {
    console.log('✓ no doc/code drift signals.')
  }
}

function emitJson(reports: DriftReport[]): void {
  const summary = {
    high: reports.filter((r) => r.risk === 'HIGH').length,
    medium: reports.filter((r) => r.risk === 'MEDIUM').length,
    low: reports.filter((r) => r.risk === 'LOW').length,
    none: reports.filter((r) => r.risk === 'NONE').length,
  }
  const out = {
    summary,
    paths: reports.map((r) => ({
      path: r.path,
      risk: r.risk,
      citing: r.citing.map((e) => ({ id: e.id, type: e.type, title: e.title })),
      callers: r.callers,
    })),
    review_needed: summary.high + summary.medium > 0,
  }
  console.log(JSON.stringify(out, null, 2))
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string' },
      graph: { type: 'string' },
      paths: { type: 'string' },
      stdin: { type: 'boolean' },
      depth: { type: 'string' },
      json: { type: 'boolean' },
    },
  })

  const root = resolve(values['root'] ?? process.cwd())
  const depth = Math.max(1, Number(values['depth'] ?? 2))

  // Collect changed paths.
  let raw = ''
  if (values['stdin']) raw = await readStdin()
  if (values['paths']) raw += '\n' + (values['paths'] as string)
  const paths = splitPaths(raw)
  if (paths.length === 0) {
    console.error('check-drift: no paths supplied (use --paths=... or --stdin)')
    process.exit(2)
  }

  const store = new MemoryStore({ root })
  await store.init()

  let graph: GraphStore | null = null
  if (values['graph']) {
    graph = new GraphStore({ path: resolve(values['graph']) })
    await graph.load()
  }

  const reports: DriftReport[] = []
  for (const p of paths) {
    reports.push(await checkPath(store, graph, p, depth))
  }

  if (values['json']) emitJson(reports)
  else emitText(reports)

  const reviewNeeded = reports.some((r) => r.risk === 'HIGH' || r.risk === 'MEDIUM')
  process.exit(reviewNeeded ? 1 : 0)
}

main().catch((err) => {
  console.error('check-drift failed:', (err as Error).message)
  process.exit(2)
})
