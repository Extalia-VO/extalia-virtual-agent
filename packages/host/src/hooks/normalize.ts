import { safeLabel, safeText, stopReasonOf, type StopReason } from '@extalia/core';
import { commandHead, fileTarget, outputText, statedSuccess, stepOutput, toolHints } from '@extalia/importers';
import { AGENT_APP_IDS, type AgentAppId } from '@extalia/platform';
import { createEvent, type AgentPhase, type EventBody, type EventSource, type ExtaliaEvent, type FileChangeKind } from '@extalia/protocol';
import { describeToolCall, toolStateBody } from '../transcriptEvents.js';
import { normalizeMcpReport } from './mcp.js';

/**
 * Pure normalizers from the hook payloads of agent apps (Codex, Claude Code,
 * Gemini CLI, Hermes outbound webhooks) to Extalia Protocol event bodies.
 *
 * Codex and Claude Code send Claude-style command/HTTP hook payloads
 * (`session_id`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`,
 * `prompt`, `last_assistant_message`, …); Gemini CLI uses the same field names
 * with its own event names (BeforeAgent, BeforeTool, …). Hermes webhooks carry
 * `hook_event_name`, `session_id`, `cwd`, `profile`, `tool_name`, `tool_input`
 * and an open `extra` object. Unknown events and fields are ignored, nothing
 * the payload does not state is invented, and every text is redacted and clipped.
 * Raw payloads are never kept.
 */

export type HookApp = AgentAppId;
export const HOOK_APPS: readonly HookApp[] = AGENT_APP_IDS;
export const isHookApp = (value: unknown): value is HookApp => typeof value === 'string' && (HOOK_APPS as readonly string[]).includes(value);

/** Transcript source id of each app (see NativeImportService locations). */
export const HOOK_SOURCE_IDS: Readonly<Record<HookApp, string>> = { codex: 'codex', claude: 'claude-code', gemini: 'gemini-cli', antigravity: 'antigravity', hermes: 'hermes' };
export const HOOK_APP_LABELS: Readonly<Record<HookApp, string>> = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', antigravity: 'Antigravity', hermes: 'Hermes Agent' };

export const hookSource = (app: HookApp): EventSource => ({ runtime: app, channel: 'hook', adapter: `${app}-hooks` });

export interface HookStep { body: EventBody; agentId: string }

export interface NormalizeHookOptions {
  /** When true, drop prompt text, assistant reply text and tool output, keeping only activity labels. */
  labelsOnly?: boolean;
}

export interface NormalizedHook {
  app: HookApp;
  /** Native session id (single line, at most 200 characters). */
  sessionId: string;
  /** Native hook event name as reported (bounded label). */
  event: string;
  /** The app reports a new or resumed session. */
  starts: boolean;
  /** The app reports the end of the session. */
  ends: boolean;
  cwd?: string;
  transcriptPath?: string;
  model?: string;
  /** Hermes profile name. */
  profile?: string;
  /** v0.0.38: Claude Code `agent_type` of the sub-agent a hook fired in, for announcing it when its start was missed. */
  agentType?: string;
  /** First line of the prompt, redacted, for the title of a new session. */
  titleHint?: string;
  steps: HookStep[];
}

const PROMPT_LIMIT = 20_000;
const REPLY_LIMIT = 20_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type Row = Record<string, unknown>;
const obj = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const first = (...values: unknown[]): string => { for (const value of values) if (typeof value === 'string' && value.trim()) return value; return ''; };

/** An absolute, single-line path of bounded length; anything else is dropped. */
function pathField(value: unknown): string | undefined {
  const text = str(value).trim();
  if (!text || text.length > 2000 || /[\0\r\n]/.test(text)) return undefined;
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(text) ? text : undefined;
}

const id = (value: unknown, pattern: RegExp): string | undefined => {
  const text = str(value).trim();
  return pattern.test(text) ? text : undefined;
};

