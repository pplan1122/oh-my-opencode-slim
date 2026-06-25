/**
 * Workflow plan parser (MVP — JSON only).
 *
 * Day 0.5 decision: drop the hand-rolled YAML parser from the frozen plan.
 * The orchestrator is instructed to emit a fenced ```json block. We extract
 * the first JSON code fence and parse it. On any failure we return null
 * (never throw) so callers can gracefully fall back to traditional routing.
 */

import type { WorkflowPlan, WorkflowStep } from './types';

/** Matches a fenced code block, optionally tagged `json`. Captures the body. */
const JSON_BLOCK_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

/** Quick check: does the text contain a fenced code block at all? */
export function containsWorkflowPlan(text: string): boolean {
  return JSON_BLOCK_RE.test(text);
}

/**
 * Parse a workflow plan from orchestrator reply text.
 * Returns null if no parseable, structurally-valid plan is found.
 */
export function parseWorkflowPlan(
  text: string,
  originalRequest: string,
): WorkflowPlan | null {
  const match = text.match(JSON_BLOCK_RE);
  if (!match) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(match[1].trim());
  } catch {
    return null;
  }

  if (!isPlanShape(raw)) return null;

  const steps = normalizeSteps(raw.steps);
  if (steps.length === 0) return null;

  return {
    originalRequest,
    steps,
    mode: raw.mode === 'parallel' ? 'parallel' : 'sequential',
    silent: raw.silent === true,
  };
}

// --- internal helpers ---

function isPlanShape(
  v: unknown,
): v is { steps: unknown[]; mode?: unknown; silent?: unknown } {
  return (
    typeof v === 'object' &&
    v !== null &&
    'steps' in v &&
    Array.isArray((v as Record<string, unknown>).steps)
  );
}

/**
 * Coerce raw step objects into valid WorkflowStep[].
 * Steps missing required fields (agent, prompt) are dropped.
 */
function normalizeSteps(rawSteps: unknown[]): WorkflowStep[] {
  const steps: WorkflowStep[] = [];

  rawSteps.forEach((s, idx) => {
    if (typeof s !== 'object' || s === null) return;
    const obj = s as Record<string, unknown>;

    const agent = typeof obj.agent === 'string' ? obj.agent.trim() : '';
    const prompt = typeof obj.prompt === 'string' ? obj.prompt : '';
    if (agent === '' || prompt === '') return;

    const id = typeof obj.id === 'number' ? obj.id : idx + 1;
    const dependencies = Array.isArray(obj.dependencies)
      ? obj.dependencies.filter((d): d is number => typeof d === 'number')
      : [];

    steps.push({
      id,
      agent,
      prompt,
      dependencies,
      verify: obj.verify === true,
    });
  });

  return steps;
}
