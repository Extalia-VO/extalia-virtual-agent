import { EFFORTS, literalProjectPath, safeLabel, safeText, stopReasonOf, type Effort, type StopReason } from '@extalia/core';
import {
  commandHead, explicitToolFailure, extractAntigravityInvokeSpawns, extractAntigravityJsonValues, extractAntigravitySwarmSpawns,
  extractWrittenFiles, outputText, statedSuccess, stepOutput, toolHints,
} from '@extalia/importers';
import { AGENT_APP_IDS, type AgentAppId } from '@extalia/platform';
import { createEvent, type AgentPhase, type EventBody, type EventSource, type ExtaliaEvent } from '@extalia/protocol';
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

export interface NormalizedSubagentSpawn {
  subagentId: string;
  label?: string;
  role?: string;
  model?: string;
}

export interface NormalizeHookOptions {
  /** Drop prompt/reply/tool output and meeting content, keeping activity and meeting presence only. */
  labelsOnly?: boolean;
}

export interface NormalizedHook {
  app: HookApp;
  /** Native session id (single line, at most 200 characters). */
  sessionId: string;
  /** Explicit parent native session/conversation id when reported by a child hook payload. */
  parentSessionId?: string;
  /** Native hook event name as reported (bounded label). */
  event: string;
  /** The app reports a new or resumed session. */
  starts: boolean;
  /** The app reports the end of the session. */
  ends: boolean;
  cwd?: string;
  transcriptPath?: string;
  model?: string;
  /** The actor that supplied metadata; child reports never replace the lead's settings. */
  agentId?: string;
  /** Explicit top-level source effort only, independent of prompt/reasoning bodies. */
  effort?: Effort;
  /** Includes invalid/unknown explicit settings, which clear an older effort. */
  effortReported?: boolean;
  /** Hermes profile name. */
  profile?: string;
  /** v0.0.38: Claude Code `agent_type` of the sub-agent a hook fired in, for announcing it when its start was missed. */
  agentType?: string;
  /** First line of the prompt, redacted, for the title of a new session. */
  titleHint?: string;
  steps: HookStep[];
  /** Child conversations spawned by this hook event, for linking subsequent child hooks into the parent tree. */
  subagentSpawns?: NormalizedSubagentSpawn[];
  /** Ephemeral lead suggestions; never projected as protocol events or saved. */
  followupPrompts?: string[];
}

const PROMPT_LIMIT = 20_000;
const REPLY_LIMIT = 20_000;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type Row = Record<string, unknown>;
const obj = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const first = (...values: unknown[]): string => { for (const value of values) if (typeof value === 'string' && value.trim()) return value; return ''; };

/** Only explicit transport fields are settings; free text and nested tool data are never inspected. */
function reportedSettings(payload: Row): Pick<NormalizedHook, 'effort' | 'effortReported' | 'agentId'> {
  const key = ['effort', 'reasoning_effort', 'effortLevel'].find(field => Object.hasOwn(payload, field));
  const agentId = id(payload.agent_id ?? payload.agentId, AGENT_ID);
  const effort = key === undefined ? undefined : payload[key];
  return { ...(agentId ? { agentId } : {}), ...(key !== undefined ? { effortReported: true } : {}),
    ...((EFFORTS as readonly unknown[]).includes(effort) ? { effort: effort as Effort } : {}) };
}

/** An absolute, single-line path of bounded length; anything else is dropped. */
function pathField(value: unknown): string | undefined {
  const text = literalProjectPath(value);
  if (!text) return undefined;
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(text) ? text : undefined;
}

const id = (value: unknown, pattern: RegExp): string | undefined => {
  const text = str(value).trim();
  return pattern.test(text) ? text : undefined;
};

/** Exact reporting tool suffixes, including namespaced MCP names; ordinary tool names never imply a meeting. */
function mcpReportToolName(rawName: unknown): 'report_intent' | 'report_handoff' | 'report_meeting' | 'report_followups' | undefined {
  const name = str(rawName).trim();
  if (!name) return undefined;
  if (name === 'report_intent' || /(?:^|__|\/|:)report_intent$/.test(name)) return 'report_intent';
  if (name === 'report_handoff' || /(?:^|__|\/|:)report_handoff$/.test(name)) return 'report_handoff';
  if (name === 'report_followups' || /(?:^|__|\/|:)report_followups$/.test(name)) return 'report_followups';
  if (name === 'report_meeting' || /(?:^|__|\/|:)report_meeting$/.test(name)) return 'report_meeting';
  return undefined;
}