/** Extract MCP reporting tool name (`report_intent` or `report_handoff`), including prefixed MCP names. */
function mcpReportToolName(rawName: unknown): 'report_intent' | 'report_handoff' | undefined {
  const name = str(rawName).trim();
  if (!name) return undefined;
  if (name === 'report_intent' || /(?:^|__|\/|:)report_intent$/.test(name)) return 'report_intent';
  if (name === 'report_handoff' || /(?:^|__|\/|:)report_handoff$/.test(name)) return 'report_handoff';
  return undefined;
}

/** Visible output of a tool response: stdout/stderr, `output`/`content`/`llmContent`, or the clipped JSON. */
export function hookOutput(response: unknown): string | undefined {
  if (response === undefined || response === null) return undefined;
  const record = obj(response);
  if (typeof response === 'object' && !Array.isArray(response)) {
    const streams = [str(record.stdout), str(record.stderr)].filter(text => text.trim());
    if (streams.length) return stepOutput(streams.join('\n'));
    const text = first(record.output, record.content, record.llmContent, record.returnDisplay, record.result, record.error);
    if (text) return stepOutput(text);
  }
  return stepOutput(outputText(response));
}

/** Path shown for a written file: relative to the session folder when inside it, else the base name. */
function displayPath(file: string, cwd: string | undefined): string {
  const normalized = file.replace(/\\/g, '/');
  const root = cwd?.replace(/\\/g, '/').replace(/\/+$/, '');
  if (root && normalized.startsWith(`${root}/`)) return safeLabel(normalized.slice(root.length + 1), 300);
  return fileTarget(file);
}

/** Files a successful edit tool call wrote, from well-known argument names and `apply_patch` envelopes. */
function writtenFiles(input: unknown, response: unknown, cwd: string | undefined, toolName?: unknown): { path: string; change: FileChangeKind }[] {
  let args: unknown = input;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* patch text */ } }
  const record = obj(args);
  const patch = typeof args === 'string' ? args : str(record.input) || str(record.patch);
  if (patch) {
    const found: { path: string; change: FileChangeKind }[] = [];
    for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
      found.push({ path: displayPath(match[2]!.trim(), cwd), change: match[1] === 'Add' ? 'Add'.toLowerCase() as FileChangeKind : match[1] === 'Delete' ? 'delete' : 'update' });
      if (found.length >= 20) break;
    }
    if (found.length) return found;
  }
  const rawFile = first(record.file_path, record.filePath, record.absolute_path, record.AbsolutePath, record.TargetFile, record.notebook_path, record.path);
  const file = rawFile.replace(/^"(.*)"$/, '$1').trim();
  if (!file) return [];
  const isWriteToFile = /(?:^|:)write_to_file$/i.test(str(toolName)) && record.Overwrite !== true && record.Overwrite !== 'true';
  const created = str(obj(response).type) === 'create' || isWriteToFile;
  return [{ path: displayPath(file, cwd), change: created ? 'add' : 'update' }];
}

type Tool = ReturnType<typeof describeToolCall> & { toolCallId?: string };

function toolOf(name: unknown, input: unknown, callId: unknown): Tool {
  const tool = safeLabel(name, 120) || 'tool';
  const hints = toolHints(tool, input);
  const described = describeToolCall({ tool, ...(hints.target ? { target: hints.target } : {}), ...(hints.command ? { command: hints.command } : {}) });
  const toolCallId = id(callId, AGENT_ID);
  return { ...described, ...(toolCallId ? { toolCallId } : {}) };
}

