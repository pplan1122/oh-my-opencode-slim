import { beforeEach, describe, expect, test } from 'bun:test';
import { createWorkflowPlanningHook } from './index';
import type { MessageWithParts } from '../types';

function makeMessage(
  overrides: Partial<{
    role: string;
    agent: string;
    sessionID: string;
    text: string;
  }>,
): MessageWithParts {
  return {
    info: {
      role: overrides.role ?? 'user',
      agent: overrides.agent,
      sessionID: overrides.sessionID ?? 'ses_test',
      id: 'msg-1',
    },
    parts: [{ type: 'text', text: overrides.text ?? 'Hello' }],
  };
}

describe('createWorkflowPlanningHook', () => {
  let hook: ReturnType<typeof createWorkflowPlanningHook>;

  beforeEach(() => {
    hook = createWorkflowPlanningHook();
  });

  test('does nothing when no messages contain a plan', async () => {
    const messages = [makeMessage({ role: 'assistant', agent: 'orchestrator', text: 'I will delegate.' })];
    await hook['experimental.chat.messages.transform']({}, { messages });
    // no crash = pass
    expect(messages[0].parts).toHaveLength(1);
  });

  test('detects a plan in an orchestrator message', async () => {
    const planText = [
      'Here is the plan:',
      '```json',
      '{"steps":[{"agent":"explorer","prompt":"find"}]}',
      '```',
    ].join('\n');

    const assistant = makeMessage({ role: 'assistant', agent: 'orchestrator', text: planText });
    const user = makeMessage({ role: 'user', agent: 'orchestrator', text: 'Continue' });

    await hook['experimental.chat.messages.transform']({}, { messages: [assistant, user] });

    // A progress nudge should have been injected into the user message
    const injected = user.parts.find(
      (p) => p.type === 'text' && p.text?.includes('[WorkflowPlan]'),
    );
    expect(injected).toBeDefined();
  });

  test('does not inject duplicate plan nudges', async () => {
    const planText = '```json\n{"steps":[{"agent":"explorer","prompt":"find"}]}\n```';

    const assistant = makeMessage({ role: 'assistant', agent: 'orchestrator', text: planText });
    const user = makeMessage({ role: 'user', agent: 'orchestrator', text: 'Continue' });

    // First transform: inject
    await hook['experimental.chat.messages.transform']({}, { messages: [assistant, user] });

    const firstCount = user.parts.filter(
      (p) => p.type === 'text' && p.text?.includes('[WorkflowPlan]'),
    ).length;
    expect(firstCount).toBe(1);

    // Second transform on the same session: should NOT inject again
    await hook['experimental.chat.messages.transform']({}, { messages: [assistant, user] });

    const secondCount = user.parts.filter(
      (p) => p.type === 'text' && p.text?.includes('[WorkflowPlan]'),
    ).length;
    expect(secondCount).toBe(1);
  });

  test('ignores non-orchestrator assistant messages', async () => {
    const planText = '```json\n{"steps":[{"agent":"fixer","prompt":"fix"}]}\n```';
    const assistant = makeMessage({ role: 'assistant', agent: 'fixer', text: planText });
    const user = makeMessage({ role: 'user', agent: 'orchestrator', text: 'Continue' });

    await hook['experimental.chat.messages.transform']({}, { messages: [assistant, user] });

    const injected = user.parts.some(
      (p) => p.type === 'text' && p.text?.includes('[WorkflowPlan]'),
    );
    expect(injected).toBe(false);
  });

  test('ignores unparseable JSON blocks gracefully', async () => {
    const badJson = '```json\n{broken]\n```';
    const assistant = makeMessage({ role: 'assistant', agent: 'orchestrator', text: badJson });
    const user = makeMessage({ role: 'user', agent: 'orchestrator', text: 'Continue' });

    await hook['experimental.chat.messages.transform']({}, { messages: [assistant, user] });

    const injected = user.parts.some(
      (p) => p.type === 'text' && p.text?.includes('[WorkflowPlan]'),
    );
    expect(injected).toBe(false);
  });
});