/** Explicit hook reports may carry report fields beside their transport envelope. */
function reportEventInput(tool: string, input: unknown, envelope: Row): unknown {
  if (tool !== 'report_meeting' && tool !== 'report_followups' || input !== envelope) return input;
  const transport = new Set(['hook_event_name', 'hookEventName', 'event', 'sessionId', 'conversationId', 'cwd', 'transcript_path', 'transcriptPath', 'model', 'modelName', 'profile', 'workspacePaths']);
  return Object.fromEntries(Object.entries(envelope).filter(([key]) => !transport.has(key)));
}

/** A report cannot nominate another session or make a child act as its lead. */
function sourceMcpReport(tool: string, input: unknown, payload: Row, sessionId: string, options: NormalizeHookOptions) {
  if (tool === 'report_followups') {
    const fields = obj(input);
    const actorId = payload.agent_id ?? payload.agentId;
    if (actorId !== undefined && actorId !== 'primary' || fields.session_id !== undefined && fields.session_id !== sessionId) return undefined;
  }
  return normalizeMcpReport(tool, input, options);
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

interface GeminiPendingDelegate {
  subagentId: string;
  label?: string;
  role?: string;
  model?: string;
}

const claudeStylePendingTools = new Map<string, { name: string; input: unknown; cwd?: string; geminiDelegate?: GeminiPendingDelegate }>();
const geminiPendingDelegates = new Map<string, GeminiPendingDelegate[]>();
const geminiDelegateCounters = new Map<string, number>();

const GEMINI_DELEGATE_TOOLS = new Set([
  'delegate_to_agent',
  'codebase_investigator',
  'generalist',
  'cli_help',
  'invoke_subagent',
  'swarm',
  'spawn_agent',
]);

function isGeminiDelegateTool(rawName: string): boolean {
  const normalized = rawName.trim().toLowerCase().replace(/^(?:default_api:|functions\.)/, '');
  return Boolean(normalized) && (GEMINI_DELEGATE_TOOLS.has(normalized) || /^delegate_/.test(normalized));
}

function geminiDelegateMeta(toolName: string, input: unknown): { label?: string; role?: string; model?: string; explicitId?: string } {
  const parsed = typeof input === 'string' ? (() => { try { return obj(JSON.parse(input)); } catch { return {}; } })() : obj(input);
  const rawRole = first(parsed.agent_name, parsed.agentName, parsed.agent, parsed.name, parsed.Role, parsed.subagent_type, parsed.subagentType, parsed.role, toolName);
  const role = safeLabel(rawRole, 80) || undefined;
  const label = safeLabel(first(parsed.label, rawRole), 80) || undefined;
  const rawModel = first(parsed.model, parsed.Model);
  const model = rawModel && !/^(?:none|auto)$/i.test(rawModel.trim()) ? safeLabel(rawModel, 120) || undefined : undefined;
  const explicitId = id(parsed.subagent_id ?? parsed.subagentId ?? parsed.agent_id ?? parsed.agentId, AGENT_ID);
  return { ...(label ? { label } : {}), ...(role ? { role } : {}), ...(model ? { model } : {}), ...(explicitId ? { explicitId } : {}) };
}

function geminiAsyncChildSession(response: unknown, parentSessionId: string): NormalizedSubagentSpawn | undefined {
  for (const value of extractAntigravityJsonValues(response)) {
    if (Array.isArray(value)) continue;
    const rec = obj(value);
    const childId = id(rec.session_id ?? rec.sessionId ?? rec.conversation_id ?? rec.conversationId ?? rec.child_session_id ?? rec.childSessionId, SESSION_ID);
    if (!childId || childId === parentSessionId || !AGENT_ID.test(childId)) continue;
    const label = safeLabel(first(rec.agent_name, rec.agentName, rec.label, rec.name, rec.role), 80) || undefined;
    const role = safeLabel(first(rec.agent_type, rec.agentType, rec.role, rec.agent_name, rec.agentName), 80) || undefined;
    const rawModel = first(rec.model_display_name, rec.modelDisplayName, rec.model);
    const model = rawModel && !/^(?:none|auto)$/i.test(rawModel.trim()) ? safeLabel(rawModel, 120) || undefined : undefined;
    return { subagentId: childId, ...(label ? { label } : {}), ...(role ? { role } : {}), ...(model ? { model } : {}) };
  }
  return undefined;
}

function pushGeminiPendingDelegate(sessionId: string, toolName: string, entry: GeminiPendingDelegate): void {
  const key = `${sessionId}:${toolName.trim().toLowerCase()}`;
  const queue = geminiPendingDelegates.get(key) ?? [];
  queue.push(entry);
  if (queue.length > 50) queue.shift();
  geminiPendingDelegates.set(key, queue);
  while (geminiPendingDelegates.size > 200) {
    const oldest = geminiPendingDelegates.keys().next().value;
    if (oldest !== undefined) geminiPendingDelegates.delete(oldest); else break;
  }
}

function shiftGeminiPendingDelegate(sessionId: string, toolName: string): GeminiPendingDelegate | undefined {
  const key = `${sessionId}:${toolName.trim().toLowerCase()}`;
  const queue = geminiPendingDelegates.get(key);
  const entry = queue?.shift();
  if (queue && queue.length === 0) geminiPendingDelegates.delete(key);
  return entry;
}

function nextGeminiDelegateSeq(sessionId: string): number {
  const next = (geminiDelegateCounters.get(sessionId) ?? 0) + 1;
  geminiDelegateCounters.delete(sessionId);
  geminiDelegateCounters.set(sessionId, next);
  while (geminiDelegateCounters.size > 200) {
    const oldest = geminiDelegateCounters.keys().next().value;
    if (oldest !== undefined) geminiDelegateCounters.delete(oldest); else break;
  }
  return next;
}

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
  const sessionId = id(payload.session_id ?? payload.sessionId ?? payload.conversationId ?? payload.conversation_id, SESSION_ID);
  if (!sessionId) return undefined;
  const event = safeLabel(payload.hook_event_name ?? payload.hookEventName, 80);
  const cwd = pathField(payload.cwd);
  const transcriptPath = pathField(payload.transcript_path ?? payload.transcriptPath);
  const model = safeLabel(typeof payload.model === 'string' ? payload.model : str(obj(payload.model).id) || str(obj(payload.model).display_name), 120) || undefined;
  // Claude Code / Gemini CLI mark hooks fired inside a sub-agent with `agent_id` / `agentId`.
  const inner = id(payload.agent_id ?? payload.agentId, AGENT_ID);
  const explicitSubagentId = id(payload.subagent_id ?? payload.subagentId, AGENT_ID);
  const parentSessionIdRaw = id(payload.parent_session_id ?? payload.parentSessionId ?? payload.parent_conversation_id ?? payload.parentConversationId, SESSION_ID);
  const parentSessionId = parentSessionIdRaw && parentSessionIdRaw !== sessionId ? parentSessionIdRaw : undefined;
  const agentId = inner ?? 'primary';
  const steps: HookStep[] = [];
  const subagentSpawns: NormalizedSubagentSpawn[] = [];
  let followupPrompts: string[] | undefined;
  const add = (body: EventBody, agent = agentId) => steps.push({ body, agentId: agent });
  let titleHint: string | undefined;

  const toolNameField = payload.tool_name ?? payload.toolName;
  const toolInputField = payload.tool_input ?? payload.toolInput;
  const toolCallIdField = payload.tool_use_id ?? payload.tool_call_id ?? payload.toolUseId ?? payload.toolCallId;
  const toolResponseField = payload.tool_response ?? payload.toolResponse ?? payload.tool_output ?? payload.toolOutput;

  const mcpEventTool = mcpReportToolName(event);
  if (mcpEventTool) {
    const report = sourceMcpReport(mcpEventTool, reportEventInput(mcpEventTool, toolInputField ?? payload, payload), payload, sessionId, options);
    if (report) { steps.push(...report.steps); followupPrompts = report.followupPrompts; }
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
    const mcpTool = mcpReportToolName(toolNameField);
    if (mcpTool) {
      const report = sourceMcpReport(mcpTool, toolInputField, payload, sessionId, options);
      if (report) { steps.push(...report.steps); followupPrompts = report.followupPrompts; }
    } else {
      const rawCallId = id(toolCallIdField, AGENT_ID);
      const rawToolName = str(toolNameField);
      let geminiDelegate: GeminiPendingDelegate | undefined;
      if (app === 'gemini' && isGeminiDelegateTool(rawToolName)) {
        const meta = geminiDelegateMeta(rawToolName, toolInputField);
        const roleSlug = (meta.role ?? rawToolName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'worker';
        const candidateId = (explicitSubagentId && explicitSubagentId !== agentId ? explicitSubagentId : undefined)
          ?? (meta.explicitId && meta.explicitId !== agentId ? meta.explicitId : undefined)
          ?? (rawCallId && rawCallId !== agentId ? rawCallId : undefined)
          ?? `gemini-sub-${roleSlug}-${nextGeminiDelegateSeq(sessionId)}`;
        geminiDelegate = {
          subagentId: candidateId,
          ...(meta.label ? { label: meta.label } : {}),
          ...(meta.role ? { role: meta.role } : {}),
          ...(meta.model ? { model: meta.model } : {}),
        };
        if (!rawCallId) pushGeminiPendingDelegate(sessionId, rawToolName, geminiDelegate);
      }
      if (toolNameField !== undefined || toolInputField !== undefined) {
        claudeStylePendingTools.set(`${app}:${sessionId}:${rawCallId ?? 'last'}`, {
          name: rawToolName,
          input: toolInputField,
          ...(cwd ? { cwd } : {}),
          ...(geminiDelegate ? { geminiDelegate } : {}),
        });
        while (claudeStylePendingTools.size > 400) {
          const oldest = claudeStylePendingTools.keys().next().value;
          if (oldest !== undefined) claudeStylePendingTools.delete(oldest); else break;
        }
      }
      const tool = toolOf(toolNameField, toolInputField, rawCallId);
      add(working(tool));
      add(started(tool));
      if (geminiDelegate) {
        add({
          type: 'subagent.spawned',
          subagentId: geminiDelegate.subagentId,
          ...(geminiDelegate.label ? { label: geminiDelegate.label } : {}),
          ...(geminiDelegate.role ? { role: geminiDelegate.role } : {}),
          ...(geminiDelegate.model ? { model: geminiDelegate.model } : {}),
        });
        add({
          type: 'subagent.state',
          subagentId: geminiDelegate.subagentId,
          state: 'working',
          ...(geminiDelegate.label ? { summary: `Running ${geminiDelegate.label}` } : {}),
        });
      }
    }
  } else if (POST_TOOL.has(event)) {
    const rawCallId = id(toolCallIdField, AGENT_ID);
    const pendingKey = `${app}:${sessionId}:${rawCallId ?? 'last'}`;
    const cached = claudeStylePendingTools.get(pendingKey);
    claudeStylePendingTools.delete(pendingKey);
    const effectiveToolName = first(toolNameField, cached?.name);
    const effectiveToolInput = toolInputField ?? cached?.input;
    const effectiveCwd = cwd ?? cached?.cwd;
    const mcpTool = mcpReportToolName(effectiveToolName);
    if (!mcpTool) {
      const tool = toolOf(effectiveToolName, effectiveToolInput, rawCallId);
      const response = toolResponseField;
      const failed = event === 'PostToolUseFailure' || Boolean(obj(response).error) || obj(response).interrupted === true || explicitToolFailure(hookOutput(response));
      const ok = failed ? false : statedSuccess(response) ?? true;
      const out = options.labelsOnly ? undefined : hookOutput(event === 'PostToolUseFailure' ? first(payload.error, response) || response : response);
      add(completed(tool, ok, out));
      if (ok && tool.kind === 'edit') for (const file of extractWrittenFiles(effectiveToolName, effectiveToolInput, response, effectiveCwd)) add({ type: 'file.written', path: file.path, change: file.change, ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}) });
      if (app === 'gemini' && isGeminiDelegateTool(effectiveToolName)) {
        const pendingDelegate = cached?.geminiDelegate ?? (!rawCallId ? shiftGeminiPendingDelegate(sessionId, effectiveToolName) : undefined);
        const meta = geminiDelegateMeta(effectiveToolName, effectiveToolInput);
        const label = pendingDelegate?.label ?? meta.label;
        const role = pendingDelegate?.role ?? meta.role;
        const subModel = pendingDelegate?.model ?? meta.model;
        const syncSubagentId = pendingDelegate?.subagentId
          ?? (explicitSubagentId && explicitSubagentId !== agentId ? explicitSubagentId : undefined)
          ?? (meta.explicitId && meta.explicitId !== agentId ? meta.explicitId : undefined)
          ?? (rawCallId && rawCallId !== agentId ? rawCallId : undefined);
        const asyncChild = ok ? geminiAsyncChildSession(response, sessionId) : undefined;
        if (asyncChild) {
          const spawn: NormalizedSubagentSpawn = {
            subagentId: asyncChild.subagentId,
            ...((asyncChild.label ?? label) ? { label: asyncChild.label ?? label } : {}),
            ...((asyncChild.role ?? role) ? { role: asyncChild.role ?? role } : {}),
            ...((asyncChild.model ?? subModel) ? { model: asyncChild.model ?? subModel } : {}),
          };
          subagentSpawns.push(spawn);
          if (syncSubagentId && syncSubagentId !== spawn.subagentId) {
            add({ type: 'subagent.state', subagentId: syncSubagentId, state: 'offline' });
            add({ type: 'subagent.spawned', ...spawn });
          } else if (!syncSubagentId) {
            add({ type: 'subagent.spawned', ...spawn });
          }
        } else if (syncSubagentId) {
          add({ type: 'subagent.state', subagentId: syncSubagentId, state: 'offline' });
        }
      }
      // Claude Code: the user pressed Esc while the tool ran.
      if (event === 'PostToolUseFailure' && payload.is_interrupt === true) add(stopped('interrupted', undefined, 'interrupted'));
    }
  } else if (event === 'PermissionRequest') {
    const tool = toolNameField !== undefined ? toolOf(toolNameField, toolInputField, toolCallIdField) : undefined;
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
    const subagentId = inner ?? explicitSubagentId;
    const role = safeLabel(first(payload.agent_type, payload.agentType, payload.subagent_type, payload.subagentType), 80);
    const label = safeLabel(first(payload.agent_name, payload.agentName, role), 80);
    if (subagentId) add({ type: 'subagent.spawned', subagentId, ...(role ? { role } : {}), ...(label ? { label } : {}) }, 'primary');
  } else if (event === 'SubagentStop') {
    const subagentId = inner ?? explicitSubagentId;
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
  const agentType = inner ? safeLabel(first(payload.agent_type, payload.agentType, payload.subagent_type, payload.subagentType, payload.agent_name, payload.agentName), 80) : '';
  return {
    app, sessionId, ...(parentSessionId ? { parentSessionId } : {}), ...reportedSettings(payload), event: event || 'unknown', starts: START.has(event), ends: END.has(event), steps,
    ...(subagentSpawns.length ? { subagentSpawns } : {}), ...(followupPrompts ? { followupPrompts } : {}), ...(agentType ? { agentType } : {}),
    ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...(model ? { model } : {}), ...(titleHint ? { titleHint } : {}),
  };
}

