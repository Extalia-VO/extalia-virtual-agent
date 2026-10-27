import {
  PORTABLE_SESSION_FORMAT, decodePortableSession, safeLabel, safeText, stopReasonOf,
  type ImportMode, type MessageRole, type PortableSession,
} from '@extalia/core';
import { MAX_STEP_ATTACHMENTS, StepList, codexEventAttachments, imageAttachment, outputText, promptAttachments, statedSuccess, stepOutput, stepTime, toolHints, type StepAttachment, type TranscriptContext, type TranscriptStatus, type TranscriptStep } from './steps.js';

/**
 * Parsers for native agent histories. Input is untrusted data: parsers have no
 * file access or side effects (local media is read only through the caller's
 * `ParseContext.readMedia`), never execute anything, drop reasoning fields,
 * mask credentials, and produce validated Extalia portable sessions.
 */
export type NativeSourceId = 'codex' | 'claude-code' | 'hermes' | 'gemini-cli' | 'antigravity';

export interface ParseContext {
  sourceId: NativeSourceId;
  /** Hermes profile; named profiles get their own session identities. */
  profile?: string;
  nativeSessionId?: string;
  projectPath?: string;
  title?: string;
  /** A title the user gave the session in its app (Claude Code `/rename`, Codex thread name); preferred over every other title. */
  customTitle?: string;
  exportedAt?: string;
  importMode?: ImportMode;
  /**
   * Base64 contents of a local media file a transcript refers to by path (Antigravity `media[].uri`),
   * or `undefined` when it cannot or may not be read. Without it such images are listed by name only.
   */
  readMedia?: (path: string) => string | undefined;
}

export interface NativeParseResult {
  session?: PortableSession;
  /** The lead agent's context in use and compactions, when the transcript reports usage (v0.0.48). */
  context?: TranscriptContext;
  /** Structured activity in source order, for live observation; present with `session`. */
  steps?: TranscriptStep[];
  /** The lead agent's latest model, when the transcript states one. */
  model?: string;
  diagnostics: string[];
}

/** A token count the source states (a non-negative safe integer); anything else is not a count. */
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A Claude Code request's prompt size: uncached input plus cache reads and cache writes (the three are
 * reported apart). Undefined when the row reports no input, or only zeros as synthetic error rows do.
 */
function claudePromptTokens(usage: unknown): number | undefined {
  const record = obj(usage);
  if (tokenCount(record.input_tokens) === undefined) return undefined;
  const total = (tokenCount(record.input_tokens) ?? 0) + (tokenCount(record.cache_read_input_tokens) ?? 0) + (tokenCount(record.cache_creation_input_tokens) ?? 0);
  return total > 0 ? total : undefined;
}

/** How a Codex thread was spawned by another thread (Codex multi-agent `thread_spawn`). */
export interface CodexThreadSpawn {
  parentThreadId: string;
  depth?: number;
  nickname?: string;
  role?: string;
  /** Task path such as `/root/task_slug`. */
  path?: string;
}

type RecordValue = Record<string, unknown>;
type Draft = { role: MessageRole; content: string; at?: unknown };

export const MAX_PARSER_INPUT = 16 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_MESSAGES = 10_000;
const MESSAGE_LIMIT = 50_000;
const PROVIDERS: Record<NativeSourceId, string | undefined> = { codex: 'openai', 'claude-code': 'anthropic', hermes: undefined, 'gemini-cli': 'google', antigravity: 'google' };

const obj = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const secretKey = /^(apikey|secret|password|passwd|token|credentials|authorization|bearer|privatekey|accesstoken|refreshtoken|clientsecret)$/;
const thoughtKey = /^(thinking|thoughts|reasoning|reasoningcontent|reasoningdetails|signature|thoughtsignature|encryptedcontent)$/;

/** FNV-1a, 64 bit: a stable, dependency-free id for workspace hints (not a security hash). */
export function stableHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

/** Strip credential and reasoning fields from tool data, including nested arguments. */
function inert(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[nested data omitted]';
  if (typeof value === 'string') return safeText(value, MESSAGE_LIMIT);
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => inert(item, depth + 1));
  if (value && typeof value === 'object' && (obj(value).thought === true || /thinking|reasoning/.test(str(obj(value).type)))) return '[omitted]';
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(obj(value)).slice(0, 1000).map(([key, nested]) => {
      const normalized = key.replace(/[_-]/g, '').toLowerCase();
      return [key, secretKey.test(normalized) ? '[redacted]' : thoughtKey.test(normalized) ? '[omitted]' : inert(nested, depth + 1)];
    }));
  }
  return value;
}

function jsonData(value: unknown): string {
  if (typeof value === 'string') { try { return JSON.stringify(inert(JSON.parse(value))); } catch { return safeText(value, MESSAGE_LIMIT); } }
  return JSON.stringify(inert(value)) ?? '';
}

/** The `attachments` field of a prompt step, when the prompt has any. */
const files = (attached: StepAttachment[]): { attachments?: StepAttachment[] } => attached.length ? { attachments: attached } : {};

function partsText(value: unknown): string {
  if (typeof value === 'string') return value;
  const parts = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
  return parts.map(part => {
    if (typeof part === 'string') return part;
    const piece = obj(part);
    if (piece.thought === true || /thinking|reasoning/.test(str(piece.type))) return '';
    return !piece.type || ['text', 'input_text', 'output_text'].includes(str(piece.type)) ? str(piece.text) : '';
  }).filter(Boolean).join('\n');
}

export function toEpochMs(value: unknown): number | undefined {
  const result = typeof value === 'number' ? (Math.abs(value) < 1e12 ? value * 1000 : value) : typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(result) && Math.abs(result) <= 8.64e15 ? result : undefined;
}

