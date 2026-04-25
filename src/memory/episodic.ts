/**
 * Layer 4 — Episodic (session memory).
 *
 * Contract from BLUEPRINT--memory §layers.episodic & §write_rules:
 *   - storage: .brain/msp/projects/evaAI/memory/MSP-SESS-{YYMMDD}{SERIAL}.md
 *   - session/*.jsonl append-only during active session
 *   - markdown summary with frontmatter written at consolidation
 */

import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'
import type { EpisodicMemory, TraceStep } from './types.js'
import { appendJsonl, forEachJsonl } from '../lib/jsonl.js'
import { yamlLite } from '../lib/yaml-lite.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('episodic')

export interface EpisodicLayerOptions {
  /** e.g. .brain/msp/projects/evaAI/memory */
  memoryDir: string
  /** e.g. .brain/msp/projects/evaAI/session — per-session trace JSONL lives here */
  sessionDir?: string
}

export class EpisodicLayer {
  private readonly memoryDir: string
  private readonly sessionDir: string

  constructor(opts: EpisodicLayerOptions) {
    this.memoryDir = resolve(opts.memoryDir)
    this.sessionDir = resolve(opts.sessionDir ?? join(opts.memoryDir, '..', 'session'))
  }

  /** Append a single step to the session trace (append-only). */
  async appendTrace(sessionId: string, step: Omit<TraceStep, 'session_id' | 't'> & { t?: string }): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true })
    const record: TraceStep = {
      t: step.t ?? new Date().toISOString(),
      session_id: sessionId,
      kind: step.kind,
      content: step.content,
      ...(step.metadata ? { metadata: step.metadata } : {}),
    }
    await appendJsonl(traceFile(this.sessionDir, sessionId), record)
  }

  /** Read the raw trace for a session (if any). */
  async readTrace(sessionId: string): Promise<TraceStep[]> {
    const path = traceFile(this.sessionDir, sessionId)
    const out: TraceStep[] = []
    try {
      await forEachJsonl<TraceStep>(path, (row) => {
        out.push(row)
      })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') throw err
    }
    return out
  }

  /**
   * Write a consolidated episodic markdown file.
   * Guarantees no silent overwrite: throws if a file already exists at the
   * target path (per write_rules: "NEVER overwrite without git-tracked backup").
   */
  async writeEpisodic(memory: EpisodicMemory): Promise<string> {
    await mkdir(this.memoryDir, { recursive: true })
    const path = episodicPath(this.memoryDir, memory.session_id)
    if (await exists(path)) {
      throw new Error(
        `episodic file already exists: ${path} — refusing to overwrite. ` +
          `Rename or remove it first (write_rules: append-only + git-tracked).`,
      )
    }
    const md = renderEpisodicMarkdown(memory)
    await writeFile(path, md, 'utf8')
    log.info('episodic memory written', { path, session_id: memory.session_id })
    return path
  }

  /** Parse all episodic markdown files in memoryDir — best-effort for recall. */
  async listEpisodic(): Promise<EpisodicSummary[]> {
    const out: EpisodicSummary[] = []
    let entries: string[]
    try {
      entries = await readdir(this.memoryDir)
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return []
      throw err
    }
    for (const f of entries) {
      if (!f.endsWith('.md')) continue
      const path = join(this.memoryDir, f)
      const text = await readFile(path, 'utf8')
      const fm = parseFrontmatter(text)
      out.push({
        path,
        file: f,
        id: (fm['id'] as string | undefined) ?? f,
        session_id: (fm['session_id'] as string | undefined) ?? f,
        body: stripFrontmatter(text),
        frontmatter: fm,
      })
    }
    return out
  }
}

export interface EpisodicSummary {
  path: string
  file: string
  id: string
  session_id: string
  body: string
  frontmatter: Record<string, unknown>
}

function traceFile(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.trace.jsonl`)
}

function episodicPath(dir: string, sessionId: string): string {
  return join(dir, `${sessionId}.md`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

function renderEpisodicMarkdown(m: EpisodicMemory): string {
  const fm = {
    id: m.id,
    session_id: m.session_id,
    started_at: m.started_at,
    ended_at: m.ended_at,
    duration_min: m.duration_min,
    participants: m.participants,
    tokens_total: m.tokens_total ?? null,
    cost_usd: m.cost_usd ?? null,
    tags: m.tags ?? [],
    linked_atoms: m.linked_atoms ?? [],
    emotion_summary: m.emotion_summary ?? '',
    outcomes: m.outcomes ?? [],
  }
  return `---\n${yamlLite(fm)}---\n\n# Session ${m.session_id}\n\n${m.summary.trim()}\n`
}

// yamlLite + yamlScalar live in ../lib/yaml-lite.ts so inbound.ts can share
// the same escape rules.

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end === -1) return {}
  const fmText = text.slice(3, end).trim()
  // Minimal parser — good enough for our own writer. For richer input we fall
  // back to the `yaml` package when needed.
  const out: Record<string, unknown> = {}
  for (const line of fmText.split('\n')) {
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const [, key, rest] = m
    out[key!] = rest ?? ''
  }
  return out
}

function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text
  const end = text.indexOf('\n---', 3)
  if (end === -1) return text
  return text.slice(end + 4).replace(/^\s+/, '')
}
