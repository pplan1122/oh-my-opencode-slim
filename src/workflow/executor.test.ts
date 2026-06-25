import { describe, expect, test } from 'bun:test';
import {
  generateExecutionSteps,
  validatePlan,
} from './executor';
import type { WorkflowPlan } from './types';

describe('validatePlan', () => {
  test('returns ok for a valid sequential plan', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [
        { id: 1, agent: 'explorer', prompt: 'find', dependencies: [] },
        { id: 2, agent: 'fixer', prompt: 'fix', dependencies: [1] },
      ],
    };
    const result = validatePlan(plan);
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('reports empty steps', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [],
    };
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Plan has no steps');
  });

  test('reports unknown dependency', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [
        { id: 1, agent: 'explorer', prompt: 'find', dependencies: [99] },
      ],
    };
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('99'))).toBe(true);
  });

  test('detects a cycle', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [
        { id: 1, agent: 'a', prompt: 'x', dependencies: [2] },
        { id: 2, agent: 'b', prompt: 'y', dependencies: [1] },
      ],
    };
    const result = validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('cycle'))).toBe(true);
  });
});

describe('generateExecutionSteps', () => {
  test('topologically sorts a linear chain', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [
        { id: 1, agent: 'explorer', prompt: 'Find auth', dependencies: [] },
        { id: 2, agent: 'fixer', prompt: 'Fix auth', dependencies: [1] },
      ],
    };
    const steps = generateExecutionSteps(plan);
    expect(steps).not.toBeNull();
    expect(steps!.map((s) => s.stepId)).toEqual([1, 2]);
  });

  test('enriches prompt with dependency placeholders', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [
        { id: 1, agent: 'explorer', prompt: 'find stuff', dependencies: [] },
        { id: 2, agent: 'fixer', prompt: 'fix stuff', dependencies: [1] },
      ],
    };
    const steps = generateExecutionSteps(plan);
    expect(steps![1].prompt).toContain('<PreviousStepResults>');
    expect(steps![1].prompt).toContain('[Result from Step 1]');
  });

  test('returns null for an invalid plan', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [
        { id: 1, agent: 'a', prompt: 'x', dependencies: [2] },
        { id: 2, agent: 'b', prompt: 'y', dependencies: [1] },
      ],
    };
    expect(generateExecutionSteps(plan)).toBeNull();
  });

  test('handles a diamond dependency (1→2, 1→3, 2+3→4)', () => {
    const plan: WorkflowPlan = {
      originalRequest: 'test',
      mode: 'sequential',
      steps: [
        { id: 1, agent: 'explorer', prompt: 'find', dependencies: [] },
        { id: 2, agent: 'librarian', prompt: 'docs', dependencies: [1] },
        { id: 3, agent: 'oracle', prompt: 'review', dependencies: [1] },
        { id: 4, agent: 'fixer', prompt: 'fix', dependencies: [2, 3] },
      ],
    };
    const steps = generateExecutionSteps(plan);
    expect(steps).not.toBeNull();
    // 1 must be first; 4 must be last; 2 and 3 between
    const ids = steps!.map((s) => s.stepId);
    expect(ids[0]).toBe(1);
    expect(ids[ids.length - 1]).toBe(4);
    expect(ids).toContain(2);
    expect(ids).toContain(3);
  });
});