function records(text: string, diagnostics: string[]): RecordValue[] | undefined {
  if (text.length > MAX_PARSER_INPUT) { diagnostics.push('The history file exceeds the 16 MiB parser limit.'); return undefined; }
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length > MAX_RECORDS) { diagnostics.push('The history file has too many records.'); return undefined; }
  const result: RecordValue[] = [];
  let bad = 0;
  for (const line of lines) {
    try { const row = obj(JSON.parse(line)); if (Object.keys(row).length) result.push(row); else bad++; } catch { bad++; }
  }
  if (bad) diagnostics.push(`${bad} malformed records were skipped.`);
  return result;
}

/**
 * Context an agent app injects as a user-role message (instructions, environment,
 * command wrappers, inter-agent mail). Such messages never become a title.
 */
const INJECTED_CONTEXT = /^\s*(?:<environment_context>|<user_instructions>|<permissions instructions>|<recommended_plugins>|<external_codex_[a-z_]*>|<INSTRUCTIONS>|# AGENTS\.md instructions\b|<agent-message\b|<system-reminder>|<command-(?:name|message|args)>|<local-command-|<task-notification>|<user-prompt-submit-hook>|Caveat: )/;

/** True for injected context rather than something the user typed. */
export function isInjectedContext(text: string): boolean {
  return INJECTED_CONTEXT.test(text);
}

function finish(context: ParseContext, id: unknown, drafts: Draft[], diagnostics: string[], metadata: { path?: unknown; title?: unknown; customTitle?: unknown; start?: unknown; parser: string; model?: string; context?: TranscriptContext }, steps?: StepList): NativeParseResult {
  const nativeId = (str(id) || context.nativeSessionId || '').trim();
  if (!nativeId) return { diagnostics: [...diagnostics, 'The session identity is missing.'] };
  const readable = drafts.filter(message => message.content.trim());
  if (!readable.length) return { diagnostics: [...diagnostics, 'No supported conversation messages were found.'] };
  if (readable.length > MAX_MESSAGES || readable.reduce((size, row) => size + row.content.length, 0) > MAX_PARSER_INPUT) return { diagnostics: [...diagnostics, 'The conversation exceeds the import size limit.'] };

  const validDates = readable.map(message => toEpochMs(message.at)).filter((value): value is number => value !== undefined);
  const start = toEpochMs(metadata.start) ?? validDates[0] ?? toEpochMs(context.exportedAt) ?? 0;
  let previous = Math.min(start, validDates[0] ?? start), adjusted = false, clipped = false;
  const messages = readable.map((message, index) => {
    const original = toEpochMs(message.at), current = Math.max(previous, original ?? previous);
    if (original === undefined || current !== original) adjusted = true;
    previous = current;
    if (message.content.length > MESSAGE_LIMIT) clipped = true;
    return { index, role: message.role, content: safeText(message.content, MESSAGE_LIMIT), createdAt: new Date(current).toISOString() };
  });
  if (adjusted) diagnostics.push('Missing or out-of-order timestamps were normalized in source order.');
  if (clipped) diagnostics.push('Long messages were clipped to 50,000 characters.');

  const profile = context.profile || 'default';
  const sourceSessionId = context.sourceId === 'hermes' && profile !== 'default' ? `profile:${encodeURIComponent(profile)}:${nativeId}` : nativeId;
  const projectLocation = safeText(context.projectPath || str(metadata.path), 2000).trim();
  const firstUser = messages.find(message => message.role === 'user' && !isInjectedContext(message.content) && safeLabel(message.content, 160))?.content;
  const exportedAt = new Date(toEpochMs(context.exportedAt) ?? Date.now()).toISOString();
  const provider = PROVIDERS[context.sourceId];
  const session: PortableSession = {
    format: PORTABLE_SESSION_FORMAT,
    title: safeLabel(context.customTitle || str(metadata.customTitle) || context.title || str(metadata.title) || firstUser || `${context.sourceId} conversation`, 160) || `${context.sourceId} conversation`,
    importMode: context.importMode ?? 'imported',
    provenance: {
      sourceId: context.sourceId,
      sourceSessionId: safeLabel(sourceSessionId, 200),
      exportedAt,
      ...(provider ? { providerId: provider } : {}),
      originVersion: `native/${metadata.parser}/v1${context.sourceId === 'hermes' ? `;profile=${safeLabel(profile, 40)}` : ''}`.slice(0, 64),
    },
    ...(projectLocation ? { workspace: { slug: `w-${stableHash(projectLocation)}`, name: safeLabel(baseName(projectLocation), 120) || 'Project', projectLocation } } : {}),
    messages,
    startedAt: new Date(Math.min(start, Date.parse(messages[0]!.createdAt))).toISOString(),
    lastMessageAt: messages.at(-1)!.createdAt,
  };
  const decoded = decodePortableSession(session);
  return decoded.ok ? { session: decoded.value, ...(steps ? { steps: steps.steps } : {}), ...(metadata.model ? { model: metadata.model } : {}), ...(metadata.context ? { context: metadata.context } : {}), diagnostics } : { diagnostics: [...diagnostics, `The conversation failed validation: ${decoded.errors.join(' ')}`] };
}

/** Context Codex injects as user-role messages; it is not something the user typed (bug 7). */
const CODEX_INJECTED = /^\s*(?:<environment_context>|<user_instructions>|<permissions instructions>|<recommended_plugins>|<external_codex_[a-z_]*>|<INSTRUCTIONS>|# AGENTS\.md instructions\b)/;
const CODEX_FINAL_EVENTS = new Set(['task_complete', 'turn_complete']);
/** v0.0.38: Codex `event_msg` types that state a status: a started task, approval and input requests, errors. */
const CODEX_STATUS_EVENTS: Readonly<Record<string, TranscriptStatus>> = {
  task_started: 'thinking', turn_started: 'thinking',
  exec_approval_request: 'approval', apply_patch_approval_request: 'approval', request_permissions: 'approval',
  request_user_input: 'input', elicitation_request: 'input',
  error: 'error',
};

/**
 * The `thread_spawn` origin of a Codex rollout's `session_meta` payload: the
 * thread that spawned it, depth, nickname and role. Undefined for threads the
 * user started.
 */
export function codexThreadSpawn(sessionMeta: unknown): CodexThreadSpawn | undefined {
  const meta = obj(sessionMeta), spawn = obj(obj(obj(meta.source).subagent).thread_spawn);
  const parentThreadId = str(spawn.parent_thread_id) || (str(meta.thread_source) === 'subagent' || Object.keys(spawn).length ? str(meta.parent_thread_id) : '');
  if (!parentThreadId.trim()) return undefined;
  const nickname = safeLabel(str(spawn.agent_nickname) || str(meta.agent_nickname), 120);
  const role = safeLabel(str(spawn.agent_role) || str(meta.agent_role), 120);
  const path = safeLabel(str(spawn.agent_path) || str(meta.agent_path), 200);
  const depth = typeof spawn.depth === 'number' && Number.isInteger(spawn.depth) && spawn.depth > 0 ? spawn.depth : undefined;
  return { parentThreadId: safeLabel(parentThreadId, 200), ...(depth ? { depth } : {}), ...(nickname ? { nickname } : {}), ...(role ? { role } : {}), ...(path ? { path } : {}) };
}

/** Codex rollout JSONL: response items plus event mirrors that are paired so prompts are not duplicated. */
export function parseCodex(text: string, context: ParseContext): NativeParseResult {
  const diagnostics: string[] = [], rows = records(text, diagnostics);
  if (!rows) return { diagnostics };
  const meta = obj(rows.find(row => row.type === 'session_meta')?.payload);
  if (!Object.keys(meta).length) return { diagnostics: [...diagnostics, 'Unsupported Codex rollout: session_meta is missing.'] };
  type Mirror = { index: number; at?: number; turn: string };
  const events = new Map<string, Mirror[]>(), matched = new Set<number>();
  for (const [index, row] of rows.entries()) {
    const payload = obj(row.payload);
    if (row.type !== 'event_msg' || !['user_message', 'agent_message'].includes(str(payload.type)) || (payload.type === 'user_message' && CODEX_INJECTED.test(str(payload.message)))) continue;
    const key = JSON.stringify([payload.type === 'user_message' ? 'user' : 'assistant', str(payload.message)]);
    const candidates = events.get(key) ?? [];
    candidates.push({ index, at: toEpochMs(row.timestamp), turn: str(payload.turn_id) || str(row.turn_id) });
    events.set(key, candidates);
  }
  // Pair only nearby mirrors one-to-one, so identical prompts from older turns stay visible.
  for (const [index, row] of rows.entries()) {
    const payload = obj(row.payload);
    if (row.type !== 'response_item' || payload.type !== 'message' || !['user', 'assistant'].includes(str(payload.role)) || payload.channel === 'analysis') continue;
    const content = partsText(payload.content);
    if (!content || (payload.role === 'user' && CODEX_INJECTED.test(content))) continue;
    const candidates = events.get(JSON.stringify([payload.role, content]));
    if (!candidates?.length) continue;
    const at = toEpochMs(row.timestamp), turn = str(payload.turn_id) || str(row.turn_id);
    let low = 0, high = candidates.length;
    while (low < high) { const mid = (low + high) >>> 1; if (candidates[mid]!.index < index) low = mid + 1; else high = mid; }
    let best: Mirror | undefined, bestScore = Infinity;
    // Bounded even when a transcript repeats the same text thousands of times.
    for (let offset = Math.max(0, low - 64); offset < Math.min(candidates.length, low + 64); offset++) {
      const candidate = candidates[offset]!;
      if (matched.has(candidate.index) || (turn && candidate.turn && turn !== candidate.turn)) continue;
      const sameTurn = Boolean(turn) && turn === candidate.turn;
      const gap = at !== undefined && candidate.at !== undefined ? Math.abs(at - candidate.at) : undefined;
      const adjacency = Math.abs(index - candidate.index);
      if (!sameTurn && (gap === undefined ? adjacency > 8 : gap > 2000)) continue;
      const score = (gap ?? 0) + adjacency / (MAX_RECORDS + 1);
      if (score < bestScore) { best = candidate; bestScore = score; }
    }
    if (best) matched.add(best.index);
  }
  const drafts: Draft[] = [], steps = new StepList();
  let model: string | undefined;
  // v0.0.48: context in use is the latest request's input (`last_token_usage`); the thread total is not context.
  let usedTokens: number | undefined, windowTokens: number | undefined, compactedRows = 0, compactedEvents = 0;
  for (const [index, row] of rows.entries()) {
    const payload = obj(row.payload), pos = `L${index}`, at = stepTime(row.timestamp);
    const base = { pos, ...(at ? { at } : {}) };
    if (row.type === 'turn_context' && str(payload.model)) model = safeLabel(payload.model, 120);
    if (row.type === 'event_msg' && payload.type === 'token_count') {
      // Rate-limit-only reports carry no `info`; they keep the last reading.
      const info = obj(payload.info);
      usedTokens = tokenCount(obj(info.last_token_usage).input_tokens) ?? usedTokens;
      const window = tokenCount(info.model_context_window);
      if (window) windowTokens = window;
    }
    if (row.type === 'compacted') compactedRows++;
    else if (row.type === 'event_msg' && payload.type === 'context_compacted') compactedEvents++;
    if (row.type === 'response_item') {
      if (payload.type === 'message' && ['user', 'assistant'].includes(str(payload.role)) && payload.channel !== 'analysis') {
        const content = partsText(payload.content);
        if (payload.role === 'user' && CODEX_INJECTED.test(content)) continue;
        drafts.push({ role: payload.role as MessageRole, content, at: row.timestamp });
        steps.push(payload.role === 'user' ? { ...base, type: 'prompt', text: content, ...files(promptAttachments(payload.content)) }
          : { ...base, type: 'reply', text: content, ...(payload.phase === 'final_answer' ? { final: true } : {}), ...(model ? { model } : {}) });
      } else if (['function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call'].includes(str(payload.type))) {
        const tool = str(payload.name) || (payload.type === 'local_shell_call' ? 'local_shell' : payload.type === 'web_search_call' ? 'web_search' : 'tool');
        const input = payload.type === 'local_shell_call' ? obj(payload.action) : payload.type === 'web_search_call' ? { query: obj(payload.action).query } : payload.arguments ?? payload.input;
        drafts.push({ role: 'tool', content: `Tool call ${safeLabel(tool, 120)}${payload.call_id ? ` (${safeLabel(payload.call_id, 120)})` : ''}\n${jsonData(input)}`, at: row.timestamp });
        const callId = str(payload.call_id) || str(payload.id) || undefined;
        steps.push({ ...base, type: 'tool.call', tool, ...(callId ? { callId } : {}), ...toolHints(tool, input) });
        // Built-in calls without a separate output record report their status inline.
        if (payload.type === 'web_search_call' && ['completed', 'failed'].includes(str(payload.status))) steps.push({ ...base, pos: `${pos}.result`, type: 'tool.result', tool, ...(callId ? { callId } : {}), ok: payload.status === 'completed' });
      } else if (payload.type === 'reasoning') {
        // v0.0.38: the model reasons (its text and encrypted content are never kept).
        steps.push({ ...base, type: 'status', status: 'thinking' });
      } else if (['function_call_output', 'custom_tool_call_output'].includes(str(payload.type))) {
        drafts.push({ role: 'tool', content: `Tool result${payload.call_id ? ` (${safeLabel(payload.call_id, 120)})` : ''}\n${jsonData(payload.output)}`, at: row.timestamp });
        const output = stepOutput(outputText(payload.output));
        steps.push({ ...base, type: 'tool.result', ...(str(payload.call_id) ? { callId: str(payload.call_id) } : {}), ok: statedSuccess(payload.output) ?? true, ...(output ? { output } : {}) });
      }
    } else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(str(payload.type)) && !matched.has(index)) {
      if (payload.type === 'user_message' && CODEX_INJECTED.test(str(payload.message))) continue;
      drafts.push({ role: payload.type === 'user_message' ? 'user' : 'assistant', content: str(payload.message), at: row.timestamp });
      steps.push(payload.type === 'user_message' ? { ...base, type: 'prompt', text: str(payload.message), ...files(codexEventAttachments(payload)) } : { ...base, type: 'reply', text: str(payload.message), ...(model ? { model } : {}) });
    } else if (row.type === 'event_msg' && (CODEX_FINAL_EVENTS.has(str(payload.type)) || payload.type === 'turn_aborted')) {
      steps.push({ ...base, type: 'turn.end', reason: payload.type === 'turn_aborted' ? 'interrupted' : 'completed' });
    } else {
      // v0.0.38: states Codex records without a message or tool call.
      const status = row.type === 'compacted' || (row.type === 'event_msg' && payload.type === 'context_compacted') ? 'compacting'
          : row.type === 'event_msg' ? CODEX_STATUS_EVENTS[str(payload.type)] : undefined;
      // v0.0.43: an error event says why the turn stopped (usage limit, rate limit, sign-in, …) in its message and `codex_error_info`.
      const reason = status === 'error' ? stopReasonOf(payload.message, payload.codex_error_info) : undefined;
      if (status) steps.push({ ...base, type: 'status', status, ...(reason ? { reason } : {}) });
    }
  }
  const contextUsage = usedTokens !== undefined ? { usedTokens, ...(windowTokens ? { windowTokens } : {}), compactions: Math.max(compactedRows, compactedEvents) } : undefined;
  return finish(context, meta.id, drafts, diagnostics, { path: meta.cwd, start: meta.timestamp, parser: 'codex-rollout', ...(model ? { model } : {}), ...(contextUsage ? { context: contextUsage } : {}) }, steps);
}

/** Claude Code UI echoes of local commands (`/model`, `/clear`, …) written as user rows. */
const CLAUDE_ECHO = /^\s*(?:<local-command-(?:stdout|stderr|caveat)>|Caveat: )/;

/**
 * Claude Code: the first message uuid in a transcript's head (`text` is its first bytes). A continued conversation
 * is a new file that starts with copies of the earlier rows, so the two files share this anchor. Undefined when no
 * row with a uuid is readable there.
 */
export function claudeAnchor(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: RecordValue;
    try { row = obj(JSON.parse(line)); } catch { continue; }
    const uuid = str(row.uuid).trim();
    if (uuid && uuid.length <= 200) return uuid;
  }
  return undefined;
}