export const normalizeClaudeHook = (payload: unknown, options?: NormalizeHookOptions) => claudeStyle('claude', payload, options);
/** Codex 0.16x command hooks use Claude Code's payload fields (`apply_patch`, `Bash`, … as tool names). */
export const normalizeCodexHook = (payload: unknown, options?: NormalizeHookOptions) => claudeStyle('codex', payload, options);
/** Gemini CLI: SessionStart/End, BeforeAgent/AfterAgent, BeforeTool/AfterTool, Notification. */
export const normalizeGeminiHook = (payload: unknown, options?: NormalizeHookOptions) => claudeStyle('gemini', payload, options);

const antigravityPendingTools = new Map<string, Array<{ callId?: string; name: string; input: unknown; cwd?: string }>>();
const antigravityBackgroundTasks = new Map<string, Map<string, Tool>>();
const antigravitySwarmWorkers = new Map<string, Map<string, string>>();
const antigravityTrackedChildren = new Map<string, Set<string>>();

function unquoteAntigravityArg(value: unknown): string {
  const text = str(value).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { const parsed: unknown = JSON.parse(text); if (typeof parsed === 'string') return parsed.trim(); } catch { /* keep raw */ }
  }
  return text;
}

function parseAntigravityArgs(raw: unknown): Row {
  if (typeof raw === 'string') {
    try { return obj(JSON.parse(raw)); } catch { return {}; }
  }
  return obj(raw);
}

