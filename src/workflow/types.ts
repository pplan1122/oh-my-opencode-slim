/**
 * Workflow planning types (MVP — sequential only).
 *
 * Inspired by Sakana Fugu's Conductor: the orchestrator can emit an explicit,
 * structured workflow plan instead of implicitly routing step by step.
 *
 * MVP scope (Day 1): sequential execution only. The `parallel` mode and
 * concurrency control from the frozen full plan are intentionally omitted
 * here and tracked for a post-Go iteration.
 */

/** A single step in a workflow plan. */
export interface WorkflowStep {
  /** 1-based step identifier, unique within a plan. */
  id: number;
  /** Target agent name (e.g. "explorer", "fixer", "oracle"). */
  agent: string;
  /** Prompt to send to the agent. Should include file paths and context. */
  prompt: string;
  /** Step IDs that must complete before this step runs. Empty = no deps. */
  dependencies: number[];
  /** If true, an Oracle verifier reviews this step's result after it runs. */
  verify?: boolean;
}

/** A parsed workflow plan emitted by the orchestrator. */
export interface WorkflowPlan {
  /** The original user request this plan addresses. */
  originalRequest: string;
  /** Ordered steps. Execution order is derived from `dependencies`. */
  steps: WorkflowStep[];
  /**
   * Execution mode. MVP supports "sequential" only; "parallel" is reserved
   * for a future iteration and currently treated the same as sequential.
   */
  mode: 'sequential' | 'parallel';
  /** If true, intermediate steps are hidden from the user (final result only). */
  silent?: boolean;
}

/** Result of executing a single step. */
export interface StepResult {
  stepId: number;
  agent: string;
  status: 'success' | 'failure' | 'skipped';
  output: string;
  /** Present when the step had `verify: true`. */
  verification?: {
    status: 'accepted' | 'rejected';
    feedback: string;
  };
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}