/** Claude Code project transcript JSONL; resumed files with branches import the latest branch. */
export function parseClaude(text: string, context: ParseContext): NativeParseResult {
  const diagnostics: string[] = [], rows = records(text, diagnostics);
  if (!rows) return { diagnostics };
  const conversational = rows.filter(row => ['user', 'assistant'].includes(str(row.type)) && Object.keys(obj(row.message)).length);
  const nativeId = context.nativeSessionId || str(conversational.at(-1)?.sessionId);
  if (!nativeId || !conversational.length) return { diagnostics: [...diagnostics, 'Unsupported Claude Code transcript: no conversation identity or messages.'] };
  const selected = conversational.filter(row => !row.sessionId || row.sessionId === nativeId);
  const byId = new Map(rows.filter(row => str(row.uuid)).map(row => [str(row.uuid), row]));
  const childCount = new Map<string, number>();
  for (const row of selected) if (str(row.parentUuid)) childCount.set(str(row.parentUuid), (childCount.get(str(row.parentUuid)) ?? 0) + 1);
  let branch: Set<string> | undefined;
  if ([...childCount.values()].some(count => count > 1) && selected.every(row => str(row.uuid))) {
    branch = new Set();
    let row = selected.at(-1);
    while (row && str(row.uuid) && !branch.has(str(row.uuid))) { branch.add(str(row.uuid)); row = byId.get(str(row.parentUuid)); }
    diagnostics.push('Imported the latest conversation branch.');
  }
  const seen = new Set<string>(), drafts: Draft[] = [], steps = new StepList(), chosen = new Set(selected);
  // The lead's model; a transcript of only sub-agent rows (a subagent file) reports the sub-agent's.
  let customTitle = '', leadModel: string | undefined, leadIsLead = false;
  let usedTokens: number | undefined, compactions = 0;
  for (const row of rows) if (row.type === 'custom-title' && (!row.sessionId || row.sessionId === nativeId) && str(row.customTitle).trim()) customTitle = str(row.customTitle);
  for (const [index, row] of rows.entries()) {
    const pos = `L${index}`, at = stepTime(row.timestamp), base = { pos, ...(at ? { at } : {}), ...(row.isSidechain === true && str(row.agentId) ? { agentId: safeLabel(row.agentId, 120) } : {}) };
    if (!chosen.has(row)) {
      // Claude Code records the end of a turn as a system row in recent versions.
      if (row.type === 'system' && row.subtype === 'turn_duration' && (!row.sessionId || row.sessionId === nativeId)) steps.push({ ...base, type: 'turn.end', reason: 'completed' });
      // v0.0.38: a compaction boundary. `/compact` typed by the user is a finished command; an automatic one happens mid-turn.
      else if (row.type === 'system' && row.subtype === 'compact_boundary' && (!row.sessionId || row.sessionId === nativeId)) {
        compactions++;
        steps.push(str(obj(row.compactMetadata).trigger) === 'manual' ? { ...base, type: 'turn.end', reason: 'completed' } : { ...base, type: 'status', status: 'compacting' });
      }
      continue;
    }
    const uuid = str(row.uuid);
    if (uuid && (seen.has(uuid) || (branch && !branch.has(uuid)) || byId.get(uuid) !== row)) continue;
    if (uuid) seen.add(uuid);
    const message = obj(row.message), role: MessageRole = row.type === 'user' ? 'user' : 'assistant';
    // A failed request's synthetic reply does not finish the turn: its error step right after closes it as failed.
    const final = row.isApiErrorMessage !== true && ['end_turn', 'stop_sequence', 'max_tokens'].includes(str(message.stop_reason));
    const model = str(message.model) && !str(message.model).startsWith('<') ? safeLabel(message.model, 120) : undefined;
    if (model && (row.isSidechain !== true || !leadIsLead)) { leadModel = model; leadIsLead = row.isSidechain !== true; }
    // v0.0.48: the lead's latest request states the context in use (sub-agent rows are their own contexts).
    if (role === 'assistant' && row.isSidechain !== true) usedTokens = claudePromptTokens(message.usage) ?? usedTokens;
    const said = (text: string, sub: string) => {
      if (role === 'assistant') { steps.push({ ...base, pos: `${pos}${sub}`, type: 'reply', text, ...(final ? { final } : {}), ...(model ? { model } : {}) }); return; }
      // Meta rows, the compaction summary and local command echoes are not prompts the user typed.
      if (row.isMeta === true || row.isCompactSummary === true || CLAUDE_ECHO.test(text)) return;
      if (/^\s*\[Request interrupted by user/.test(text)) steps.push({ ...base, pos: `${pos}${sub}`, type: 'turn.end', reason: 'interrupted' });
      else steps.push({ ...base, pos: `${pos}${sub}`, type: 'prompt', text });
    };
    const firstStep = steps.steps.length;
    if (typeof message.content === 'string') { drafts.push({ role, content: message.content, at: row.timestamp }); said(message.content, ''); }
    else for (const [k, raw] of list(message.content).entries()) {
      const block = obj(raw);
      if (block.type === 'text') { drafts.push({ role, content: str(block.text), at: row.timestamp }); said(str(block.text), `.${k}`); }
      // v0.0.38: the model reasons (the reasoning text itself is never kept).
      else if (role === 'assistant' && (block.type === 'thinking' || block.type === 'redacted_thinking')) steps.push({ ...base, pos: `${pos}.${k}`, type: 'status', status: 'thinking' });
      else if (block.type === 'tool_use') {
        drafts.push({ role: 'tool', content: `Tool call ${safeLabel(block.name, 120)} (${safeLabel(block.id, 120)})\n${jsonData(block.input)}`, at: row.timestamp });
        steps.push({ ...base, pos: `${pos}.${k}`, type: 'tool.call', tool: str(block.name) || 'tool', ...(str(block.id) ? { callId: str(block.id) } : {}), ...toolHints(str(block.name), block.input) });
      } else if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : partsText(block.content);
        drafts.push({ role: 'tool', content: `Tool result (${safeLabel(block.tool_use_id, 120)})\n${content}`, at: row.timestamp });
        const output = stepOutput(content);
        steps.push({ ...base, pos: `${pos}.${k}`, type: 'tool.result', ...(str(block.tool_use_id) ? { callId: str(block.tool_use_id) } : {}), ok: block.is_error !== true, ...(output ? { output } : {}) });
      }
    }
    // Images and documents the user attached are blocks of the same row: they belong to its prompt.
    if (role === 'user' && row.isMeta !== true && row.isCompactSummary !== true) {
      const attached = promptAttachments(message.content);
      if (attached.length) {
        const prompt = steps.steps.slice(firstStep).reverse().find((step): step is Extract<TranscriptStep, { type: 'prompt' }> => step.type === 'prompt');
        if (prompt) prompt.attachments = attached;
        else steps.push({ ...base, pos: `${pos}.files`, type: 'prompt', text: '', attachments: attached });
      }
    }
    // v0.0.38: Claude Code writes a failed model request as a synthetic assistant row.
    // v0.0.43: its text and `error` code say why (session or usage limit, credit, sign-in, overload, …).
    if (role === 'assistant' && row.isApiErrorMessage === true) {
      const reason = stopReasonOf(typeof message.content === 'string' ? message.content : partsText(message.content), row.error);
      steps.push({ ...base, pos: `${pos}.error`, type: 'status', status: 'error', ...(reason ? { reason } : {}) });
    }
  }
  const contextUsage = usedTokens !== undefined ? { usedTokens, compactions } : undefined;
  return finish(context, nativeId, drafts, diagnostics, { path: selected[0]?.cwd, start: selected[0]?.timestamp, customTitle, parser: 'claude-jsonl', ...(leadModel ? { model: leadModel } : {}), ...(contextUsage ? { context: contextUsage } : {}) }, steps);
}

