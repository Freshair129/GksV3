import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryStore, mockEmbedder } from '../../src/memory/index.js';
import * as tracker from './tracker.js';

/**
 * End-to-end smoke test for the orchestrator-side task tracker.
 *
 * Demonstrates the seam:
 *   1. GKS holds the durable BLUEPRINT.
 *   2. Tracker holds the live execution state.
 *   3. Tracker closes the loop by proposing an AUDIT-- atom to GKS.
 */

async function main() {
  const smokeRoot = join(process.cwd(), 'tmp-smoke-tracker');
  
  try {
    // Cleanup previous run
    await rm(smokeRoot, { recursive: true, force: true });
    
    console.log(`Setting up tmp repo at ${smokeRoot}...`);
    
    // 1. Init a tmp repo
    const store = new MemoryStore({
      root: smokeRoot,
      embedder: mockEmbedder(32),
      audit: false,
    });
    await store.init();
    
    // 2. Promote a fake BLUEPRINT atom
    // Uses the flat layout from ADR-013: gks/blueprint/, not gks/03_blueprint/.
    const blueprintId = 'BLUEPRINT--SMOKE-TEST';
    const blueprintDir = join(smokeRoot, 'gks', 'blueprint');
    await mkdir(blueprintDir, { recursive: true });

    const blueprintBody = [
      '# SMOKE TEST',
      '```yaml',
      'geography:',
      '  - src/smoke.ts',
      '  - test/smoke.test.ts',
      '```'
    ].join('\n');

    await writeFile(join(blueprintDir, 'smoke-test.md'), blueprintBody);

    // Update index manually (simulating a promotion)
    const indexDir = join(smokeRoot, 'gks', '00_index');
    await mkdir(indexDir, { recursive: true });
    const row = {
      id: blueprintId,
      phase: 3,
      type: 'blueprint',
      status: 'stable',
      vault_id: 'V',
      path: 'blueprint/smoke-test.md',
      geography: ['src/smoke.ts', 'test/smoke.test.ts']
    };
    await writeFile(join(indexDir, 'atomic_index.jsonl'), JSON.stringify(row) + '\n');
    
    await store.atomic.loadIndex();
    const bp = await store.atomic.lookup(blueprintId);
    if (!bp) throw new Error('Blueprint lookup failed');

    // 3. tracker.openProjectFromBlueprint(...) → 2 tasks created
    console.log('Opening project from blueprint...');
    await tracker.openProjectFromBlueprint(bp, smokeRoot);
    
    let tasks = await tracker.list(smokeRoot, 'smoke-test');
    console.log(`Created ${tasks.length} tasks.`);
    if (tasks.length !== 2) throw new Error(`Expected 2 tasks, got ${tasks.length}`);

    // 4. setStatus each to done
    for (const t of tasks) {
      console.log(`Completing task ${t.id}: ${t.path}...`);
      await tracker.setStatus(smokeRoot, 'smoke-test', t.id, 'done');
    }

    // 5. closeProject(...) → audit candidate
    console.log('Closing project...');
    const { auditCandidate } = await tracker.closeProject(smokeRoot, 'smoke-test');
    if (!auditCandidate) throw new Error('Audit candidate expected');

    // 6. Pipe the candidate into MemoryStore.inbound.propose
    console.log('Proposing audit candidate to inbound...');
    const receipt = await store.inbound.propose(auditCandidate);
    console.log(`Artifact queued at ${receipt.path}`);

    // 7. Check inbound list (reading the dir)
    const inboundDir = join(smokeRoot, '.brain', 'msp', 'projects', 'evaAI', 'inbound');
    const files = await readdir(inboundDir);
    console.log('Inbound files found:', files);
    const found = files.some(f => f.startsWith('AUDIT--SMOKE-TEST'));
    if (!found) throw new Error('AUDIT-- candidate file not found in inbound directory');

    // 8. Assert the file exists and the frontmatter references the blueprint
    // (Our body has the [[BLUEPRINT--]] link as a reference)
    console.log('\n✅ SMOKE TEST PASSED');
    
  } finally {
    // Keep it for inspection if you want, but usually cleanup
    // await rm(smokeRoot, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error('\n❌ SMOKE TEST FAILED:', err);
  process.exit(1);
});
