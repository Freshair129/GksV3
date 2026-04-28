/**
 * Audit log — append-only JSONL trail of memory operations.
 *
 * Every retain / recall / proposeInbound / writeEpisodic emits one event
 * line stamped with the caller's namespace and identifying details. Used
 * for SOC2-style review, debugging cross-tenant questions ("did tenant
 * A's recall accidentally match doc X?"), and post-hoc privacy audits
 * ("show me everything user U asked the agent in the last 30 days").
 *
 * Storage: <root>/.brain/msp/projects/evaAI/audit/audit-YYYY-MM-DD.jsonl,
 * one file per UTC day (rotation is implicit via the filename — no
 * deletion logic needed; operators can ship to S3 / cold storage).
 *
 * Best-effort: every emit is wrapped in try/catch so a disk-full or
 * permissions error never breaks the calling retain/recall. Failures
 * are surfaced via the existing logger.
 */

import { join, resolve } from 'node:path'

import { appendJsonl } from '../lib/jsonl.js'
import { truncate } from '../lib/text.js'
import { createLogger } from '../lib/logger.js'
import type { Namespace } from './types.js'

const log = createLogger('audit')

export type AuditOp =
  | 'retain'
  | 'recall'
  | 'lookup'
  | 'lookup_by_symbol'
  | 'propose_inbound'
  | 'write_episodic'
  | 'patch_metadata'
  | 'issue_create'
  | 'issue_comment'
  | 'issue_status_change'
  | 'issue_assign'
  | 'issue_close'
  | 'hotfix_open'
  | 'hotfix_close'

export interface AuditEvent {
  /** ISO-8601 UTC timestamp. */
  t: string
  /** Operation name. */
  op: AuditOp
  /** Caller namespace, if any. */
  namespace?: Namespace
  /** Document ID (for retain / patch / lookup). */
  doc_id?: string
  /** Query text (for recall) — truncated to 200 chars to avoid PII bloat. */
  query?: string
  /** Number of hits returned (for recall). */
  hit_count?: number
  /** Strategy / source (for recall). */
  strategy?: string
  /** Number of conflicts flagged (for retain). */
  conflicts?: number
  /** Conflicts resolved by supersede (count). */
  invalidated?: number
  /** Inbound review id (for propose_inbound). */
  review_id?: string
  /** Free-form metadata for op-specific extras. */
  meta?: Record<string, unknown>
}

export interface AuditLogOptions {
  /** Absolute path to the audit dir. Created on first emit. */
  dir: string
  /**
   * Per-event hook for shipping to a custom sink (Splunk / Datadog /
   * etc.). Runs after the JSONL append. Best-effort: errors logged,
   * not propagated.
   */
  onEvent?: (event: AuditEvent) => void | Promise<void>
  /** Cap query text length in audit records. Default 200. */
  maxQueryLength?: number
  /** Disable disk writes — only call onEvent. Default false. */
  disableDisk?: boolean
}

export class AuditLog {
  private readonly dir: string
  private readonly onEvent: AuditLogOptions['onEvent']
  private readonly maxQueryLength: number
  private readonly disableDisk: boolean

  constructor(opts: AuditLogOptions) {
    this.dir = resolve(opts.dir)
    this.onEvent = opts.onEvent
    this.maxQueryLength = Math.max(0, opts.maxQueryLength ?? 200)
    this.disableDisk = opts.disableDisk ?? false
  }

  async emit(event: Omit<AuditEvent, 't'> & { t?: string }): Promise<void> {
    const stamped: AuditEvent = {
      t: event.t ?? new Date().toISOString(),
      op: event.op,
      ...(event.namespace ? { namespace: event.namespace } : {}),
      ...(event.doc_id !== undefined ? { doc_id: event.doc_id } : {}),
      ...(event.query !== undefined
        ? { query: truncate(event.query, this.maxQueryLength) }
        : {}),
      ...(event.hit_count !== undefined ? { hit_count: event.hit_count } : {}),
      ...(event.strategy !== undefined ? { strategy: event.strategy } : {}),
      ...(event.conflicts !== undefined ? { conflicts: event.conflicts } : {}),
      ...(event.invalidated !== undefined ? { invalidated: event.invalidated } : {}),
      ...(event.review_id !== undefined ? { review_id: event.review_id } : {}),
      ...(event.meta ? { meta: event.meta } : {}),
    }

    if (!this.disableDisk) {
      try {
        // appendJsonl mkdirs the parent dir, so we don't pre-create here.
        await appendJsonl(this.filePath(stamped.t), stamped)
      } catch (err) {
        // Disk pressure / permissions / EROFS — surfaceable but never
        // fatal: operational visibility shouldn't break the caller.
        log.warn('audit emit failed (disk)', {
          op: stamped.op,
          err: (err as Error).message,
        })
      }
    }

    if (this.onEvent) {
      try {
        await this.onEvent(stamped)
      } catch (err) {
        log.warn('audit onEvent hook failed', {
          op: stamped.op,
          err: (err as Error).message,
        })
      }
    }
  }

  /** Daily-rotated path: audit-YYYY-MM-DD.jsonl. */
  filePath(iso: string): string {
    const day = iso.slice(0, 10) // YYYY-MM-DD
    return join(this.dir, `audit-${day}.jsonl`)
  }

  getDir(): string {
    return this.dir
  }
}

