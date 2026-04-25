#!/usr/bin/env node
/**
 * gks-mcp-server — stdio entry point.
 *
 * Usage from a Claude Code config (`~/.config/claude/mcp.json`):
 *
 *   {
 *     "mcpServers": {
 *       "gks": {
 *         "command": "npx",
 *         "args": ["tsx", "/path/to/gks-v3/bin/gks-mcp-server.ts",
 *                  "--root=/path/to/gks-data",
 *                  "--tenant=alice"]
 *       }
 *     }
 *   }
 *
 * Or via npm (after publish): `npx gks-mcp-server --root=...`.
 *
 * Flags / env
 *   --root          Root directory for the MemoryStore (DEFAULT: cwd)
 *   --tenant        Tenant id stamped on every retain/recall (defaultNamespace)
 *   --user          User id (defaultNamespace.user_id)
 *   --agent         Agent id (defaultNamespace.agent_id)
 *   --provider      Embedder provider override (auto/ollama/openai/mock)
 *   --pg-url        Postgres URL (enables pgvector backend)
 *   --hnsw          Use HNSW backend (in-process, no Postgres)
 *   --expose-cross-namespace  Expose admin tool (default off)
 *
 *   GKS_MCP_ROOT, GKS_MCP_TENANT, ... env vars all map to the same flags.
 */

import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  MemoryStore,
  createHnswBackend,
  createPgvectorBackend,
  gksLayout,
  type Namespace,
  type VectorBackendFactory,
} from '../src/memory/index.js'
import { runGksMcpServerStdio } from '../src/mcp-server/index.js'
import { createLogger } from '../src/lib/logger.js'

const log = createLogger('bin:gks-mcp-server')

interface CliOpts {
  root: string
  tenant?: string
  user?: string
  agent?: string
  provider?: 'auto' | 'ollama' | 'openai' | 'mock'
  pgUrl?: string
  hnsw: boolean
  exposeCrossNamespace: boolean
}

function parseCli(): CliOpts {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      root: { type: 'string' },
      tenant: { type: 'string' },
      user: { type: 'string' },
      agent: { type: 'string' },
      provider: { type: 'string' },
      'pg-url': { type: 'string' },
      hnsw: { type: 'boolean' },
      'expose-cross-namespace': { type: 'boolean' },
    },
  })
  const root = resolve(
    (values.root as string | undefined) ?? process.env['GKS_MCP_ROOT'] ?? process.cwd(),
  )
  return {
    root,
    ...(values.tenant ? { tenant: values.tenant as string } : process.env['GKS_MCP_TENANT'] ? { tenant: process.env['GKS_MCP_TENANT'] } : {}),
    ...(values.user ? { user: values.user as string } : {}),
    ...(values.agent ? { agent: values.agent as string } : {}),
    ...(values.provider ? { provider: values.provider as CliOpts['provider'] } : {}),
    ...(values['pg-url'] ? { pgUrl: values['pg-url'] as string } : process.env['DATABASE_URL'] ? { pgUrl: process.env['DATABASE_URL'] } : {}),
    hnsw: values.hnsw === true,
    exposeCrossNamespace: values['expose-cross-namespace'] === true,
  }
}

async function main(): Promise<void> {
  const opts = parseCli()

  const ns: Namespace = {
    ...(opts.tenant ? { tenant_id: opts.tenant } : {}),
    ...(opts.user ? { user_id: opts.user } : {}),
    ...(opts.agent ? { agent_id: opts.agent } : {}),
  }

  let vectorBackend: VectorBackendFactory | undefined
  if (opts.pgUrl) {
    const pg = (await import('pg')).default
    const pool = new pg.Pool({ connectionString: opts.pgUrl })
    vectorBackend = (name, embedder) => createPgvectorBackend({ pool, name, embedder })
  } else if (opts.hnsw) {
    const layout = gksLayout(opts.root)
    vectorBackend = (name, embedder) =>
      createHnswBackend({
        basePath: join(layout.vector, name),
        embedder,
        name,
      })
  }

  const store = new MemoryStore({
    root: opts.root,
    defaultNamespace: ns,
    ...(opts.provider && opts.provider !== 'auto'
      ? { embedderOptions: { forceProvider: opts.provider } }
      : {}),
    ...(vectorBackend ? { vectorBackend } : {}),
  })
  await store.init()

  await runGksMcpServerStdio({
    store,
    defaultNamespace: ns,
    exposeCrossNamespace: opts.exposeCrossNamespace,
  })
}

main().catch((err) => {
  log.error('gks-mcp-server failed to start', {
    err: (err as Error).message,
    stack: (err as Error).stack,
  })
  process.exit(1)
})
