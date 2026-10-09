import type { WorkspacePermissions } from '@extalia/core';
import type { EventBody, RiskLevel, Usage } from '@extalia/protocol';
import { ProviderError, type ModelMessage, type ModelProvider, type ToolCall, type ToolResultEntry } from './model.js';
import { decide } from './policy.js';
import { validateArguments, type AnyTool, type ToolAccess } from './tools.js';

/**
 * One agent turn: send the conversation to the model, run the tools it asks
 * for (with the user's approval where the workspace requires it), feed the
 * results back, and repeat until the model answers without tools.
 *
 * Everything the user can see is reported as Extalia Protocol events through
 * `emit`; the returned history is what the next turn sends to the model.
 */
export interface ApprovalRequest {
  approvalId: string;
  access: ToolAccess;
  action: string;
  detail?: string;
  risk?: RiskLevel;
}

export type ApprovalOutcome = 'once' | 'session' | 'reject';

export interface TurnOptions {
  provider: ModelProvider;
  system: string;
  history: readonly ModelMessage[];
  prompt: string;
  tools: readonly AnyTool[];
  permissions: WorkspacePermissions;
  /** Access levels the user allowed for the rest of the session. Updated in place. */
  sessionGrants: Set<ToolAccess>;
  emit(body: EventBody, extra?: { parentId?: string }): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
  signal: AbortSignal;
  maxSteps?: number;
  newId?: () => string;
}

export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'refused' | 'step-limit';

export interface TurnResult {
  outcome: TurnOutcome;
  history: ModelMessage[];
  usage: Usage;
  error?: string;
}

const RESULT_LIMIT = 30_000;
const EVENT_OUTPUT_LIMIT = 4_000;

function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

function addUsage(total: Usage, usage: Usage | undefined): void {
  if (!usage) return;
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
    if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key]!;
  }
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError'));
}

let fallbackCounter = 0;
const defaultId = () => {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID?.() ?? `id-${Date.now().toString(36)}-${(fallbackCounter++).toString(36)}`;
};

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const { provider, emit, signal } = options;
  const newId = options.newId ?? defaultId;
  const history: ModelMessage[] = [...options.history, { role: 'user', text: options.prompt }];
  const usage: Usage = {};
  const maxSteps = options.maxSteps ?? 50;
  const specs = options.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));

  const finish = (outcome: TurnOutcome, error?: string): TurnResult => {
    if (outcome === 'completed') emit({ type: 'turn.completed', ...(Object.keys(usage).length ? { usage } : {}) });
    else emit({ type: 'turn.failed', error: error ?? outcome });
    emit({ type: 'agent.state', state: 'idle' });
    return { outcome, history, usage, ...(error ? { error } : {}) };
  };

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return finish('cancelled', 'Stopped by the user.');
    emit({ type: 'agent.state', state: 'thinking' });

    let result;
    try {
      result = await provider.complete({ system: options.system, messages: history, tools: specs, signal, onText: text => emit({ type: 'model.delta', text }) });
    } catch (error) {
      if (isAbort(error, signal)) return finish('cancelled', 'Stopped by the user.');
      const message = error instanceof ProviderError ? error.message : error instanceof Error ? `The model request failed: ${error.message}` : 'The model request failed.';
      return finish('failed', message);
    }
    addUsage(usage, result.usage);
    if (result.text) emit({ type: 'model.completed', text: result.text, ...(result.model ? { model: result.model } : {}), ...(result.usage ? { usage: result.usage } : {}) });

    const assistant: ModelMessage = { role: 'assistant', text: result.text, toolCalls: result.toolCalls, ...(result.native ? { native: result.native } : {}) };
    if (result.stop === 'refusal') {
      // A declined turn may end mid tool call; never run its tools.
      history.push({ ...assistant, toolCalls: [] });
      return finish('refused', result.refusal ?? 'The model declined this request.');
    }
    if (!result.toolCalls.length) {
      history.push(assistant);
      if (result.stop === 'max_tokens') return finish('failed', 'The answer was cut off because it reached the output limit.');
      return finish('completed');
    }
    if (result.stop === 'max_tokens') {
      // Tool input cut off at the output limit may parse as a valid but truncated object.
      history.push({ ...assistant, toolCalls: [] });
      return finish('failed', 'A tool call was cut off because the answer reached the output limit.');
    }
    history.push(assistant);

    const results: ToolResultEntry[] = [];
    const parallel = (call: ToolCall) => Boolean(options.tools.find(tool => tool.name === call.name)?.parallel);
    for (let index = 0; index < result.toolCalls.length && !signal.aborted;) {
      // Runs of parallel-safe calls (for example several delegations) execute together, in order of results.
      let end = index + 1;
      if (parallel(result.toolCalls[index]!)) while (end < result.toolCalls.length && parallel(result.toolCalls[end]!)) end++;
      results.push(...await Promise.all(result.toolCalls.slice(index, end).map(call => runTool(call, options, newId))));
      index = end;
    }
    // Every tool call needs a result, even when the turn was stopped part-way.
    for (const call of result.toolCalls.slice(results.length)) {
      results.push({ toolCallId: call.id, name: call.name, content: 'Not run: the user stopped the turn.', isError: true });
    }
    history.push({ role: 'tool', results });
    if (signal.aborted) return finish('cancelled', 'Stopped by the user.');
  }
  return finish('step-limit', `Stopped after ${maxSteps} steps without finishing. Send a follow-up to continue.`);
}