describe('tool.execute integration', () => {
  let hook: ReturnType<typeof createWorkflowPlanningHook>;

  const planText = [
    '```json',
    JSON.stringify({
      steps: [
        { id: 1, agent: 'explorer', prompt: 'Find auth files', dependencies: [] },
        { id: 2, agent: 'fixer', prompt: 'Fix auth', dependencies: [1] },
      ],
      mode: 'sequential',
    }),
    '```',
  ].join('\n');

  async function detectPlan(sessionID = 'ses_test') {
    const assistant = makeMessage({ role: 'assistant', agent: 'orchestrator', text: planText, sessionID });
    const user = makeMessage({ role: 'user', agent: 'orchestrator', text: 'go', sessionID });
    await hook['experimental.chat.messages.transform']({}, { messages: [assistant, user] });
  }

  beforeEach(() => {
    hook = createWorkflowPlanningHook();
  });

  test('enriches step 2 prompt with step 1 result', async () => {
    await detectPlan();

    // Phase 3: step 1 completes via task call
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'ses_test' },
      {
        output: 'Found auth.ts, middleware.ts',
        metadata: { subagent_type: 'explorer' },
      },
    );

    // Phase 2: step 2 is about to be dispatched
    const args: { args: Record<string, unknown> } = {
      args: {
        subagent_type: 'fixer',
        prompt: 'Fix auth',
      },
    };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_test' },
      args,
    );

    const enriched = args.args.prompt as string;
    expect(enriched).toContain('Context from Prior Steps');
    expect(enriched).toContain('Found auth.ts, middleware.ts');
    expect(enriched).toContain('Step 1 (@explorer)');
  });

  test('does not enrich when no plan is active', async () => {
    const args: { args: Record<string, unknown> } = {
      args: { subagent_type: 'fixer', prompt: 'Fix auth' },
    };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_test' },
      args,
    );

    // Prompt unchanged — no "Context from Prior Steps" injected
    expect(args.args.prompt).toBe('Fix auth');
  });

  test('does not enrich when dependencies have no results yet', async () => {
    await detectPlan();

    // Dispatch step 2 immediately — step 1 hasn't completed
    const args: { args: Record<string, unknown> } = {
      args: {
        subagent_type: 'fixer',
        prompt: 'Fix auth',
      },
    };

    await hook['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_test' },
      args,
    );

    // Prompt unchanged because step 1 result is not yet available
    expect(args.args.prompt).toBe('Fix auth');
  });

  test('injects verification nudge when verify-step completes', async () => {
    const planWithVerify = [
      '```json',
      JSON.stringify({
        steps: [
          { id: 1, agent: 'fixer', prompt: 'Fix bug', dependencies: [], verify: true },
        ],
        mode: 'sequential',
      }),
      '```',
    ].join('\n');

    // Detect plan
    const assistant = makeMessage({ role: 'assistant', agent: 'orchestrator', text: planWithVerify, sessionID: 'ses_v' });
    let user = makeMessage({ role: 'user', agent: 'orchestrator', text: 'go', sessionID: 'ses_v' });
    await hook['experimental.chat.messages.transform']({}, { messages: [assistant, user] });

    // Remove the progress nudge so we can test the verification nudge specifically
    user.parts = user.parts.filter(
      (p) => !(p.type === 'text' && p.text?.includes('[WorkflowPlan]')),
    );

    // Complete step 1 with verify: true
    await hook['tool.execute.after'](
      { tool: 'task', sessionID: 'ses_v' },
      {
        output: 'Bug fixed, tests pass.',
        metadata: { subagent_type: 'fixer' },
      },
    );

    // Next transform should inject verification nudge
    user = makeMessage({ role: 'user', agent: 'orchestrator', text: 'next', sessionID: 'ses_v' });
    await hook['experimental.chat.messages.transform']({}, { messages: [user] });

    const verifyNudge = user.parts.find(
      (p) => p.type === 'text' && p.text?.includes('verification'),
    );
    expect(verifyNudge).toBeDefined();
    expect(verifyNudge!.text).toContain('Step 1');
    expect(verifyNudge!.text).toContain('@oracle');
  });
});