const started = (tool: Tool): EventBody => ({
  type: 'tool.started', ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}), tool: tool.tool, kind: tool.kind, label: tool.label, ...(tool.target ? { target: tool.target } : {}),
});
/** The agent works on a tool call: waiting for an answer, planning, delegating or working (v0.0.38). */
const working = (tool: Tool): EventBody => toolStateBody(tool);
const completed = (tool: Tool, ok: boolean, output: string | undefined): EventBody => ({
  type: 'tool.completed', ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}), tool: tool.tool, kind: tool.kind, label: tool.label, ok,
  ...(tool.target ? { target: tool.target } : {}), ...(output ? { output } : {}),
});
const waiting = (summary: string, phase: 'approval' | 'input', tool?: Tool): EventBody => ({
  type: 'agent.state', state: 'waiting', phase, summary: safeLabel(summary, 200) || (phase === 'approval' ? 'Waiting for approval' : 'Waiting for the user'),
  ...(tool ? { activity: tool.kind } : {}), ...(tool?.target ? { target: tool.target } : {}),
});
/** The turn ended without a result: the user interrupted it, or it failed (v0.0.38). */
const stopped = (phase: Extract<AgentPhase, 'interrupted' | 'error'>, summary?: string, reason?: StopReason): EventBody => ({
  type: 'agent.state', state: 'idle', phase, ...(summary ? { summary } : {}), ...(reason ? { reason } : {}),
});
/** v0.0.43: a failed turn and why it stopped (out of quota, rate limited, signed out, …) when the text or code says so. */
const failedTurn = (error: string, reason: StopReason | undefined): EventBody[] => [
  { type: 'turn.failed', error, ...(reason ? { reason } : {}) },
  stopped(reason === 'interrupted' ? 'interrupted' : 'error', error, reason),
];
/** An error code such as `rate_limit` or `billing_error` (Claude Code StopFailure), never free text. */
const errorCode = (value: unknown): string | undefined => typeof value === 'string' && /^[a-z][a-z0-9_]{1,60}$/.test(value.trim()) ? value.trim() : undefined;
const compacting: EventBody = { type: 'agent.state', state: 'thinking', phase: 'compacting', summary: 'Compacting context' };

/** Claude Code / Gemini CLI notification kinds: a permission prompt, the idle prompt, a question, or something else. */
function notificationKind(type: string, message: string): 'approval' | 'idle' | 'input' | 'none' {
  if (type === 'permission_prompt' || type === 'toolpermission' || (!type && /permission|approv/i.test(message))) return 'approval';
  if (type === 'idle_prompt' || (!type && /waiting for your (?:input|prompt)/i.test(message))) return 'idle';
  if (type === 'auth_success') return 'none';
  return 'input';
}

/** The first line of a prompt, for titles. */
const titleOf = (prompt: string) => safeLabel(prompt.trim().split(/\r?\n/)[0] ?? '', 60) || undefined;

/** Event-name families shared by Claude Code, Codex and Gemini CLI. */
const START = new Set(['SessionStart']);
const PROMPT = new Set(['UserPromptSubmit', 'BeforeAgent']);
/** Gemini CLI asks the model again (also after each tool result). */
const MODEL = new Set(['BeforeModel']);
/** Claude Code / Codex `PreCompact`, Gemini CLI `PreCompress`. */
const COMPACT = new Set(['PreCompact', 'PreCompress']);
const PRE_TOOL = new Set(['PreToolUse', 'BeforeTool']);
const POST_TOOL = new Set(['PostToolUse', 'PostToolUseFailure', 'AfterTool']);
const STOP = new Set(['Stop', 'AfterAgent']);
const END = new Set(['SessionEnd']);

