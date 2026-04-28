import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AtomicEntry, InboundArtifact } from '../../src/memory/types.js';

/**
 * Minimal Task Tracker stub (Orchestrator-side).
 *
 * Demonstrates how an orchestrator (MSP) owns the live execution state
 * that GKS deliberately excludes per ADR-015.
 */

export interface TaskRow {
  id: string;
  path: string;
  status: 'open' | 'in_progress' | 'blocked' | 'done';
  created_at: string;
  closed_at?: string;
}

export interface ProjectState {
  slug: string;
  blueprint_id: string;
  tasks: TaskRow[];
  created_at: string;
  closed_at?: string;
}

/**
 * Creates a new task project from a BLUEPRINT atom.
 * Reads the 'geography' field to determine which files need tasks.
 */
export async function openProjectFromBlueprint(
  blueprintAtom: AtomicEntry,
  root: string,
  ns: string = 'default'
): Promise<ProjectState> {
  const slug = blueprintAtom.id.split('--')[1]!.toLowerCase();
  const geography = blueprintAtom.geography ?? [];
  
  // State lives in .brain/<ns>/tasks/<slug>/state.json (outside gks/)
  const taskDir = join(root, '.brain', ns, 'tasks', slug);
  await mkdir(taskDir, { recursive: true });

  const tasks: TaskRow[] = geography.map((path: string, index: number) => ({
    id: `T${index + 1}`,
    path,
    status: 'open',
    created_at: new Date().toISOString(),
  }));

  const state: ProjectState = {
    slug,
    blueprint_id: blueprintAtom.id,
    tasks,
    created_at: new Date().toISOString(),
  };

  await writeFile(join(taskDir, 'state.json'), JSON.stringify(state, null, 2));
  return state;
}

/** Returns tasks for a project, optionally filtered by status. */
export async function list(
  root: string,
  slug: string,
  filter?: { status?: TaskRow['status'] },
  ns: string = 'default'
): Promise<TaskRow[]> {
  const statePath = join(root, '.brain', ns, 'tasks', slug, 'state.json');
  const raw = await readFile(statePath, 'utf8');
  const state: ProjectState = JSON.parse(raw);
  
  if (filter?.status) {
    return state.tasks.filter(t => t.status === filter.status);
  }
  return state.tasks;
}

/** Updates the status of a specific task. */
export async function setStatus(
  root: string,
  slug: string,
  taskId: string,
  status: TaskRow['status'],
  ns: string = 'default'
): Promise<void> {
  const taskDir = join(root, '.brain', ns, 'tasks', slug);
  const statePath = join(taskDir, 'state.json');
  const raw = await readFile(statePath, 'utf8');
  const state: ProjectState = JSON.parse(raw);
  
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found in project ${slug}`);
  
  task.status = status;
  if (status === 'done') {
    task.closed_at = new Date().toISOString();
  } else {
    delete task.closed_at;
  }
  
  await writeFile(statePath, JSON.stringify(state, null, 2));
}

/**
 * Closes the project if all tasks are done.
 * Returns an InboundArtifact for the AUDIT-- atom.
 */
export async function closeProject(
  root: string,
  slug: string,
  ns: string = 'default'
): Promise<{ auditCandidate: InboundArtifact | null }> {
  const statePath = join(root, '.brain', ns, 'tasks', slug, 'state.json');
  const raw = await readFile(statePath, 'utf8');
  const state: ProjectState = JSON.parse(raw);
  
  const allDone = state.tasks.every(t => t.status === 'done');
  if (!allDone) return { auditCandidate: null };
  
  state.closed_at = new Date().toISOString();
  await writeFile(statePath, JSON.stringify(state, null, 2));

  // The AUDIT-- atom is the durable record of completion.
  // It references the original BLUEPRINT it verified.
  const auditCandidate: InboundArtifact = {
    proposed_id: `AUDIT--${state.slug.toUpperCase()}`,
    phase: 4,
    type: 'audit',
    title: `Audit: ${state.slug.toUpperCase()}`,
    body: [
      `# Audit: ${state.slug.toUpperCase()}`,
      ``,
      `Project closed at: ${state.closed_at}`,
      ``,
      `## Tasks Completed`,
      ...state.tasks.map(t => `- [x] ${t.id}: ${t.path} (closed: ${t.closed_at})`),
      ``,
      `## References`,
      `- [[${state.blueprint_id}]]`,
    ].join('\n'),
    reason: `All tasks from ${state.blueprint_id} are completed.`,
  };

  return { auditCandidate };
}
