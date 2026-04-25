/**
 * Vector store manifest — tracks embedder model, dimension, doc count, file
 * hashes. Used by the rebuild script to skip unchanged files and to detect
 * incompatible embedder changes (forces full re-embed when model changes).
 */

import { access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { VectorManifest } from '../types.js'
import { CURRENT_SCHEMA_VERSION } from '../../lib/schema-version.js'
import { readJson, writeJson } from '../../lib/jsonl.js'

export const MANIFEST_FILENAME = '_manifest.json'

export async function readManifest(storeDir: string): Promise<VectorManifest | null> {
  const path = join(storeDir, MANIFEST_FILENAME)
  try {
    await access(path)
  } catch {
    return null
  }
  return readJson<VectorManifest>(path)
}

export async function writeManifest(
  storeDir: string,
  manifest: VectorManifest,
): Promise<void> {
  await writeJson(join(storeDir, MANIFEST_FILENAME), manifest)
}

export function emptyManifest(model: string, dimension: number): VectorManifest {
  return {
    embedder_model: model,
    dimension,
    doc_count: 0,
    last_updated: new Date().toISOString(),
    file_hashes: {},
    schema_version: CURRENT_SCHEMA_VERSION,
  }
}

/** True iff the manifest is compatible with the given embedder. */
export function manifestCompatible(
  m: VectorManifest,
  embedderModel: string,
  dimension: number,
): boolean {
  return m.embedder_model === embedderModel && m.dimension === dimension
}

export async function fileMtimeKey(path: string): Promise<string> {
  const s = await stat(path)
  return `${s.size}:${Math.floor(s.mtimeMs)}`
}