/** Shared normalizer for Claude-style payloads (Claude Code, Codex, Gemini CLI). */
function claudeStyle(app: HookApp, raw: unknown, options: NormalizeHookOptions = {}): NormalizedHook | undefined {
  const payload = obj(raw);
  const sessionId = id(payload.session_id ?? payload.sessionId, SESSION_ID);
  if (!sessionId) return undefined;
  const event = safeLabel(payload.hook_event_name ?? payload.hookEventName, 80);
  const cwd = pathField(payload.cwd);
  const transcriptPath = pathField(payload.transcript_path ?? payload.transcriptPath);
  const model = safeLabel(typeof payload.model === 'string' ? payload.model : str(obj(payload.model).id) || str(obj(payload.model).display_name), 120) || undefined;
  // Claude Code marks hooks fired inside a sub-agent with its `agent_id`.
  const inner = id(payload.agent_id, AGENT_ID);
  const agentId = inner ?? 'primary';
  const steps: HookStep[] = [];
  const add = (body: EventBody, agent = agentId) => steps.push({ body, agentId: agent });
  let titleHint: string | undefined;

  const mcpEventTool = mcpReportToolName(event);
  if (mcpEventTool) {
    const report = normalizeMcpReport(mcpEventTool, payload.tool_input ?? payload);
    if (report) steps.push(...report.steps);
  } else if (START.has(event)) {
    add({ type: 'session.started', control: 'observed', ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) }, 'primary');
    // After an automatic compaction the turn goes on; startup, resume and clear wait for a prompt.
    add(str(payload.source) === 'compact' ? { type: 'agent.state', state: 'thinking', summary: 'Context compacted' } : { type: 'agent.state', state: 'idle' }, 'primary');
  } else if (MODEL.has(event)) {
    add({ type: 'agent.state', state: 'thinking' });
  } else if (COMPACT.has(event)) {
    add(compacting);
  } else if (PROMPT.has(event)) {
    const prompt = str(payload.prompt);
    if (!options.labelsOnly && prompt.trim()) {
      add({ type: 'prompt.submitted', text: safeText(prompt, PROMPT_LIMIT), via: 'native' });
      titleHint = titleOf(prompt);
    }
    add({ type: 'agent.state', state: 'thinking' });
  } else if (PRE_TOOL.has(event)) {
    const mcpTool = mcpReportToolName(payload.tool_name);
    if (mcpTool) {
      const report = normalizeMcpReport(mcpTool, payload.tool_input);
      if (report) steps.push(...report.steps);
    } else {
      const tool = toolOf(payload.tool_name, payload.tool_input, payload.tool_use_id ?? payload.tool_call_id);
      add(working(tool));
      add(started(tool));
    }
  } else if (POST_TOOL.has(event)) {
    const mcpTool = mcpReportToolName(payload.tool_name);
    if (!mcpTool) {
      const tool = toolOf(payload.tool_name, payload.tool_input, payload.tool_use_id ?? payload.tool_call_id);
      const response = payload.tool_response ?? payload.tool_output;
      const failed = event === 'PostToolUseFailure' || Boolean(obj(response).error) || obj(response).interrupted === true;
      const ok = failed ? false : statedSuccess(response) ?? true;
      const out = options.labelsOnly ? undefined : hookOutput(event === 'PostToolUseFailure' ? first(payload.error, response) || response : response);
      add(completed(tool, ok, out));
      if (ok && tool.kind === 'edit') for (const file of writtenFiles(payload.tool_input, response, cwd, payload.tool_name)) add({ type: 'file.written', path: file.path, change: file.change });
      // Claude Code: the user pressed Esc while the tool ran.
      if (event === 'PostToolUseFailure' && payload.is_interrupt === true) add(stopped('interrupted', undefined, 'interrupted'));
    }
  } else if (event === 'PermissionRequest') {
    const tool = payload.tool_name !== undefined ? toolOf(payload.tool_name, payload.tool_input, payload.tool_use_id) : undefined;
    add(waiting(tool ? `Waiting for approval: ${tool.label}` : 'Waiting for approval', 'approval', tool));
  } else if (event === 'Notification') {
    const type = str(payload.notification_type).toLowerCase(), message = str(payload.message);
    const kind = notificationKind(type, message);
    // "Waiting for your input" after a finished turn is not a request: the agent is ready and waits for the next prompt.
    if (kind === 'idle') add({ type: 'agent.state', state: 'idle', phase: 'input', summary: 'Waiting for the user' });
    else if (kind !== 'none') add(waiting(message || (kind === 'approval' ? 'Waiting for approval' : 'Waiting for the user'), kind));
  } else if (event === 'StopFailure') {
    // Claude Code: the turn ended on an API error. `error` is its type (rate_limit, billing_error, authentication_failed, …);
    // the details or the last assistant message say more (a used-up session limit is reported as a rate limit).
    const code = errorCode(payload.error) ?? errorCode(obj(payload.error).type);
    const detail = first(payload.error_message, payload.error_details, obj(payload.error).message, payload.last_assistant_message);
    const error = safeLabel(first(detail, payload.error, payload.reason), 300) || 'The turn failed.';
    for (const body of failedTurn(error, stopReasonOf(detail || (code ? '' : error), code))) add(body);
  } else if (event === 'SubagentStart') {
    const subagentId = inner ?? id(payload.subagent_id, AGENT_ID);
    const role = safeLabel(first(payload.agent_type, payload.subagent_type), 80);
    if (subagentId) add({ type: 'subagent.spawned', subagentId, ...(role ? { role, label: role } : {}) }, 'primary');
  } else if (event === 'SubagentStop') {
    const subagentId = inner ?? id(payload.subagent_id, AGENT_ID);
    if (subagentId) add({ type: 'subagent.state', subagentId, state: 'offline' }, 'primary');
  } else if (STOP.has(event)) {
    const reply = first(payload.last_assistant_message, payload.prompt_response);
    if (!options.labelsOnly && reply) add({ type: 'model.completed', text: safeText(reply, REPLY_LIMIT), ...(model ? { model } : {}) });
    add({ type: 'turn.completed', ...(model ? { model } : {}) });
    add({ type: 'agent.state', state: 'idle' });
  } else if (END.has(event)) {
    const reason = safeLabel(payload.reason, 120);
    add({ type: 'session.ended', ...(reason ? { reason } : {}) }, 'primary');
    add({ type: 'agent.state', state: 'offline' }, 'primary');
  }
  const agentType = inner ? safeLabel(first(payload.agent_type, payload.subagent_type), 80) : '';
  return {
    app, sessionId, event: event || 'unknown', starts: START.has(event), ends: END.has(event), steps, ...(agentType ? { agentType } : {}),
    ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...(model ? { model } : {}), ...(titleHint ? { titleHint } : {}),
  };
}