/** Gemini CLI recordings: legacy ConversationRecord JSON and the JSONL format with patches and rewinds. */
function geminiConversation(text: string, diagnostics: string[]): RecordValue | undefined {
  if (text.length > MAX_PARSER_INPUT) { diagnostics.push('The history file exceeds the 16 MiB parser limit.'); return undefined; }
  try { const record = obj(JSON.parse(text)); if (str(record.sessionId) && str(record.projectHash) && Array.isArray(record.messages)) return record; } catch { /* JSONL */ }
  const rows = records(text, diagnostics);
  if (!rows) return undefined;
  let metadata: RecordValue = {};
  const messages = new Map<string, RecordValue>();
  const add = (values: unknown) => { for (const raw of list(values)) { const row = obj(raw); if (str(row.id)) messages.set(str(row.id), row); } };
  const patch = (value: unknown) => {
    const update = obj(value), original = messages.get(str(update.id));
    if (!original) return;
    if (update.content !== undefined) original.content = update.content;
    for (const raw of list(update.toolCalls)) {
      const toolPatch = obj(raw), call = list(original.toolCalls).map(obj).find(tool => tool.id === toolPatch.id);
      if (call && toolPatch.result !== undefined) call.result = toolPatch.result;
    }
  };
  for (const row of rows) {
    if (typeof row.$rewindTo === 'string') {
      const keys = [...messages.keys()], index = keys.indexOf(row.$rewindTo);
      for (const id of index < 0 ? keys : keys.slice(index)) messages.delete(id);
    } else if (row.$patch) {
      const update = obj(row.$patch);
      patch(update);
      list(update.updates).forEach(patch);
      for (const id of list(update.removeIds)) messages.delete(str(id));
      if (Array.isArray(update.orderIds)) {
        const reordered = new Map<string, RecordValue>(), order = update.orderIds.filter((id): id is string => typeof id === 'string');
        for (const [id, message] of messages) if (!order.includes(id)) reordered.set(id, message);
        for (const id of order) { const message = messages.get(id); if (message) reordered.set(id, message); }
        messages.clear();
        for (const [id, message] of reordered) messages.set(id, message);
      }
    } else if (row.$set) {
      const update = obj(row.$set);
      for (const key of ['sessionId', 'projectHash', 'startTime', 'lastUpdated', 'summary', 'directories']) if (update[key] !== undefined) metadata[key] = update[key];
      if (Array.isArray(update.messages)) { messages.clear(); add(update.messages); }
    } else if (str(row.sessionId) && str(row.projectHash)) { metadata = { ...metadata, ...row }; add(row.messages); }
    else if (str(row.id) && str(row.type)) messages.set(str(row.id), row);
  }
  return str(metadata.sessionId) && str(metadata.projectHash) ? { ...metadata, messages: [...messages.values()] } : undefined;
}

