import type { SessionPermissionMode, WorkspacePermissions } from '@extalia/core';
import type { EventBody, RiskLevel, Usage } from '@extalia/protocol';
import { composeTurn, type TurnAttachment } from './attachments.js';
import { ProviderError, type ModelMessage, type ModelProvider, type ModelRequest, type ToolCall, type ToolResultEntry } from './model.js';
import { checkedVerdict, decide, offersAccess, POLICY_UNAVAILABLE, type PermissionRequest, type PermissionVerdict } from './policy.js';
import { validateArguments, type AnyTool, type ToolAccess } from './tools.js';
import type { LocalToolPipelines } from './localOperations.js';
import { RequestBudgetError, checkRequestBudget, type RequestPressure } from './requestBudget.js';
import { UsageAccumulator } from './usage.js';

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
  /** The session's permission mode (default `workspace`): plan mode offers no edit or command tools. */
  permissionMode?: SessionPermissionMode;
  /** Files attached to this prompt (v0.0.49), already checked by the host. */
  attachments?: readonly TurnAttachment[];
  emit(body: EventBody, extra?: { parentId?: string }): void;
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome>;
  /**
   * External policy decision point (ADR 0026), asked before every tool call instead of `decide()`.
   * A rejection or malformed verdict denies the call with `policy_unavailable`; there is no fallback.
   */
  checkPermission?(request: PermissionRequest): Promise<PermissionVerdict>;
  signal: AbortSignal;
  maxSteps?: number;
  /** Optional estimated input ceiling: a positive safe integer, never inferred from a model name. */
  maxInputTokens?: number;
  /** Host-owned context refresh after steering, before every budget check/provider request. */
  prepareRequest?(request: Readonly<Pick<ModelRequest, 'system' | 'messages' | 'tools'>> & { signal: AbortSignal; requestScope?: object }): Promise<string>;
  newId?: () => string;
  /** Internal native-mission lifecycle gate; tracks complete tool pipelines, including preflight waits. */
  localOperations?: LocalToolPipelines;
  /** Host-owned, durably admitted text for this invocation, consumed only at safe transcript boundaries. */
  takeSteering?(history: readonly ModelMessage[], boundary: 'step' | 'complete' | 'stop'): Promise<readonly string[]>;
  /** Host-owned successful-task finalization, awaited before terminal events. Never recursively attached to delegated work. */
  beforeComplete?(result: Readonly<TurnResult>): Promise<void>;
}

export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'refused' | 'step-limit';

/**
 * The conversation's context at the turn's last model request (v0.0.48): the prompt size in tokens.
 * `estimated` is set when the provider reported no usage and the size was counted from the text.
 */
export interface TurnContext {
  usedTokens: number;
  estimated: boolean;
  model?: string;
}

export interface TurnResult {
  outcome: TurnOutcome;
  history: ModelMessage[];
  usage: Usage;
  error?: string;
  context?: TurnContext;
  /** A rejected prospective request is separate from context/usage of requests actually sent. */
  requestPressure?: RequestPressure;
  reason?: 'context';
}

const RESULT_LIMIT = 30_000;
const EVENT_OUTPUT_LIMIT = 4_000;