export const normalizeClaudeHook = (payload: unknown, options?: NormalizeHookOptions) => claudeStyle('claude', payload, options);
/** Codex 0.16x command hooks use Claude Code's payload fields (`apply_patch`, `Bash`, … as tool names). */
export const normalizeCodexHook = (payload: unknown, options?: NormalizeHookOptions) => claudeStyle('codex', payload, options);
/** Gemini CLI: SessionStart/End, BeforeAgent/AfterAgent, BeforeTool/AfterTool, Notification. */
export const normalizeGeminiHook = (payload: unknown, options?: NormalizeHookOptions) => claudeStyle('gemini', payload, options);

const antigravityPendingTools = new Map<string, { name: string; input: unknown }>();

/**
 * Antigravity command hooks (`~/.gemini/config/hooks.json`):
 * - `conversationId` identifies the session; `workspacePaths` (string[]) gives the project folder.
 * - `PreInvocation` / `PostInvocation`: before/after each LLM call.
 * - `PreToolUse`: `toolCall: { name, args }`, `stepIdx: number`.
 * - `PostToolUse`: `stepIdx: number`, `error: string` (tool name and args are recalled from `PreToolUse` by `stepIdx`).
 * - `Stop`: `terminationReason` (`"completed"` | `"error"`), `error: string`.
 */
