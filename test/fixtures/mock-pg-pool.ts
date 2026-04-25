/**
 * Shared mock for pg.Pool / PoolClient used by pgvector + pg-graph unit tests.
 * Records every query (text + params) and returns canned rows whose key is
 * a substring of the SQL — enough to exercise the SQL-shape assertions
 * without booting a real database.
 */

import type { Pool, PoolClient, QueryResult } from 'pg'

export interface RecordedQuery {
  text: string
  params?: unknown[]
}

export interface MockPool {
  pool: Pool
  queries: RecordedQuery[]
}

export function makeMockPool(rowsByNeedle: Record<string, unknown[]> = {}): MockPool {
  const queries: RecordedQuery[] = []

  const matchRowsFor = (sql: string): unknown[] => {
    for (const [needle, candidate] of Object.entries(rowsByNeedle)) {
      if (sql.includes(needle)) return candidate
    }
    return []
  }

  const fakeQuery = async (sql: unknown, params?: unknown[]): Promise<QueryResult> => {
    const text = typeof sql === 'string' ? sql : ''
    queries.push({ text, ...(params ? { params } : {}) })
    const rows = matchRowsFor(text)
    return {
      rows: rows as Record<string, unknown>[],
      rowCount: rows.length,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as unknown as QueryResult
  }

  const fakeClient: Partial<PoolClient> = {
    query: fakeQuery as unknown as PoolClient['query'],
    release: () => {},
  }

  const fakePool: Partial<Pool> = {
    query: fakeQuery as unknown as Pool['query'],
    connect: async () => fakeClient as PoolClient,
  }

  return { pool: fakePool as Pool, queries }
}
