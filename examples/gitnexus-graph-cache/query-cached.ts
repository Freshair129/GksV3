/**
 * Query the cached GitNexus call-graph through GKS — no GitNexus
 * round-trip on the read path.
 *
 * After running sync.ts, this script answers questions like:
 *   • "What does X call (transitively, depth 2)?"   → outbound walk
 *   • "Who calls Y?"                                → inbound walk
 *   • "What did the graph look like at date Z?"      → asOf temporal query
 *
 * The pattern: an orchestrator / Memory OS layer (e.g. MSP) does its
 * cross-system correlation by calling THIS surface, not by RPC-ing
 * GitNexus on every request.
 *
 * Usage:
 *   tsx examples/gitnexus-graph-cache/query-cached.ts \
 *       --graph=.brain/msp/projects/evaAI/graph/code.jsonl \
 *       --seed=fn:src/memory/api.ts:retain \
 *       [--depth=2] [--direction=out|in|both] [--rel=calls]
 */

import { parseArgs } from 'node:util'

import { GraphStore } from '../../src/memory/index.js'

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      graph: { type: 'string' },
      seed: { type: 'string' },
      depth: { type: 'string' },
      direction: { type: 'string' },
      rel: { type: 'string' },
      'as-of': { type: 'string' },
    },
  })
  const graphPath = values['graph']
  const seed = values['seed']
  if (!seed) {
    console.error('usage: --seed=<node-id> [--depth=2] [--direction=out|in|both] [--rel=calls] [--as-of=ISO]')
    process.exit(1)
  }
  const depth = Math.max(1, Number(values['depth'] ?? 1))
  const direction = (values['direction'] ?? 'out') as 'out' | 'in' | 'both'

  const graph = new GraphStore(graphPath ? { path: graphPath } : {})
  await graph.load()

  const seedNode = graph.getNode(seed)
  if (!seedNode) {
    console.error(`seed not found in graph: ${seed}`)
    process.exit(2)
  }

  const hits = graph.neighbors(seed, {
    depth,
    direction,
    ...(values['rel'] ? { rel: values['rel'] } : {}),
    ...(values['as-of'] ? { asOf: values['as-of'] } : {}),
  })

  console.log(`seed: ${seed}`)
  console.log(`reached ${hits.length} node(s) at depth ≤ ${depth} (${direction})\n`)
  for (const h of hits) {
    const arrows = '·'.repeat(h.depth)
    const rels = h.path.map((e) => e.rel).join(' → ')
    console.log(`${arrows} ${h.node.id}   [${rels}]`)
  }
}

main().catch((err) => {
  console.error('query failed:', (err as Error).message)
  process.exit(1)
})
