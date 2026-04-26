/**
 * GitNexus → GKS GraphBackend sync — reference adapter.
 *
 * Reads an AST export produced by GitNexus (or any equivalent code-graph
 * tool) and lands the nodes + edges into GKS's GraphStore as cached
 * snapshots. After sync, callers query GKS directly — no round-trip to
 * GitNexus on the read path.
 *
 * Per ADR-009 ownership boundary:
 *   • GKS knows nothing about GitNexus. This script imports both
 *     systems but lives outside `src/` — it's the orchestrator's job.
 *   • The cached edges are denormalisation, NOT a runtime dependency.
 *     Stale-but-eventually-consistent is the contract.
 *   • In production, an MSP cron / git-post-commit hook calls this.
 *
 * Usage:
 *   tsx examples/gitnexus-graph-cache/sync.ts \
 *       --export=fixtures/gitnexus-export.example.json \
 *       --graph=.brain/msp/projects/evaAI/graph/code.jsonl
 *
 * Each edge gets stamped with:
 *   props: {
 *     source: 'gitnexus',
 *     synced_at: <ISO>,
 *     codebase_sha: <sha>,    // so MSP can detect stale data
 *   }
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { GraphStore } from '../../src/memory/index.js'

// ── shape of the export — keep this loose so different graph tools fit ──

interface GitNexusExport {
  synced_at?: string
  codebase_sha?: string
  nodes: Array<{ id: string; labels: string[]; props?: Record<string, unknown> }>
  edges: Array<{ from: string; to: string; rel: string; props?: Record<string, unknown> }>
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      export: { type: 'string' },
      graph: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  })
  const exportPath = values['export'] ?? 'examples/gitnexus-graph-cache/fixtures/gitnexus-export.example.json'
  const graphPath = values['graph']
  const dryRun = values['dry-run'] === true

  const data = JSON.parse(await readFile(resolve(exportPath), 'utf8')) as GitNexusExport
  const stamp = {
    source: 'gitnexus' as const,
    synced_at: data.synced_at ?? new Date().toISOString(),
    ...(data.codebase_sha ? { codebase_sha: data.codebase_sha } : {}),
  }

  console.log(`[sync] export: ${exportPath}`)
  console.log(`[sync] graph:  ${graphPath ?? '(in-memory)'}`)
  console.log(`[sync] nodes:  ${data.nodes.length}`)
  console.log(`[sync] edges:  ${data.edges.length}`)
  console.log(`[sync] stamp:  ${JSON.stringify(stamp)}`)
  if (dryRun) {
    console.log('[sync] dry-run — no writes')
    return
  }

  const graph = new GraphStore(graphPath ? { path: graphPath } : {})
  await graph.load()

  // 1. Upsert nodes. Repeat-safe — addNode merges on existing id.
  for (const n of data.nodes) {
    await graph.addNode({
      id: n.id,
      labels: n.labels,
      props: { ...(n.props ?? {}), ...stamp },
    })
  }

  // 2. Upsert edges with `supersede: true` so the previous sync's edges
  //    of the same (from, to, rel) are invalidated atomically. This gives
  //    us bi-temporal "what did the call graph look like on date X?"
  //    queries for free.
  let edgeCount = 0
  for (const e of data.edges) {
    await graph.addEdge({
      from: e.from,
      to: e.to,
      rel: e.rel,
      props: { ...(e.props ?? {}), ...stamp },
      supersede: true,
    })
    edgeCount++
  }

  const size = graph.size()
  console.log(`[sync] done — graph now has ${size.nodes} nodes / ${size.edges} edges (${edgeCount} edges from this run)`)
}

main().catch((err) => {
  console.error('[sync] failed:', (err as Error).message)
  process.exit(1)
})
