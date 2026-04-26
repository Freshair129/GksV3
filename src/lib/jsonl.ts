import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

export async function readJsonl<T>(path: string): Promise<T[]> {
  const out: T[] = []
  await forEachJsonl<T>(path, (row) => {
    out.push(row)
  })
  return out
}

export async function forEachJsonl<T>(
  path: string,
  onRow: (row: T, lineNo: number) => void | Promise<void>,
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNo = 0
  for await (const line of rl) {
    lineNo++
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: T
    try {
      parsed = JSON.parse(trimmed) as T
    } catch (err) {
      throw new Error(`Invalid JSONL at ${path}:${lineNo}: ${(err as Error).message}`)
    }
    await onRow(parsed, lineNo)
  }
}

export async function appendJsonl<T>(path: string, row: T): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, JSON.stringify(row) + '\n', 'utf8')
}

export async function writeJsonl<T>(path: string, rows: Iterable<T>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const ws = createWriteStream(path, { encoding: 'utf8' })
  try {
    for (const row of rows) {
      if (!ws.write(JSON.stringify(row) + '\n')) {
        await new Promise<void>((resolve) => ws.once('drain', () => resolve()))
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  }
}

export async function readJson<T>(path: string): Promise<T> {
  const txt = await readFile(path, 'utf8')
  return JSON.parse(txt) as T
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export async function readJsonSafe<T>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path)
  } catch {
    return null
  }
}

/** True iff `path` exists and is accessible. Prefer try/readFile/catch for
 *  hot-path reads to avoid the TOCTOU — use this only for pre-flight checks
 *  (CLI arg validation, benchmark bootstrap). */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
