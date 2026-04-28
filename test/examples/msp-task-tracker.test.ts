import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryStore, mockEmbedder } from '../../src/memory/index.js'
import * as tracker from '../../examples/msp-task-tracker/tracker.js'

describe('msp-task-tracker example', () => {
  let root = ''
  let store: MemoryStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-task-test-'))
    store = new MemoryStore({
      root,
      embedder: mockEmbedder(32),
      audit: false,
    })
    await store.init()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('runs the full task lifecycle and proposes an audit', async () => {
    // 1. Setup BLUEPRINT
    const blueprintId = 'BLUEPRINT--TEST'
    const blueprintDir = join(root, 'gks', '03_blueprint')
    await mkdir(blueprintDir, { recursive: true })
    await writeFile(join(blueprintDir, 'test.md'), '# TEST')

    const indexDir = join(root, 'gks', '00_index')
    await mkdir(indexDir, { recursive: true })
    const row = {
      id: blueprintId,
      phase: 3,
      type: 'blueprint',
      status: 'stable',
      vault_id: 'V',
      path: '03_blueprint/test.md',
      geography: ['file1.ts', 'file2.ts']
    }
    await writeFile(join(indexDir, 'atomic_index.jsonl'), JSON.stringify(row) + '\n')
    await store.atomic.loadIndex()

    const bp = await store.atomic.lookup(blueprintId)
    expect(bp).not.toBeNull()

    // 2. Open project
    await tracker.openProjectFromBlueprint(bp!, root)
    const tasks = await tracker.list(root, 'test')
    expect(tasks).toHaveLength(2)

    // 3. Complete tasks
    for (const t of tasks) {
      await tracker.setStatus(root, 'test', t.id, 'done')
    }

    // 4. Close project and propose
    const { auditCandidate } = await tracker.closeProject(root, 'test')
    expect(auditCandidate).not.toBeNull()
    expect(auditCandidate?.proposed_id).toBe('AUDIT--TEST')

    const receipt = await store.inbound.propose(auditCandidate!)
    expect(receipt.path).toContain('AUDIT--TEST')

    // 5. Verify file exists
    const inboundDir = join(root, '.brain', 'msp', 'projects', 'evaAI', 'inbound')
    const files = await readdir(inboundDir)
    expect(files.some(f => f.startsWith('AUDIT--TEST'))).toBe(true)
  })
})