function rememberAntigravityChild(sessionId: string, childId: string, workerName?: string): void {
  const children = antigravityTrackedChildren.get(sessionId) ?? new Set<string>();
  children.add(childId);
  while (children.size > 100) {
    const oldest = children.values().next().value;
    if (oldest !== undefined) children.delete(oldest); else break;
  }
  antigravityTrackedChildren.delete(sessionId);
  antigravityTrackedChildren.set(sessionId, children);
  while (antigravityTrackedChildren.size > 200) {
    const oldest = antigravityTrackedChildren.keys().next().value;
    if (oldest !== undefined) antigravityTrackedChildren.delete(oldest); else break;
  }
  if (workerName) {
    const workers = antigravitySwarmWorkers.get(sessionId) ?? new Map<string, string>();
    workers.delete(workerName);
    workers.set(workerName, childId);
    while (workers.size > 100) {
      const oldest = workers.keys().next().value;
      if (oldest !== undefined) workers.delete(oldest); else break;
    }
    antigravitySwarmWorkers.delete(sessionId);
    antigravitySwarmWorkers.set(sessionId, workers);
    while (antigravitySwarmWorkers.size > 200) {
      const oldest = antigravitySwarmWorkers.keys().next().value;
      if (oldest !== undefined) antigravitySwarmWorkers.delete(oldest); else break;
    }
  }
}

