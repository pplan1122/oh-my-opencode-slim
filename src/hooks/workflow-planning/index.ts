/**
 * Workflow Planning Hook
 *
 * Phase 1 (messages.transform): detect orchestrator JSON plans, inject
 *   progress nudges and verification reminders.
 * Phase 2 (tool.execute.before):  when a task call matches a plan step,
 *   enrich its prompt with actual results from prior dependency steps.
 * Phase 3 (tool.execute.after):  capture task output as step result.
 * Phase 4 (implicit): when a step with `verify: true` completes in Phase 3,
 *   the next messages.transform will inject a verification nudge telling
 *   the orchestrator to dispatch @oracle for review.
 */

import {
  containsWorkflowPlan,
  generateExecutionSteps,
  parseWorkflowPlan,
} from '../../workflow';
import type { WorkflowPlan } from '../../workflow/types';
import type { MessageWithParts } from '../types';

// ── internal helpers ───────────────────────────────────────

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function promptSimilarity(a: string, b: string): number {
  const shorter = a.length < b.length ? a : b;
  const longer = a === shorter ? b : a;
  if (shorter.length === 0) return 0;
  let i = 0;
  while (i < shorter.length && shorter[i] === longer[i]) i++;
  return i / shorter.length;
}

const SIMILARITY_THRESHOLD = 0.3;

// ── public factory ──────────────────────────────────────────

export function createWorkflowPlanningHook() {
  const activePlans = new Map<string, WorkflowPlan>();
  const stepResults = new Map<string, string>();
  /** Steps needing verification, keyed by `${sessionID}:${stepId}`. */
  const pendingVerifications = new Set<string>();
  /** Already-nudged verifications to avoid duplicates. */
  const nudgedVerifications = new Set<string>();

  return {
    // ── Phase 1: detect plans + inject nudges ────────────────

    'experimental.chat.messages.transform': async (
      _input: Record<string, never>,
      output: { messages: MessageWithParts[] },
    ): Promise<void> => {
      const { messages } = output;

      // ── 1a: detect orchestrator JSON plans ─────────────────
      for (const message of messages) {
        if (message.info.role !== 'assistant') continue;
        if (message.info.agent && message.info.agent !== 'orchestrator')
          continue;

        for (const part of message.parts) {
          if (part.type !== 'text' || typeof part.text !== 'string') continue;
          if (!containsWorkflowPlan(part.text)) continue;

          const plan = parseWorkflowPlan(part.text, '');
          if (!plan) continue;

          const steps = generateExecutionSteps(plan);
          if (!steps) continue;

          activePlans.set(message.info.sessionID ?? 'default', plan);
          break;
        }
      }

      // ── 1b: inject nudge into latest user message ──────────
      if (activePlans.size === 0 && pendingVerifications.size === 0) return;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.info.role !== 'user') continue;
        if (msg.info.agent && msg.info.agent !== 'orchestrator') continue;

        const sid = msg.info.sessionID ?? 'default';
        const plan = activePlans.get(sid);

        // Collect nudges to inject
        const nudges: string[] = [];

        // Workflow plan progress nudge
        if (plan) {
          const alreadyInjected = msg.parts.some(
            (p) => p.type === 'text' && p.text?.includes('[WorkflowPlan]'),
          );
          if (!alreadyInjected) {
            nudges.push(
              '[WorkflowPlan] Follow the plan step by step. Wait for each step to complete before dispatching the next. Use cancel_task if a step fails.',
            );
          }
        }

        // Verification nudges for completed verify-steps
        for (const vKey of pendingVerifications) {
          if (!vKey.startsWith(`${sid}:`)) continue;
          if (nudgedVerifications.has(vKey)) continue;

          const stepId = Number(vKey.split(':')[1]);
          const step = plan?.steps.find((s) => s.id === stepId);

          nudges.push(
            `[WorkflowPlan] ⚠️ Step ${stepId}${step ? ` (@${step.agent})` : ''} has completed and is marked for verification. Dispatch @oracle with the step ${stepId} result to review before proceeding. Oracle should reply with ACCEPTED or REJECTED + feedback.`,
          );
          nudgedVerifications.add(vKey);
        }

        if (nudges.length === 0) break;

        msg.parts.push({
          type: 'text',
          text: `\n${nudges.map((n) => `[WorkflowPlan] ${n}`).join('\n\n')}\n`,
        });
        break;
      }
    },

    // ── Phase 2: enrich task prompts with prior results ─────

    'tool.execute.before': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { args?: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'task') return;
      if (!isObjectRecord(output.args)) return;

      const agent = typeof output.args.subagent_type === 'string'
        ? output.args.subagent_type.trim()
        : '';
      if (!agent) return;

      const prompt = typeof output.args.prompt === 'string'
        ? output.args.prompt
        : '';
      if (!prompt) return;

      const sid = input.sessionID ?? 'default';
      const plan = activePlans.get(sid);
      if (!plan) return;

      const candidates = plan.steps.filter((s) => {
        if (s.agent !== agent) return false;
        const key = `${sid}:${s.id}`;
        if (stepResults.has(key)) return false;
        return s.dependencies.every((depId) =>
          stepResults.has(`${sid}:${depId}`),
        );
      });

      if (candidates.length === 0) return;

      candidates.sort(
        (a, b) =>
          promptSimilarity(b.prompt, prompt) -
          promptSimilarity(a.prompt, prompt),
      );

      const best = candidates[0];
      if (promptSimilarity(best.prompt, prompt) < SIMILARITY_THRESHOLD) return;

      const depResults: string[] = [];
      for (const depId of best.dependencies) {
        const text = stepResults.get(`${sid}:${depId}`);
        if (text) {
          const depStep = plan.steps.find((s) => s.id === depId);
          const label = depStep
            ? `Step ${depId} (@${depStep.agent})`
            : `Step ${depId}`;
          depResults.push(`### ${label}:\n${text}`);
        }
      }

      if (depResults.length === 0) return;

      output.args = {
        ...output.args,
        prompt: [
          prompt,
          '',
          '---',
          '## Context from Prior Steps',
          depResults.join('\n\n'),
        ].join('\n'),
      };
    },

    // ── Phase 3: capture step results + flag verifications ──

    'tool.execute.after': async (
      input: { tool: string; sessionID?: string; callID?: string },
      output: { output: unknown; metadata?: unknown },
    ): Promise<void> => {
      if (input.tool.toLowerCase() !== 'task') return;

      const sid = input.sessionID ?? 'default';
      const plan = activePlans.get(sid);
      if (!plan) return;

      const text = extractOutputText(output.output);
      if (!text) return;

      const agent = typeof (
        output.metadata as Record<string, unknown> | undefined
      )?.subagent_type === 'string'
        ? (output.metadata as Record<string, unknown>).subagent_type as string
        : '';

      const pendingSteps = plan.steps.filter(
        (s) =>
          !stepResults.has(`${sid}:${s.id}`) &&
          (agent ? s.agent === agent : true),
      );

      for (const step of pendingSteps) {
        const key = `${sid}:${step.id}`;
        if (!stepResults.has(key)) {
          stepResults.set(key, text);

          // Phase 4: if this step has verify:true, flag it for nudging
          if (step.verify) {
            pendingVerifications.add(key);
          }
          break;
        }
      }
    },
  };
}

function extractOutputText(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (isObjectRecord(output) && typeof output.result === 'string') {
    return output.result;
  }
  return null;
}
