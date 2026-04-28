/**
 * new-feature scaffolder tests (ADR-014 item 5; tasks per ADR-015).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InboundQueue } from '../../src/memory/inbound.js'
import { scaffoldNewFeature } from '../../src/scaffold/new-feature.js'

describe('scaffoldNewFeature', () => {
  let root = ''
  let inboundDir = ''
  let inbound: InboundQueue

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gks-scaffold-'))
    inboundDir = join(root, 'inbound')
    inbound = new InboundQueue({ inboundDir })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('drops 4 candidates (CONCEPT/ADR/FEAT/BLUEPRINT) into the inbound queue', async () => {
    const result = await scaffoldNewFeature(inbound, {
      slug: 'rate-limit',
      title: 'Per-tenant rate limiting',
      blueprintFiles: ['src/api/rate-limit.ts', 'src/db/users.ts'],
    })
    expect(result.proposed).toHaveLength(4)
    expect(result.proposed.map((p) => p.id)).toEqual([
      'CONCEPT--RATE-LIMIT',
      'ADR--RATE-LIMIT',
      'FEAT--RATE-LIMIT',
      'BLUEPRINT--RATE-LIMIT',
    ])
    const files = await readdir(inboundDir)
    expect(files).toHaveLength(4)
  })

  it('embeds blueprintFiles as linked_symbols on FEAT and BLUEPRINT', async () => {
    await scaffoldNewFeature(inbound, {
      slug: 'auth',
      title: 'Auth flow',
      blueprintFiles: ['src/auth/jwt.ts'],
    })
    const files = await readdir(inboundDir)
    const featFile = files.find((f) => f.startsWith('FEAT--AUTH.'))
    const blueprintFile = files.find((f) => f.startsWith('BLUEPRINT--AUTH.'))
    expect(featFile).toBeDefined()
    expect(blueprintFile).toBeDefined()
    const featText = await readFile(join(inboundDir, featFile!), 'utf8')
    const blueprintText = await readFile(join(inboundDir, blueprintFile!), 'utf8')
    expect(featText).toContain('src/auth/jwt.ts')
    expect(blueprintText).toContain('src/auth/jwt.ts')
  })

  it('renders blueprint geography from blueprintFiles', async () => {
    await scaffoldNewFeature(inbound, {
      slug: 'cache',
      title: 'Cache',
      blueprintFiles: ['src/cache.ts'],
    })
    const files = await readdir(inboundDir)
    const blueprint = files.find((f) => f.startsWith('BLUEPRINT--CACHE.'))!
    const text = await readFile(join(inboundDir, blueprint), 'utf8')
    expect(text).toContain('geography:')
    expect(text).toContain('"src/cache.ts"')
  })

  it('does NOT add task atoms — microtasks live outside gks/ (ADR-015)', async () => {
    const result = await scaffoldNewFeature(inbound, {
      slug: 'q',
      title: 'Q',
      tasks: ['validate-input', 'error-mapper'],
      taskTracker: 'msp',
    })
    expect(result.proposed).toHaveLength(4)
    expect(result.proposed.every((p) => !p.id.startsWith('TASK--'))).toBe(true)
    // tracker=msp emits guidance, no files
    expect(result.trackerGuidance?.join('\n')).toContain('VALIDATE-INPUT')
    expect(result.tasksWritten).toBeUndefined()
  })

  it('writes microtask YAML files outside gks/ when --task-tracker=local', async () => {
    const result = await scaffoldNewFeature(inbound, {
      slug: 'rate-limit',
      title: 'rate limit',
      tasks: ['token-bucket', 'middleware'],
      taskTracker: 'local',
      repoRoot: root,
      namespace: 'default',
      blueprintFiles: ['src/api/rl.ts'],
    })
    expect(result.tasksWritten).toHaveLength(2)
    const taskDir = join(root, '.brain', 'default', 'tasks', 'rate-limit')
    expect((await stat(taskDir)).isDirectory()).toBe(true)
    const files = await readdir(taskDir)
    expect(files).toEqual(['T1_token-bucket.task.yaml', 'T2_middleware.task.yaml'])
    const text = await readFile(join(taskDir, files[0]!), 'utf8')
    expect(text).toContain('parent_blueprint: BLUEPRINT--RATE-LIMIT')
    expect(text).toContain('src/api/rl.ts')
    // Confirm nothing landed in gks/
    expect(files.some((f) => f.startsWith('TASK--'))).toBe(false)
  })

  it('emits guidance for --task-tracker=external without writing files', async () => {
    const result = await scaffoldNewFeature(inbound, {
      slug: 'q',
      title: 'Q',
      tasks: ['x'],
      taskTracker: 'external',
    })
    expect(result.tasksWritten).toBeUndefined()
    expect(result.trackerGuidance?.join('\n')).toMatch(/external tracker/i)
  })

  it('rejects an invalid slug', async () => {
    await expect(
      scaffoldNewFeature(inbound, { slug: 'has spaces!', title: 't' }),
    ).rejects.toThrow(/invalid slug/)
  })

  it('uppercases the slug regardless of input casing', async () => {
    const result = await scaffoldNewFeature(inbound, { slug: 'My-Feature', title: 't' })
    expect(result.proposed.every((p) => p.id.includes('--MY-FEATURE'))).toBe(true)
  })
})