function forgetAntigravityChild(sessionId: string, childId: string): void {
  const children = antigravityTrackedChildren.get(sessionId);
  if (children) {
    children.delete(childId);
    if (children.size === 0) antigravityTrackedChildren.delete(sessionId);
  }
  const workers = antigravitySwarmWorkers.get(sessionId);
  if (workers) {
    for (const [name, tracked] of [...workers.entries()]) {
      if (tracked === childId) workers.delete(name);
    }
    if (workers.size === 0) antigravitySwarmWorkers.delete(sessionId);
  }
}

function extractAntigravityIdList(raw: unknown, excludeId: string): string[] {
  let value = raw;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      try { value = JSON.parse(trimmed); } catch { /* plain text */ }
    }
  }
  const items = Array.isArray(value) ? value : value !== undefined && value !== null ? [value] : [];
  const out: string[] = [];
  for (const item of items.slice(0, 100)) {
    const clean = id(unquoteAntigravityArg(item), AGENT_ID);
    if (clean && clean !== excludeId && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function shortBackgroundTaskKey(taskId: string): string {
  const parts = taskId.trim().split('/').filter(Boolean);
  return parts.at(-1) ?? taskId.trim();
}

export function clearAntigravityBackgroundTasks(sessionId: string): void {
  antigravityBackgroundTasks.delete(sessionId);
}

export function hasAntigravityBackgroundTasks(sessionId: string): boolean {
  return (antigravityBackgroundTasks.get(sessionId)?.size ?? 0) > 0;
}

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
  const sessionId = id(payload.session_id ?? payload.sessionId ?? payload.conversationId ?? payload.conversation_id, SESSION_ID);
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
  const inner = id(payload.agent_id ?? payload.agentId, AGENT_ID);
  const agentId = inner ?? 'primary';
  const parentSessionIdRaw = id(payload.parentConversationId ?? payload.parent_conversation_id ?? payload.parentSessionId ?? payload.parent_session_id, SESSION_ID);
  const parentSessionId = parentSessionIdRaw && parentSessionIdRaw !== sessionId ? parentSessionIdRaw : undefined;
  const agentType = inner ? safeLabel(first(payload.agent_type, payload.agentType, payload.subagent_type, payload.subagentType, payload.agent_name, payload.agentName), 80) : '';
  const steps: HookStep[] = [];
  const subagentSpawns: NormalizedSubagentSpawn[] = [];
  let followupPrompts: string[] | undefined;
  const add = (body: EventBody, agent = agentId) => steps.push({ body, agentId: agent });
  const stepIdx = typeof payload.stepIdx === 'number' && Number.isInteger(payload.stepIdx) && payload.stepIdx >= 0 ? payload.stepIdx : undefined;
  const callId = stepIdx !== undefined ? `step-${stepIdx}` : id(payload.tool_use_id ?? payload.tool_call_id ?? payload.toolUseId ?? payload.toolCallId ?? obj(payload.toolCall).id, AGENT_ID);

  const mcpEventTool = mcpReportToolName(event);
  if (mcpEventTool) {
    const report = sourceMcpReport(mcpEventTool, reportEventInput(mcpEventTool, payload.tool_input ?? obj(payload.toolCall).args ?? payload, payload), payload, sessionId, options);
    if (report) { steps.push(...report.steps); followupPrompts = report.followupPrompts; }
    return {
      app: 'antigravity', sessionId, ...(parentSessionId ? { parentSessionId } : {}), ...reportedSettings(payload), event: event || 'unknown', starts: false, ends: false, steps, ...(followupPrompts ? { followupPrompts } : {}),
      ...(agentType ? { agentType } : {}), ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}), ...(model ? { model } : {}),
    };
  }

  switch (event) {
    case 'PreInvocation':
    case 'PostInvocation':
      add({ type: 'agent.state', state: 'thinking' });
      break;
    case 'PreToolUse': {
      const toolCall = obj(payload.toolCall);
      const rawName = (first(toolCall.name, payload.tool_name, payload.toolName) || 'tool').replace(/^default_api:/, '');
      const rawInput = toolCall.args ?? payload.tool_input ?? payload.toolInput;
      const mcpTool = mcpReportToolName(rawName);
      if (mcpTool) {
        const report = sourceMcpReport(mcpTool, rawInput, payload, sessionId, options);
        if (report) { steps.push(...report.steps); followupPrompts = report.followupPrompts; }
      } else {
        let effectiveCallId = callId;
        const key = `${sessionId}:${callId ?? 'last'}`;
        const queue = antigravityPendingTools.get(key) ?? [];
        if (callId && queue.length > 0) effectiveCallId = `${callId}-${queue.length + 1}`;
        queue.push({ ...(effectiveCallId ? { callId: effectiveCallId } : {}), name: rawName, input: rawInput, ...(cwd ? { cwd } : {}) });
        if (queue.length > 50) queue.shift();
        antigravityPendingTools.set(key, queue);
        while (antigravityPendingTools.size > 400) {
          const oldest = antigravityPendingTools.keys().next().value;
          if (oldest !== undefined) antigravityPendingTools.delete(oldest); else break;
        }
        const tool = toolOf(rawName, rawInput, effectiveCallId);
        add(working(tool));
        add(started(tool));
      }
      break;
    }
    case 'PostToolUse': {
      const key = `${sessionId}:${callId ?? 'last'}`;
      const queue = antigravityPendingTools.get(key);
      const cached = queue?.shift();
      if (!queue || queue.length === 0) antigravityPendingTools.delete(key);
      const toolCall = obj(payload.toolCall);
      const rawName = (first(toolCall.name, payload.tool_name, payload.toolName, cached?.name) || 'tool').replace(/^default_api:/, '');
      const rawInput = toolCall.args ?? payload.tool_input ?? payload.toolInput ?? cached?.input;
      const effectiveCwd = cwd ?? cached?.cwd;
      const effectiveCallId = cached?.callId ?? callId;
      if (!mcpReportToolName(rawName)) {
        const tool = toolOf(rawName, rawInput, effectiveCallId);
        const errText = str(payload.error).trim();
        const response = payload.tool_response ?? payload.toolResponse ?? payload.tool_output ?? payload.toolOutput;
        const rawResponseText = str(outputText(response)) || hookOutput(response) || str(response);
        const statusText = str(payload.status ?? toolCall.status).trim().toUpperCase();
        const bgTaskMatch = /Tool is running as a background task with task id:\s*([^\s"'`<>]+)/i.exec(rawResponseText);
        if (!errText && (bgTaskMatch || statusText === 'RUNNING') && rawName !== 'schedule' && rawName !== 'invoke_subagent') {
          const taskKey = bgTaskMatch?.[1] ? shortBackgroundTaskKey(bgTaskMatch[1]) : (effectiveCallId || rawName);
          const tasks = antigravityBackgroundTasks.get(sessionId) ?? new Map<string, Tool>();
          tasks.set(taskKey, tool);
          antigravityBackgroundTasks.set(sessionId, tasks);
          while (antigravityBackgroundTasks.size > 200) {
            const oldest = antigravityBackgroundTasks.keys().next().value;
            if (oldest !== undefined) antigravityBackgroundTasks.delete(oldest); else break;
          }
          add(working(tool));
          break;
        }
        const ok = errText || explicitToolFailure(hookOutput(response)) ? false : statedSuccess(response) ?? true;
        const out = options.labelsOnly ? undefined : hookOutput(errText || response);
        add(completed(tool, ok, out));
        if (ok && rawName === 'swarm') {
          const args = parseAntigravityArgs(rawInput);
          const action = unquoteAntigravityArg(args.action ?? args.Action).toLowerCase();
          if (!action || action === 'add') {
            for (const spawn of extractAntigravitySwarmSpawns(rawInput, response, sessionId)) {
              const record: NormalizedSubagentSpawn = {
                subagentId: spawn.subagentId,
                ...(spawn.label ? { label: spawn.label } : {}),
                ...(spawn.role ? { role: spawn.role } : {}),
                ...(spawn.model ? { model: spawn.model } : {}),
              };
              add({ type: 'subagent.spawned', ...record });
              subagentSpawns.push(record);
              rememberAntigravityChild(sessionId, spawn.subagentId, spawn.label);
            }
          } else if (action === 'kill') {
            const parsedResponses = extractAntigravityJsonValues(response).filter(value => !Array.isArray(value)).map(obj);
            const workerName = safeLabel(first(
              unquoteAntigravityArg(args.name ?? args.Name),
              ...parsedResponses.map(item => first(item.name, item.worker_name, item.workerName)),
            ), 120);
            const responseChildId = parsedResponses
              .map(item => id(item.conversation_id ?? item.conversationId, AGENT_ID))
              .find(candidate => candidate && candidate !== sessionId);
            const trackedChildId = workerName ? antigravitySwarmWorkers.get(sessionId)?.get(workerName) : undefined;
            const childId = trackedChildId ?? responseChildId;
            if (childId) {
              add({ type: 'subagent.state', subagentId: childId, state: 'offline' });
              forgetAntigravityChild(sessionId, childId);
            }
          }
        } else if (ok && rawName === 'invoke_subagent') {
          for (const spawn of extractAntigravityInvokeSpawns(rawInput, response, sessionId)) {
            const record: NormalizedSubagentSpawn = {
              subagentId: spawn.subagentId,
              ...(spawn.label ? { label: spawn.label } : {}),
              ...(spawn.role ? { role: spawn.role } : {}),
              ...(spawn.model ? { model: spawn.model } : {}),
            };
            add({ type: 'subagent.spawned', ...record });
            subagentSpawns.push(record);
            rememberAntigravityChild(sessionId, spawn.subagentId);
          }
        } else if (ok && rawName === 'manage_subagents') {
          const args = parseAntigravityArgs(rawInput);
          const action = unquoteAntigravityArg(args.Action ?? args.action).toLowerCase();
          if (action === 'kill') {
            const ids = extractAntigravityIdList(args.ConversationIds ?? args.conversationIds ?? args.conversation_ids ?? args.ConversationId ?? args.conversationId ?? args.conversation_id, sessionId);
            for (const childId of ids) {
              add({ type: 'subagent.state', subagentId: childId, state: 'offline' });
              forgetAntigravityChild(sessionId, childId);
            }
          } else if (action === 'kill_all') {
            const allTracked = new Set<string>([
              ...(antigravityTrackedChildren.get(sessionId) ?? []),
              ...(antigravitySwarmWorkers.get(sessionId)?.values() ?? []),
            ]);
            for (const childId of allTracked) {
              add({ type: 'subagent.state', subagentId: childId, state: 'offline' });
            }
            antigravityTrackedChildren.delete(sessionId);
            antigravitySwarmWorkers.delete(sessionId);
          }
        }
        if (ok && rawName === 'manage_task') {
          const cancelMatch = /Task\s+["']?([^\s"'`<>]+)["']?\s+cancell?ed\b/i.exec(rawResponseText);
          const canceledKey = cancelMatch?.[1] ? shortBackgroundTaskKey(cancelMatch[1]) : undefined;
          const tasks = canceledKey ? antigravityBackgroundTasks.get(sessionId) : undefined;
          const canceledTool = canceledKey && tasks ? tasks.get(canceledKey) : undefined;
          if (canceledKey && tasks && canceledTool) {
            tasks.delete(canceledKey);
            if (tasks.size === 0) antigravityBackgroundTasks.delete(sessionId);
            add(completed(canceledTool, false, options.labelsOnly ? undefined : safeLabel(`Canceled background task (${canceledKey}).`, 400)));
          }
        }
        if (ok && tool.kind === 'edit') {
          for (const file of extractWrittenFiles(rawName, rawInput, response, effectiveCwd)) {
            add({ type: 'file.written', path: file.path, change: file.change, ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}) });
          }
        }
      }
      break;
    }
    case 'Stop': {
      const errText = str(payload.error).trim();
      const reasonText = str(payload.terminationReason).trim().toLowerCase();
      if (errText || reasonText === 'error') {
        antigravityBackgroundTasks.delete(sessionId);
        const error = safeLabel(errText || 'The turn failed.', 300) || 'The turn failed.';
        for (const body of failedTurn(error, stopReasonOf(errText || error))) add(body);
      } else {
        const bgTasks = antigravityBackgroundTasks.get(sessionId);
        if (bgTasks && bgTasks.size > 0) {
          const activeTool = [...bgTasks.values()].at(-1)!;
          add(working(activeTool));
        } else {
          add({ type: 'turn.completed', ...(model ? { model } : {}) });
          add({ type: 'agent.state', state: 'idle' });
        }
      }
      break;
    }
    default:
      return claudeStyle('antigravity', payload, options);
  }

  return {
    app: 'antigravity', sessionId, ...(parentSessionId ? { parentSessionId } : {}), ...reportedSettings(payload), event: event || 'unknown', starts: event === 'PreInvocation', ends: false, steps,
    ...(subagentSpawns.length ? { subagentSpawns } : {}), ...(followupPrompts ? { followupPrompts } : {}), ...(agentType ? { agentType } : {}),
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
  let followupPrompts: string[] | undefined;
  const add = (body: EventBody) => steps.push({ body, agentId: 'primary' });
  const tool = () => toolOf(payload.tool_name, payload.tool_input, extra.tool_call_id ?? extra.call_id);
  const mcpEventTool = mcpReportToolName(event);
  if (mcpEventTool) {
    const report = sourceMcpReport(mcpEventTool, reportEventInput(mcpEventTool, payload.tool_input ?? (payload.extra !== undefined ? extra : payload), payload), payload, sessionId, options);
    if (report) { steps.push(...report.steps); followupPrompts = report.followupPrompts; }
    return { app: 'hermes', sessionId, ...reportedSettings(payload), event: event || 'unknown', starts: false, ends: false, steps, ...(followupPrompts ? { followupPrompts } : {}), ...(cwd ? { cwd } : {}), ...(model ? { model } : {}), ...(profile ? { profile } : {}) };
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
        const report = sourceMcpReport(mcpTool, payload.tool_input, payload, sessionId, options);
        if (report) { steps.push(...report.steps); followupPrompts = report.followupPrompts; }
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
        const ok = extra.error || explicitToolFailure(hookOutput(result)) ? false : statedSuccess(result) ?? true;
        const out = options.labelsOnly ? undefined : hookOutput(extra.error ? first(extra.error) || result : result);
        add(completed(call, ok, out));
        if (ok) for (const file of extractWrittenFiles(call.tool, payload.tool_input, result, cwd)) {
          add({ type: 'file.written', path: file.path, change: file.change, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}) });
        }
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
    app: 'hermes', sessionId, ...reportedSettings(payload), event: event || 'unknown', starts: event === 'on_session_start', ends: false, steps, ...(followupPrompts ? { followupPrompts } : {}),
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