export function normalizeAntigravityHook(raw: unknown, options: NormalizeHookOptions = {}): NormalizedHook | undefined {
  const payload = obj(raw);
  const sessionId = id(payload.session_id ?? payload.sessionId ?? payload.conversationId, SESSION_ID);
  if (!sessionId) return undefined;
  const event = safeLabel(payload.hook_event_name ?? payload.hookEventName, 80);
  const workspaces = Array.isArray(payload.workspacePaths) ? payload.workspacePaths : [];
  const cwd = pathField(payload.cwd ?? workspaces[0]);
  // Hooks name `transcript_full.jsonl`; the compact `transcript.jsonl` next to it is the transcript Extalia observes and discovers.
  const transcriptPath = pathField(payload.transcript_path ?? payload.transcriptPath)?.replace(/([\\/])transcript_full\.jsonl$/, '$1transcript.jsonl');
  const rawModel = first(typeof payload.model === 'string' ? payload.model : '', payload.modelName);
  const model = rawModel && rawModel.toLowerCase() !== 'none' && rawModel.toLowerCase() !== 'auto'
    ? safeLabel(rawModel, 120) || undefined
    : undefined;
  const steps: HookStep[] = [];
  const add = (body: EventBody) => steps.push({ body, agentId: 'primary' });
  const stepIdx = typeof payload.stepIdx === 'number' && Number.isInteger(payload.stepIdx) && payload.stepIdx >= 0 ? payload.stepIdx : undefined;
  const callId = stepIdx !== undefined ? `step-${stepIdx}` : id(payload.tool_use_id ?? payload.tool_call_id, AGENT_ID);

  const mcpEventTool = mcpReportToolName(event);
  if (mcpEventTool) {
    const report = normalizeMcpReport(mcpEventTool, payload.tool_input ?? obj(payload.toolCall).args ?? payload);
    if (report) steps.push(...report.steps);
    return {
      app: 'antigravity', sessionId, event: event || 'unknown', starts: false, ends: false, steps,
      ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...(model ? { model } : {}),
    };
  }

  switch (event) {
    case 'PreInvocation':
    case 'PostInvocation':
      add({ type: 'agent.state', state: 'thinking' });
      break;
    case 'PreToolUse': {
      const toolCall = obj(payload.toolCall);
      const rawName = (first(toolCall.name, payload.tool_name) || 'tool').replace(/^default_api:/, '');
      const rawInput = toolCall.args ?? payload.tool_input;
      const mcpTool = mcpReportToolName(rawName);
      if (mcpTool) {
        const report = normalizeMcpReport(mcpTool, rawInput);
        if (report) steps.push(...report.steps);
      } else {
        if (callId) {
          antigravityPendingTools.set(`${sessionId}:${callId}`, { name: rawName, input: rawInput });
          while (antigravityPendingTools.size > 400) {
            const oldest = antigravityPendingTools.keys().next().value;
            if (oldest !== undefined) antigravityPendingTools.delete(oldest); else break;
          }
        }
        const tool = toolOf(rawName, rawInput, callId);
        add(working(tool));
        add(started(tool));
      }
      break;
    }
    case 'PostToolUse': {
      const cached = callId ? antigravityPendingTools.get(`${sessionId}:${callId}`) : undefined;
      if (callId) antigravityPendingTools.delete(`${sessionId}:${callId}`);
      const toolCall = obj(payload.toolCall);
      const rawName = (first(toolCall.name, payload.tool_name, cached?.name) || 'tool').replace(/^default_api:/, '');
      const rawInput = toolCall.args ?? payload.tool_input ?? cached?.input;
      if (!mcpReportToolName(rawName)) {
        const tool = toolOf(rawName, rawInput, callId);
        const errText = str(payload.error).trim();
        const response = payload.tool_response ?? payload.tool_output ?? payload.toolOutput;
        const ok = errText ? false : statedSuccess(response) ?? true;
        const out = options.labelsOnly ? undefined : hookOutput(errText || response);
        add(completed(tool, ok, out));
        if (ok && tool.kind === 'edit') {
          for (const file of writtenFiles(rawInput, response, cwd, rawName)) {
            add({ type: 'file.written', path: file.path, change: file.change });
          }
        }
      }
      break;
    }
    case 'Stop': {
      const errText = str(payload.error).trim();
      const reasonText = str(payload.terminationReason).trim().toLowerCase();
      if (errText || reasonText === 'error') {
        const error = safeLabel(errText || 'The turn failed.', 300) || 'The turn failed.';
        for (const body of failedTurn(error, stopReasonOf(errText || error))) add(body);
      } else {
        add({ type: 'turn.completed', ...(model ? { model } : {}) });
        add({ type: 'agent.state', state: 'idle' });
      }
      break;
    }
    default:
      return claudeStyle('antigravity', payload, options);
  }

  return {
    app: 'antigravity', sessionId, event: event || 'unknown', starts: event === 'PreInvocation', ends: false, steps,
    ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...(model ? { model } : {}),
  };
}