function clipText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
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
  const requestScope = Object.freeze({});
  const { provider, emit, signal } = options;
  const newId = options.newId ?? defaultId;
  const mode = options.permissionMode ?? 'workspace';
  // Images are sent with this turn only; the stored history keeps the text (see `storedHistory`).
  const composed = composeTurn(options.prompt, options.attachments ?? [], { images: provider.images !== false });
  const history: ModelMessage[] = [...options.history, { role: 'user', text: composed.text, ...(composed.images.length ? { images: composed.images } : {}) }];
  const accumulated = new UsageAccumulator(), usage = accumulated.total;
  let context: TurnContext | undefined;
  let requestPressure: RequestPressure | undefined;
  const maxSteps = options.maxSteps ?? 50;
  // Read per step: a tool may join the list during the turn (delegate_task once manage_team creates the first member).
  const offeredTools = () => options.tools.filter(tool => offersAccess(tool.access, mode));
  const specsNow = () => offeredTools().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  const storedHistory = (): ModelMessage[] => history.map(message => (message.role === 'user' && message.images ? { role: 'user', text: message.text } : message));

  const takeSteering = async (boundary: 'step' | 'complete' | 'stop') => {
    const pending = await options.takeSteering?.(storedHistory(), boundary) ?? [];
    history.push(...pending.map(text => ({ role: 'user' as const, text })));
    return pending.length;
  };
  const finish = async (outcome: TurnOutcome, error?: string, reason?: 'context'): Promise<TurnResult> => {
    await takeSteering('stop');
    const result: TurnResult = { outcome, history: storedHistory(), usage, ...(error ? { error } : {}), ...(context ? { context } : {}), ...(requestPressure ? { requestPressure } : {}), ...(reason ? { reason } : {}) };
    if (outcome === 'completed') await options.beforeComplete?.(result);
    if (outcome === 'completed') emit({ type: 'turn.completed', ...(Object.keys(usage).length ? { usage } : {}) });
    else emit({ type: 'turn.failed', error: error ?? outcome, ...(reason ? { reason } : {}) });
    emit({ type: 'agent.state', state: 'idle' });
    return result;
  };

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return finish('cancelled', 'Stopped by the user.');
    await takeSteering('step');
    if (signal.aborted) return finish('cancelled', 'Stopped by the user.');
    const specs = specsNow();
    let system = options.system;
    try {
      if (options.prepareRequest) system = await options.prepareRequest({ system, messages: history, tools: specs, signal, requestScope });
    } catch (error) {
      if (isAbort(error, signal)) return finish('cancelled', 'Stopped by the user.');
      if (error instanceof RequestBudgetError) {
        requestPressure = error.pressure;
        return finish('failed', error.code, 'context');
      }
      return finish('failed', 'The Native request context could not be prepared.');
    }
    const budget = checkRequestBudget({ system, messages: history, tools: specs }, options.maxInputTokens);
    if (signal.aborted) return finish('cancelled', 'Stopped by the user.');
    requestPressure = budget.pressure;
    if (budget.reason || !budget.pressure) return finish('failed', 'native_context_limit', 'context');
    emit({ type: 'agent.state', state: 'thinking' });
    if (signal.aborted) return finish('cancelled', 'Stopped by the user.');

    let result;
    try {
      result = await provider.complete({ system, messages: history, tools: specs, signal, onText: text => { if (!signal.aborted) emit({ type: 'model.delta', text }); } });
    } catch (error) {
      if (isAbort(error, signal)) return finish('cancelled', 'Stopped by the user.');
      if (error instanceof RequestBudgetError) {
        requestPressure = error.pressure;
        return finish('failed', error.code, 'context');
      }
      const message = error instanceof ProviderError ? error.message : error instanceof Error ? `The model request failed: ${error.message}` : 'The model request failed.';
      return finish('failed', message);
    }
    // An abort-ignoring provider may settle after the host has already shut down.
    if (signal.aborted) return finish('cancelled', 'Stopped by the user.');
    accumulated.add(result.usage);
    // The prompt of this request is the context in use; a provider that reports none is estimated from the text sent.
    if (result.promptTokens !== undefined) context = { usedTokens: result.promptTokens, estimated: false, ...(result.model ? { model: result.model } : {}) };
    else {
      const model = result.model ?? context?.model;
      context = { usedTokens: budget.pressure.estimatedTokens, estimated: true, ...(model ? { model } : {}) };
    }
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
      if (await takeSteering('complete')) continue;
      return finish('completed');
    }
    if (result.stop === 'max_tokens') {
      // Tool input cut off at the output limit may parse as a valid but truncated object.
      history.push({ ...assistant, toolCalls: [] });
      return finish('failed', 'A tool call was cut off because the answer reached the output limit.');
    }
    history.push(assistant);

    const results: ToolResultEntry[] = [];
    const parallel = (call: ToolCall) => Boolean(offeredTools().find(tool => tool.name === call.name)?.parallel);
    for (let index = 0; index < result.toolCalls.length && !signal.aborted;) {
      // Runs of parallel-safe calls (for example several delegations) execute together, in order of results.
      let end = index + 1;
      if (parallel(result.toolCalls[index]!)) while (end < result.toolCalls.length && parallel(result.toolCalls[end]!)) end++;
      const calls = result.toolCalls.slice(index, end);
      // Reserve every branch before any starts: an early failure must not hide an unstarted sibling.
      const pipelines = calls.map(() => options.localOperations?.reserveToolPipeline());
      results.push(...await Promise.all(calls.map((call, branch) => pipelines[branch]
        ? pipelines[branch]!.run(() => runTool(call, options, newId, requestScope))
        : runTool(call, options, newId, requestScope))));
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

async function runTool(call: ToolCall, options: TurnOptions, newId: () => string, requestScope: object): Promise<ToolResultEntry> {
  const { emit, signal } = options;
  options.localOperations?.assertOpen();
  const failure = (content: string): ToolResultEntry => ({ toolCallId: call.id, name: call.name, content, isError: true });
  const tool = options.tools.find(item => item.name === call.name);
  if (!tool) return failure(`Unknown tool "${call.name}". Available tools: ${options.tools.filter(item => offersAccess(item.access, options.permissionMode)).map(item => item.name).join(', ')}.`);
  if (call.inputError) return failure(call.inputError);
  const problems = validateArguments(tool.parameters, call.input);
  if (problems.length) return failure(`Invalid arguments: ${problems.join(' ')}`);

  let refusal: string | undefined;
  try { refusal = tool.precheck?.(call.input); } catch (error) { refusal = error instanceof Error ? error.message : 'The tool refused this input.'; }
  if (refusal) {
    // Shown like any failed tool call, without asking the user first.
    let label = tool.name;
    try { label = tool.describe(call.input).label; } catch { /* keep the name */ }
    emit({ type: 'tool.started', toolCallId: call.id, tool: tool.name, kind: tool.kind, label });
    emit({ type: 'tool.completed', toolCallId: call.id, tool: tool.name, kind: tool.kind, label, ok: false, output: clipText(refusal, EVENT_OUTPUT_LIMIT) });
    return failure(refusal);
  }

  let description;
  try { description = tool.describe(call.input); } catch { description = { label: tool.name }; }

  const mode = options.permissionMode ?? 'workspace';
  let verdict: PermissionVerdict;
  if (options.checkPermission) {
    const request: PermissionRequest = { access: tool.access, mode, permissions: { ...options.permissions }, sessionGrants: [...options.sessionGrants] };
    try { verdict = checkedVerdict(await options.checkPermission(request)); } catch { verdict = POLICY_UNAVAILABLE; }
  } else verdict = { decision: decide(tool.access, options.permissions, options.sessionGrants, mode) };
  options.localOperations?.assertOpen();
  const decision = verdict.decision;
  if (decision === 'deny') {
    // Plan mode (or an unavailable decision point): refused without asking, shown like any failed tool call.
    const message = verdict.reason === 'policy_unavailable'
      ? 'The permission service is unavailable, so this tool call was denied.'
      : 'Plan mode is on: this session cannot edit files or run commands. Describe the change in your answer instead.';
    emit({ type: 'tool.started', toolCallId: call.id, tool: tool.name, kind: tool.kind, label: description.label });
    emit({ type: 'tool.completed', toolCallId: call.id, tool: tool.name, kind: tool.kind, label: description.label, ok: false, output: message });
    return failure(message);
  }

  if (decision === 'ask') {
    const approvalId = newId();
    emit({ type: 'agent.state', state: 'waiting', summary: description.label });
    emit({ type: 'approval.requested', approvalId, action: description.label, ...(description.detail ? { detail: description.detail } : {}), ...(description.risk ? { risk: description.risk } : {}) });
    let outcome: ApprovalOutcome;
    let answered = false;
    try {
      outcome = await options.requestApproval({ approvalId, access: tool.access, action: description.label, ...(description.detail ? { detail: description.detail } : {}), ...(description.risk ? { risk: description.risk } : {}) });
      answered = !options.signal.aborted;
    } catch {
      outcome = 'reject';
    }
    options.localOperations?.assertOpen();
    emit({ type: 'approval.resolved', approvalId, decision: outcome === 'reject' ? 'rejected' : 'granted', by: 'user', ...(answered ? { choice: outcome } : {}) });
    if (outcome === 'session') options.sessionGrants.add(tool.access);
    if (outcome === 'reject') return failure('The user declined this action. Do not retry it unchanged; continue without it or ask the user.');
  }

  options.localOperations?.assertOpen();
  emit({ type: 'agent.state', state: 'working', activity: tool.kind, summary: description.label, ...(description.target ? { target: description.target } : {}) });
  emit({ type: 'tool.started', toolCallId: call.id, tool: tool.name, kind: tool.kind, label: description.label, ...(description.target ? { target: description.target } : {}) });
  let outcome;
  try {
    options.localOperations?.assertOpen();
    outcome = await tool.run(call.input, { signal, requestScope, toolCallId: call.id, emit: body => emit(body) });
  } catch (error) {
    outcome = { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
  for (const file of outcome.files ?? []) emit({ type: 'file.written', path: file.path, change: file.change, toolCallId: call.id });
  emit({
    type: 'tool.completed', toolCallId: call.id, tool: tool.name, kind: tool.kind, label: description.label, ok: outcome.ok,
    ...(description.target ? { target: description.target } : {}),
    ...(outcome.output ? { output: clipText(outcome.output, EVENT_OUTPUT_LIMIT) } : {}),
  });
  return { toolCallId: call.id, name: call.name, content: clipText(outcome.output || (outcome.ok ? 'Done.' : 'Failed.'), RESULT_LIMIT), isError: !outcome.ok };
}
