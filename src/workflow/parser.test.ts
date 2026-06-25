import { describe, expect, test } from 'bun:test';
import { containsWorkflowPlan, parseWorkflowPlan } from './parser';

describe('containsWorkflowPlan', () => {
  test('detects a fenced json block', () => {
    expect(containsWorkflowPlan('```json\n{}\n```')).toBe(true);
  });

  test('detects an untagged fenced block', () => {
    expect(containsWorkflowPlan('```\n{}\n```')).toBe(true);
  });

  test('returns false for plain prose', () => {
    expect(containsWorkflowPlan('I will delegate to @explorer.')).toBe(false);
  });
});

describe('parseWorkflowPlan', () => {
  test('returns null for plain text (no code block)', () => {
    expect(parseWorkflowPlan('Hello world', 'req')).toBeNull();
  });

  test('parses a valid sequential JSON plan', () => {
    const text = [
      'Here is the plan:',
      '```json',
      JSON.stringify({
        steps: [
          { id: 1, agent: 'explorer', prompt: 'Find auth code', dependencies: [] },
          {
            id: 2,
            agent: 'fixer',
            prompt: 'Add JWT validation',
            dependencies: [1],
            verify: true,
          },
        ],
        mode: 'sequential',
        silent: true,
      }),
      '```',
    ].join('\n');

    const plan = parseWorkflowPlan(text, 'fix auth');
    expect(plan).not.toBeNull();
    expect(plan?.originalRequest).toBe('fix auth');
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[1].agent).toBe('fixer');
    expect(plan?.steps[1].dependencies).toEqual([1]);
    expect(plan?.steps[1].verify).toBe(true);
    expect(plan?.mode).toBe('sequential');
    expect(plan?.silent).toBe(true);
  });

  test('returns null for malformed JSON', () => {
    const text = '```json\n{ steps: [ broken,,, }\n```';
    expect(parseWorkflowPlan(text, 'req')).toBeNull();
  });

  test('returns null for an empty code block', () => {
    const text = '```json\n\n```';
    expect(parseWorkflowPlan(text, 'req')).toBeNull();
  });

  test('returns null when steps is not an array', () => {
    const text = '```json\n{"steps": "nope"}\n```';
    expect(parseWorkflowPlan(text, 'req')).toBeNull();
  });

  test('returns null when no step has required fields', () => {
    const text = '```json\n{"steps": [{"id": 1}]}\n```';
    expect(parseWorkflowPlan(text, 'req')).toBeNull();
  });

  test('drops invalid steps but keeps valid ones', () => {
    const text = [
      '```json',
      JSON.stringify({
        steps: [
          { agent: 'explorer', prompt: 'ok' },
          { agent: '', prompt: 'missing agent' },
          { agent: 'fixer' }, // missing prompt
        ],
      }),
      '```',
    ].join('\n');

    const plan = parseWorkflowPlan(text, 'req');
    expect(plan).not.toBeNull();
    expect(plan?.steps).toHaveLength(1);
    expect(plan?.steps[0].agent).toBe('explorer');
    // id defaults to index+1 when omitted
    expect(plan?.steps[0].id).toBe(1);
  });

  test('defaults mode to sequential and silent to false', () => {
    const text = '```json\n{"steps":[{"agent":"oracle","prompt":"review"}]}\n```';
    const plan = parseWorkflowPlan(text, 'req');
    expect(plan?.mode).toBe('sequential');
    expect(plan?.silent).toBe(false);
  });

  test('extracts the first JSON block when prose surrounds it', () => {
    const text = [
      'Some reasoning here.',
      '```json',
      '{"steps":[{"agent":"explorer","prompt":"find"}]}',
      '```',
      'Trailing commentary.',
    ].join('\n');
    const plan = parseWorkflowPlan(text, 'req');
    expect(plan).not.toBeNull();
    expect(plan?.steps[0].agent).toBe('explorer');
  });
});