export function parseGemini(text: string, context: ParseContext): NativeParseResult {
  const diagnostics: string[] = [], record = geminiConversation(text, diagnostics);
  if (!record) return { diagnostics: [...diagnostics, 'Unsupported Gemini recording or missing conversation metadata.'] };
  const drafts: Draft[] = [], steps = new StepList();
  let model: string | undefined;
  for (const [index, raw] of list(record.messages).entries()) {
    const message = obj(raw);
    if (message.type === 'error') {
      const at = stepTime(message.timestamp), reason = stopReasonOf(partsText(message.content));
      steps.push({ pos: `G:${str(message.id) || index}`, ...(at ? { at } : {}), type: 'status', status: 'error', ...(reason ? { reason } : {}) });
      continue;
    }
    if (!['user', 'gemini'].includes(str(message.type))) continue;
    const content = partsText(message.content), pos = `G:${str(message.id) || index}`, at = stepTime(message.timestamp);
    const calls = list(message.toolCalls).map(obj).filter(call => str(call.name));
    drafts.push({ role: message.type === 'user' ? 'user' : 'assistant', content, at: message.timestamp });
    if (message.type === 'gemini' && str(message.model)) model = safeLabel(message.model, 120);
    // v0.0.38: reasoning before a reply (its text is never kept).
    if (message.type === 'gemini' && list(message.thoughts).length) steps.push({ pos: `${pos}:t`, ...(at ? { at } : {}), type: 'status', status: 'thinking' });
    steps.push(message.type === 'user' ? { pos, ...(at ? { at } : {}), type: 'prompt', text: content, ...files(promptAttachments(message.content)) }
      : { pos, ...(at ? { at } : {}), type: 'reply', text: content, ...(calls.length ? {} : { final: true }), ...(str(message.model) ? { model: safeLabel(message.model, 120) } : {}) });
    for (const [k, call] of calls.entries()) {
      const callAt = stepTime(call.timestamp) ?? at, base = { ...(callAt ? { at: callAt } : {}), ...(str(call.id) ? { callId: str(call.id) } : {}) };
      drafts.push({ role: 'tool', content: `Tool call ${safeLabel(call.name, 120)} (${safeLabel(call.id, 120)})\n${jsonData(call.args)}`, at: call.timestamp ?? message.timestamp });
      steps.push({ ...base, pos: `${pos}:c${k}`, type: 'tool.call', tool: str(call.name), ...toolHints(str(call.name), call.args) });
      if (call.result !== undefined && call.result !== null) {
        drafts.push({ role: 'tool', content: `Tool result (${safeLabel(call.id, 120)})\n${jsonData(call.result)}`, at: call.timestamp ?? message.timestamp });
        const response = obj(obj(obj(list(call.result)[0]).functionResponse).response);
        const output = stepOutput(str(call.resultDisplay) || response.output || response.error);
        steps.push({ ...base, pos: `${pos}:r${k}`, type: 'tool.result', tool: str(call.name), ok: !['error', 'cancelled'].includes(str(call.status)) && response.error === undefined, ...(output ? { output } : {}) });
      }
    }
  }
  return finish(context, record.sessionId, drafts, diagnostics, { start: record.startTime, title: record.summary, parser: 'gemini-recording', ...(model ? { model } : {}) }, steps);
}

