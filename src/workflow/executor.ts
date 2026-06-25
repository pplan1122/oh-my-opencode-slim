/**
 * Workflow executor (MVP — sequential only, no actual agent dispatch).
 *
 * The executor validates a WorkflowPlan for structural correctness
 * (no cycles, valid dependency references) and produces an ordered
 * list of execution instructions that the orchestrator or a hook can
 * consume when dispatching real agent calls.
 *
 * Day 3 hook integration will optionally wire this up to
 * `ctx.client.session.prompt()` for automated execution.
 */

import type { WorkflowPlan } from './types';

/** A single execution instruction derived from a plan step. */
export interface ExecutionInstruction {
  /** Step id (matches WorkflowStep.id). */
  stepId: number;
  /** Target agent. */
  agent: string;
  /**
   * Prompt to send, enriched with results from dependency steps.
   * When no dependency results are available (pre-execution),
   * placeholders like `[Result from Step N]` are kept as-is.
   */
  prompt: string;
  /** Step ids this instruction depends on. */
  dependencies: number[];
}

/** Result of validating a plan. `ok` is false when the plan is broken. */
export interface PlanValidation {
  ok: boolean;
  errors: string[];
}

// ── public API ──────────────────────────────────────────────

/**
 * Validate a plan's structure.
 * Checks: non-empty steps, no cycles, valid dependency ids.
 */
export function validatePlan(plan: WorkflowPlan): PlanValidation {
  const errors: string[] = [];
  if (plan.steps.length === 0) {
    errors.push('Plan has no steps');
  }

  const ids = new Set(plan.steps.map((s) => s.id));

  for (const step of plan.steps) {
    for (const dep of step.dependencies) {
      if (!ids.has(dep)) {
        errors.push(
          `Step ${step.id}: dependency ${dep} does not reference an existing step`,
        );
      }
    }
  }

  // cycle detection via topological sort
  try {
    topologicalSort(plan.steps);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Generate execution instructions from a validated plan.
 * Steps are topologically sorted; each instruction's prompt is
 * enriched with placeholders for its dependency results.
 *
 * Returns null if the plan fails validation.
 */
export function generateExecutionSteps(
  plan: WorkflowPlan,
): ExecutionInstruction[] | null {
  const validation = validatePlan(plan);
  if (!validation.ok) return null;

  const sorted = topologicalSort(plan.steps);

  const resultMap = new Map<number, string>();
  const placeholders = new Map<number, string>();
  for (const step of sorted) {
    placeholders.set(step.id, `[Result from Step ${step.id}]`);
    resultMap.set(step.id, `[Result from Step ${step.id}]`);
  }

  return sorted.map((step) => ({
    stepId: step.id,
    agent: step.agent,
    prompt: enrichPrompt(step, placeholders),
    dependencies: step.dependencies,
  }));
}

// ── internal ────────────────────────────────────────────────

/** Kahn's algorithm. Throws on cycle. */
function topologicalSort(steps: Required<WorkflowPlan>['steps']): Required<WorkflowPlan>['steps'] {
  const inDegree = new Map<number, number>();
  const adj = new Map<number, number[]>();
  const stepMap = new Map(steps.map((s) => [s.id, s]));

  for (const s of steps) {
    inDegree.set(s.id, s.dependencies.length);
    for (const dep of s.dependencies) {
      const list = adj.get(dep) ?? [];
      list.push(s.id);
      adj.set(dep, list);
    }
  }

  const queue = steps.filter((s) => s.dependencies.length === 0).map((s) => s.id);
  const result: ReturnType<typeof topologicalSort> = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    const step = stepMap.get(id);
    if (step) result.push(step);

    for (const nextId of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(nextId) ?? 0) - 1;
      inDegree.set(nextId, newDeg);
      if (newDeg === 0) queue.push(nextId);
    }
  }

  if (result.length !== steps.length) {
    throw new Error('Plan contains a cycle and cannot be executed');
  }

  return result;
}

function enrichPrompt(
  step: WorkflowPlan['steps'][number],
  placeholders: Map<number, string>,
): string {
  const parts = [step.prompt];
  if (step.dependencies.length > 0) {
    const deps = step.dependencies
      .map((id) => `- Step ${id}: ${placeholders.get(id) ?? '[unknown]'}`)
      .join('\n');
    parts.push('', '<PreviousStepResults>', deps, '</PreviousStepResults>');
  }
  return parts.join('\n');
}