/**
 * Hermes outbound webhooks (`hooks.outbound`): `hook_event_name` is a plugin hook
 * name (`pre_tool_call`, `post_tool_call`, `on_session_start`, `on_session_end`,
 * `subagent_start`, `subagent_stop`, `pre_approval_request`, `pre_llm_call`, …).
 * The contents of `extra` are not documented per event, so only well-known keys
 * are read and everything else is ignored. `on_session_end` ends one Hermes run
 * (a turn); it carries `completed`/`interrupted` flags.
 */
export function normalizeHermesHook(raw: unknown, options: NormalizeHookOptions = {}): NormalizedHook | undefined {
  const payload = obj(raw);
  const sessionId = id(payload.session_id, SESSION_ID);
  if (!sessionId) return undefined;
  const event = safeLabel(payload.hook_event_name ?? payload.event, 80);
  const extra = obj(payload.extra);
  const cwd = pathField(payload.cwd);
  const model = safeLabel(extra.model, 120) || undefined;
  const profile = safeLabel(payload.profile, 80) || undefined;
  const titleHint = titleOf(first(extra.user_message, payload.user_message));
  const steps: HookStep[] = [];
  const add = (body: EventBody) => steps.push({ body, agentId: 'primary' });
  const tool = () => toolOf(payload.tool_name, payload.tool_input, extra.tool_call_id ?? extra.call_id);
  const mcpEventTool = mcpReportToolName(event);
  if (mcpEventTool) {
    const report = normalizeMcpReport(mcpEventTool, payload.tool_input ?? extra);
    if (report) steps.push(...report.steps);
    return { app: 'hermes', sessionId, event: event || 'unknown', starts: false, ends: false, steps, ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(profile ? { profile } : {}) };
  }
  switch (event) {
    case 'on_session_start':
      add({ type: 'session.started', control: 'observed', ...(model ? { model } : {}), ...(cwd ? { cwd } : {}) });
      add({ type: 'agent.state', state: 'idle' });
      break;
    case 'pre_llm_call': add({ type: 'agent.state', state: 'thinking' }); break;
    case 'post_llm_call': {
      const reply = first(extra.assistant_response, payload.assistant_response);
      if (!options.labelsOnly && reply) add({ type: 'model.completed', text: safeText(reply, REPLY_LIMIT), ...(model ? { model } : {}) });
      add({ type: 'turn.completed', ...(model ? { model } : {}) });
      add({ type: 'agent.state', state: 'idle' });
      break;
    }
    case 'pre_tool_call': {
      const mcpTool = mcpReportToolName(payload.tool_name);
      if (mcpTool) {
        const report = normalizeMcpReport(mcpTool, payload.tool_input);
        if (report) steps.push(...report.steps);
      } else {
        const call = tool();
        add(working(call));
        add(started(call));
      }
      break;
    }
    case 'post_tool_call': {
      if (!mcpReportToolName(payload.tool_name)) {
        const call = tool();
        const result = extra.result ?? extra.output ?? extra.tool_response;
        const ok = extra.error ? false : statedSuccess(result) ?? true;
        const out = options.labelsOnly ? undefined : hookOutput(extra.error ? first(extra.error) || result : result);
        add(completed(call, ok, out));
      }
      break;
    }
    case 'pre_approval_request': {
      const call = payload.tool_name ? tool() : undefined;
      add(waiting(call ? `Waiting for approval: ${call.label}` : first(extra.description, extra.command) ? `Waiting for approval: ${commandHead(first(extra.description, extra.command))}` : 'Waiting for approval', 'approval', call));
      break;
    }
    case 'subagent_start': case 'subagent_stop': {
      const subagentId = id(first(extra.subagent_id, extra.child_session_id, extra.agent_id, extra.task_id), AGENT_ID);
      const role = safeLabel(first(extra.role, extra.goal, extra.name), 80);
      if (subagentId) add(event === 'subagent_start' ? { type: 'subagent.spawned', subagentId, ...(role ? { role, label: role } : {}) } : { type: 'subagent.state', subagentId, state: 'offline' });
      break;
    }
    case 'on_session_end': {
      const error = safeLabel(first(extra.error, obj(extra.error).message), 300);
      if (extra.interrupted === true) { add({ type: 'turn.failed', error: 'Interrupted', reason: 'interrupted' }); add(stopped('interrupted', undefined, 'interrupted')); }
      else if (error || extra.failed === true) {
        const reason = stopReasonOf(error, errorCode(extra.error_type) ?? errorCode(obj(extra.error).type) ?? errorCode(obj(extra.error).code));
        add({ type: 'turn.failed', error: error || 'The turn failed.', ...(reason ? { reason } : {}) });
        add(stopped(reason === 'interrupted' ? 'interrupted' : 'error', error || undefined, reason));
      }
      else { add({ type: 'turn.completed', ...(model ? { model } : {}) }); add({ type: 'agent.state', state: 'idle' }); }
      break;
    }
    case 'on_session_finalize':
      // The Hermes session closed (CLI exit or reset); a new run starts a new session.
      add({ type: 'session.ended' });
      add({ type: 'agent.state', state: 'offline' });
      break;
    default: break;
  }
  return {
    app: 'hermes', sessionId, event: event || 'unknown', starts: event === 'on_session_start', ends: false, steps,
    ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(profile ? { profile } : {}), ...(titleHint ? { titleHint } : {}),
  };
}