async function runTool(call: ToolCall, options: TurnOptions, newId: () => string): Promise<ToolResultEntry> {
  const { emit, signal } = options;
  const failure = (content: string): ToolResultEntry => ({ toolCallId: call.id, name: call.name, content, isError: true });
  const tool = options.tools.find(item => item.name === call.name);
  if (!tool) return failure(`Unknown tool "${call.name}". Available tools: ${options.tools.map(item => item.name).join(', ')}.`);
  if (call.inputError) return failure(call.inputError);
  const problems = validateArguments(tool.parameters, call.input);
  if (problems.length) return failure(`Invalid arguments: ${problems.join(' ')}`);

  let description;
  try { description = tool.describe(call.input); } catch { description = { label: tool.name }; }

  if (decide(tool.access, options.permissions, options.sessionGrants) === 'ask') {
    const approvalId = newId();
    emit({ type: 'agent.state', state: 'waiting', summary: description.label });
    emit({ type: 'approval.requested', approvalId, action: description.label, ...(description.detail ? { detail: description.detail } : {}), ...(description.risk ? { risk: description.risk } : {}) });
    let outcome: ApprovalOutcome;
    try {
      outcome = await options.requestApproval({ approvalId, access: tool.access, action: description.label, ...(description.detail ? { detail: description.detail } : {}), ...(description.risk ? { risk: description.risk } : {}) });
    } catch {
      outcome = 'reject';
    }
    emit({ type: 'approval.resolved', approvalId, decision: outcome === 'reject' ? 'rejected' : 'granted', by: 'user' });
    if (outcome === 'session') options.sessionGrants.add(tool.access);
    if (outcome === 'reject') return failure('The user declined this action. Do not retry it unchanged; continue without it or ask the user.');
  }

  emit({ type: 'agent.state', state: 'working', activity: tool.kind, summary: description.label, ...(description.target ? { target: description.target } : {}) });
  emit({ type: 'tool.started', toolCallId: call.id, tool: tool.name, kind: tool.kind, label: description.label, ...(description.target ? { target: description.target } : {}) });
  let outcome;
  try {
    outcome = await tool.run(call.input, { signal, toolCallId: call.id, emit: body => emit(body) });
  } catch (error) {
    outcome = { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
  for (const file of outcome.files ?? []) emit({ type: 'file.written', path: file.path, change: file.change });
  emit({
    type: 'tool.completed', toolCallId: call.id, tool: tool.name, kind: tool.kind, label: description.label, ok: outcome.ok,
    ...(description.target ? { target: description.target } : {}),
    ...(outcome.output ? { output: clipText(outcome.output, EVENT_OUTPUT_LIMIT) } : {}),
  });
  return { toolCallId: call.id, name: call.name, content: clipText(outcome.output || (outcome.ok ? 'Done.' : 'Failed.'), RESULT_LIMIT), isError: !outcome.ok };
}