/** Hermes Agent state.db rows (sessions + messages), read by the host with a read-only connection. */
export function parseHermes(sessionRow: unknown, messages: unknown[], context: ParseContext): NativeParseResult {
  const diagnostics: string[] = [], session = obj(sessionRow), drafts: Draft[] = [], steps = new StepList();
  const sessionId = session.id ?? session.session_id;
  if (!str(sessionId) || !Array.isArray(messages)) return { diagnostics: ['Unsupported Hermes conversation.'] };
  if (messages.length > MAX_MESSAGES) return { diagnostics: ['The Hermes conversation exceeds the import message limit.'] };
  for (const [index, raw] of messages.entries()) {
    const message = obj(raw);
    if (message.active === 0 || message.active === false || (message.session_id && message.session_id !== sessionId) || !['user', 'assistant', 'tool'].includes(str(message.role))) continue;
    let content = message.content;
    // Hermes marks structured content with this prefix; ordinary JSON-looking prose stays prose.
    if (typeof content === 'string' && content.startsWith('\u0000json:')) {
      try { content = JSON.parse(content.slice('\u0000json:'.length)); } catch { diagnostics.push('Malformed multimodal content was skipped.'); content = ''; }
    }
    const text = typeof content === 'string' ? content : partsText(content);
    drafts.push({ role: message.role as MessageRole, content: text, at: message.timestamp });
    let calls: unknown = message.tool_calls;
    if (typeof calls === 'string') { try { calls = JSON.parse(calls); } catch { diagnostics.push('Malformed tool metadata was skipped.'); calls = []; } }
    const pos = `H:${typeof message.id === 'number' || typeof message.id === 'string' ? String(message.id) : `i${index}`}`, at = stepTime(message.timestamp);
    const base = { ...(at ? { at } : {}) };
    const named = list(calls).map(obj).filter(call => str(obj(call.function).name || call.name));
    if (message.role === 'user') steps.push({ ...base, pos, type: 'prompt', text, ...files(promptAttachments(content)) });
    else if (message.role === 'assistant') steps.push({ ...base, pos, type: 'reply', text, ...(named.length ? {} : { final: true }) });
    else {
      const output = stepOutput(text);
      steps.push({ ...base, pos, type: 'tool.result', ...(str(message.tool_call_id) ? { callId: str(message.tool_call_id) } : {}), ...(str(message.tool_name) ? { tool: str(message.tool_name) } : {}), ok: statedSuccess(text) ?? true, ...(output ? { output } : {}) });
    }
    if (message.role === 'assistant') for (const [k, call] of named.entries()) {
      const fn = obj(call.function), name = str(fn.name || call.name);
      drafts.push({ role: 'tool', content: `Tool call ${safeLabel(name, 120)} (${safeLabel(call.id, 120)})\n${jsonData(fn.arguments ?? call.arguments)}`, at: message.timestamp });
      steps.push({ ...base, pos: `${pos}:c${k}`, type: 'tool.call', tool: name, ...(str(call.id) ? { callId: str(call.id) } : {}), ...toolHints(name, fn.arguments ?? call.arguments) });
    }
  }
  return finish(context, sessionId, drafts, diagnostics, { path: session.git_repo_root || session.cwd || session.project_path, title: session.title, start: session.started_at ?? session.created_at, parser: 'hermes-sqlite' }, steps);
}

