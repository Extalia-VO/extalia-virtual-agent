import { TASK_TIERS, type TaskTier } from '@extalia/core';
import type { EventBody } from '@extalia/protocol';
import { runTurn } from './loop.js';
import type { ModelMessage, ModelProvider } from './model.js';
import type { AnyTool, ToolDefinition } from './tools.js';

/**
 * Orchestration for the Extalia Native agent: the primary agent hands bounded,
 * read-only work (research, review, analysis) to worker agents that run on the
 * model of a task tier. The primary agent keeps every edit and the final answer
 * (single writer), so workers never need approvals.
 */
export interface DelegationOptions {
  /** Provider for a tier; created lazily so unused tiers cost nothing. */
  providerFor(tier: TaskTier): ModelProvider;
  /** Read-only tools available to workers (must not include delegation itself). */
  workerTools: readonly AnyTool[];
  maxDelegations: number;
  workspace: { name: string; root: string };
  /** Events about workers are attributed to the worker's own agent id. */
  emit(body: EventBody, agentId?: string): void;
  newId?: () => string;
  maxWorkerSteps?: number;
}

type DelegateInput = { task: string; tier?: TaskTier; context?: string };

const WORKER_RESULT_LIMIT = 20_000;

export function workerSystemPrompt(workspace: { name: string; root: string }): string {
  return [
    `You are a worker agent helping the primary Extalia agent in the project "${workspace.name}" (${workspace.root}).`,
    'You can list, read and search files, and read memory notes and skills. You cannot edit files or run commands.',
    'Do exactly the task you were given. Look things up instead of guessing.',
    'Reply with concise findings the primary agent can act on: cite file paths with line numbers, and say clearly what you could not determine.',
  ].join('\n');
}

let counter = 0;
const defaultId = () => `worker-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function createDelegationTool(options: DelegationOptions): ToolDefinition<DelegateInput> {
  let used = 0;
  const newId = options.newId ?? defaultId;
  return {
    name: 'delegate_task',
    description:
      'Hand a self-contained, read-only task (research across many files, reviewing a change, comparing approaches) to a worker agent and get its findings back. ' +
      'Workers cannot edit files or run commands; you apply any changes. Choose the tier by difficulty: quick for lookups, standard for typical analysis, complex for hard reasoning. ' +
      `At most ${options.maxDelegations} delegations per turn.`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete instructions: the goal, where to look, and what to report back.' },
        tier: { type: 'string', enum: TASK_TIERS, description: 'quick, standard (default) or complex.' },
        context: { type: 'string', description: 'Facts the worker needs that it cannot find in the project.' },
      },
      required: ['task'],
    },
    access: 'meta',
    kind: 'delegate',
    parallel: true,
    describe: input => {
      const task = input.task.replace(/\s+/g, ' ').trim();
      return { label: `Delegating: ${task.length > 60 ? `${task.slice(0, 59)}…` : task}`, target: input.tier ?? 'standard' };
    },
    async run(input, context) {
      if (used >= options.maxDelegations) {
        return { ok: false, output: `The delegation limit for this turn (${options.maxDelegations}) is reached. Do the remaining work yourself.` };
      }
      used++;
      const tier = input.tier ?? 'standard';
      const subagentId = newId();
      const label = input.task.replace(/\s+/g, ' ').trim().slice(0, 120);
      options.emit({ type: 'subagent.spawned', subagentId, role: tier, label });
      const prompt = input.context ? `${input.task}\n\nContext from the primary agent:\n${input.context}` : input.task;
      let provider: ModelProvider;
      try { provider = options.providerFor(tier); }
      catch (error) {
        options.emit({ type: 'subagent.state', subagentId, state: 'blocked', summary: 'Could not start' });
        return { ok: false, output: `The ${tier} worker could not start: ${error instanceof Error ? error.message : String(error)}` };
      }
      // Worker activity is summarized as subagent state; its own deltas would clutter the primary transcript.
      const result = await runTurn({
        provider,
        system: workerSystemPrompt(options.workspace),
        history: [],
        prompt,
        tools: options.workerTools,
        permissions: { fileWrite: 'ask', commands: 'ask' },
        sessionGrants: new Set(),
        signal: context.signal,
        maxSteps: options.maxWorkerSteps ?? 25,
        requestApproval: async () => 'reject',
        emit: body => {
          if (body.type === 'agent.state') {
            options.emit({ type: 'subagent.state', subagentId, state: body.state, ...(body.summary ? { summary: body.summary } : {}) });
          } else if (body.type === 'tool.started' || body.type === 'tool.completed') {
            options.emit(body, subagentId);
          }
        },
      });
      const last = [...result.history].reverse().find((message): message is Extract<ModelMessage, { role: 'assistant' }> => message.role === 'assistant' && Boolean(message.text));
      const answer = last?.text ?? '';
      if (result.outcome !== 'completed') {
        return { ok: false, output: `The worker stopped (${result.outcome}): ${result.error ?? 'no result'}${answer ? `\nPartial findings:\n${answer.slice(0, WORKER_RESULT_LIMIT)}` : ''}` };
      }
      return { ok: true, output: answer ? answer.slice(0, WORKER_RESULT_LIMIT) : 'The worker finished without findings.' };
    },
  };
}