const NORMALIZERS: Readonly<Record<HookApp, (payload: unknown, options?: NormalizeHookOptions) => NormalizedHook | undefined>> = {
  codex: normalizeCodexHook, claude: normalizeClaudeHook, gemini: normalizeGeminiHook, antigravity: normalizeAntigravityHook, hermes: normalizeHermesHook,
};

export function normalizeHook(app: HookApp, payload: unknown, options?: NormalizeHookOptions): NormalizedHook | undefined {
  try { return NORMALIZERS[app](payload, options); } catch { return undefined; }
}

export interface HookEventContext {
  /** Extalia session id of the observed session. */
  sessionId: string;
  /** Event time (ISO, UTC). */
  at: string;
  /** Event id for the step at this index. */
  id(index: number): string;
}

/** Validated protocol events for a normalized hook; a step that cannot form a valid event is left out. */
export function hookProtocolEvents(hook: Pick<NormalizedHook, 'app' | 'steps'>, context: HookEventContext): ExtaliaEvent[] {
  const source = hookSource(hook.app);
  const events: ExtaliaEvent[] = [];
  hook.steps.forEach((step, index) => {
    try { events.push(createEvent({ id: context.id(index), at: context.at, sessionId: context.sessionId, agentId: step.agentId, source, body: step.body })); }
    catch { /* invalid step */ }
  });
  return events;
}