/** Extract the user's request text from Antigravity `<USER_REQUEST>…</USER_REQUEST>` wrappers. */
function antigravityUserText(raw: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  if (match) return match[1]!.trim();
  return raw.replace(/<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|CONTEXT_SUMMARY)>/gi, '').trim();
}

/**
 * Files the user attached to an Antigravity prompt: `media: [{ mime_type, uri }]`, where `uri` is a local
 * file (`brain/<id>/.user_uploaded/…`). Images get their contents through `readMedia`; others are named only.
 */
function antigravityMedia(media: unknown, readMedia: ParseContext['readMedia']): StepAttachment[] {
  const out: StepAttachment[] = [];
  for (const raw of list(media)) {
    if (out.length >= MAX_STEP_ATTACHMENTS) break;
    const item = obj(raw), uri = str(item.uri ?? item.path), mimeType = str(item.mime_type ?? item.mimeType).toLowerCase();
    if (!uri) continue;
    const name = safeLabel(uri.split(/[\\/]/).pop() ?? '', 200) || `file-${out.length + 1}`;
    if (mimeType.startsWith('image/')) {
      let base64: string | undefined;
      try { base64 = readMedia?.(uri); } catch { base64 = undefined; }
      out.push(imageAttachment({ name, mimeType, ...(base64 ? { base64 } : {}) }, out.length));
    } else out.push({ name, kind: mimeType.startsWith('text/') ? 'text' : 'file', size: 0, ...(mimeType ? { mimeType } : {}) });
  }
  return out;
}

/** Extract model name from Antigravity `<USER_SETTINGS_CHANGE>` blocks when present. */
function antigravityModelFromSettings(raw: string): string | undefined {
  const match = /Model Selection:\s*(?:changed from .*? to |set to )([^\r\n<]+)/i.exec(raw);
  const name = match?.[1]?.trim();
  return name && !/^(?:none|auto)$/i.test(name) ? safeLabel(name, 120) : undefined;
}

/** Unwrap JSON-quoted strings in Antigravity tool call args (`"\"/path\""` -> `"/path"`). */
function unquoteArg(value: unknown): string {
  const text = str(value).trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    try { const parsed = JSON.parse(text); if (typeof parsed === 'string') return parsed.trim(); } catch { /* keep raw */ }
  }
  return text;
}

/** Antigravity brain transcript JSONL (`~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`). */
export function parseAntigravity(text: string, context: ParseContext): NativeParseResult {
  const diagnostics: string[] = [], rows = records(text, diagnostics);
  if (!rows) return { diagnostics };
  const valid = rows.filter(row => typeof row.type === 'string' && (typeof row.step_index === 'number' || typeof row.source === 'string' || typeof row.created_at === 'string'));
  if (!valid.length) return { diagnostics: [...diagnostics, 'Unsupported Antigravity transcript: no step records were found.'] };
  const drafts: Draft[] = [], steps = new StepList();
  let model: string | undefined, projectPath = context.projectPath, startAt: unknown;
  let pendingCalls: { callId: string; tool: string }[] = [];

  for (const [index, row] of rows.entries()) {
    const stepIdx = typeof row.step_index === 'number' ? row.step_index : index;
    const pos = `A:${stepIdx}:${index}`, at = stepTime(row.created_at ?? row.timestamp);
    if (startAt === undefined && (row.created_at ?? row.timestamp)) startAt = row.created_at ?? row.timestamp;
    const base = { pos, ...(at ? { at } : {}) };
    const type = str(row.type);
    const rawContent = Array.isArray(row.content)
      ? row.content.map(item => str(item)).filter(Boolean).join('\n')
      : str(row.content);
    const rowModel = safeLabel(str(row.model ?? row.modelName), 120);
    if (rowModel && !/^(?:none|auto)$/i.test(rowModel)) model = rowModel;

    if (type === 'USER_INPUT') {
      pendingCalls = [];
      const settingsModel = antigravityModelFromSettings(rawContent);
      if (settingsModel) model = settingsModel;
      const prompt = antigravityUserText(rawContent);
      if (isInjectedContext(prompt)) continue;
      const attached = antigravityMedia(row.media, context.readMedia);
      if (!prompt && !attached.length) continue;
      if (prompt) drafts.push({ role: 'user', content: prompt, at: row.created_at ?? row.timestamp });
      steps.push({ ...base, type: 'prompt', text: prompt, ...files(attached) });
    } else if (type === 'PLANNER_RESPONSE') {
      pendingCalls = [];
      const calls = list(row.tool_calls).map(obj).filter(call => str(call.name));
      if (str(row.thinking).trim()) steps.push({ ...base, pos: `${pos}:t`, type: 'status', status: 'thinking' });
      if (rawContent.trim()) {
        drafts.push({ role: 'assistant', content: rawContent, at: row.created_at ?? row.timestamp });
        steps.push({ ...base, type: 'reply', text: rawContent, ...(calls.length ? {} : { final: true }), ...(model ? { model } : {}) });
      }
      for (const [k, call] of calls.entries()) {
        const rawTool = str(call.name).replace(/^default_api:/, '');
        let rawArgs = call.args ?? call.arguments;
        if (typeof rawArgs === 'string') {
          try { rawArgs = JSON.parse(rawArgs); } catch { /* keep string */ }
        }
        const args = obj(rawArgs), callId = str(call.id) || `step-${stepIdx}-${k}`;
        if (!projectPath) {
          const cwd = unquoteArg(args.Cwd ?? args.cwd ?? args.DirectoryPath ?? args.SearchPath);
          if (/^(?:\/|[A-Za-z]:[\\/])/.test(cwd)) projectPath = cwd;
          else {
            const fileTarget = unquoteArg(args.AbsolutePath ?? args.TargetFile);
            const dirMatch = /^(\/projects\/[^/]+|\/Users\/[^/]+\/[^/]+)/.exec(fileTarget);
            if (dirMatch) projectPath = dirMatch[1]!;
          }
        }
        drafts.push({ role: 'tool', content: `Tool call ${safeLabel(rawTool, 120)} (${safeLabel(callId, 120)})\n${jsonData(args)}`, at: row.created_at ?? row.timestamp });
        steps.push({ ...base, pos: `${pos}:c${k}`, type: 'tool.call', tool: rawTool, callId, ...toolHints(rawTool, args) });
        pendingCalls.push({ callId, tool: rawTool });
      }
      if (row.status === 'ERROR') {
        const reason = stopReasonOf(rawContent, row.error);
        steps.push({ ...base, pos: `${pos}:err`, type: 'status', status: 'error', ...(reason ? { reason } : {}) });
      }
    } else if ((type === 'GENERIC' || type === 'TOOL_RESPONSE') && pendingCalls.length) {
      const items = Array.isArray(row.content) ? row.content.map(item => str(item)) : [rawContent];
      for (const [rIdx, itemText] of items.entries()) {
        const call = pendingCalls.shift();
        if (!call) break;
        const ok = row.status !== 'ERROR' && (statedSuccess(itemText) ?? true);
        drafts.push({ role: 'tool', content: `Tool result (${safeLabel(call.callId, 120)})\n${itemText}`, at: row.created_at ?? row.timestamp });
        const output = stepOutput(outputText(itemText));
        steps.push({ ...base, pos: `${pos}:r${rIdx}`, type: 'tool.result', callId: call.callId, tool: call.tool, ok, ...(output ? { output } : {}) });
      }
    }
  }
  const sessionId = context.nativeSessionId || str(rows[0]?.conversation_id ?? rows[0]?.session_id) || 'antigravity-session';
  return finish(context, sessionId, drafts, diagnostics, { path: projectPath, start: startAt, parser: 'antigravity-jsonl', ...(model ? { model } : {}) }, steps);
}

