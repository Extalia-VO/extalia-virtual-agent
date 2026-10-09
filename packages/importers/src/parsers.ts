import {
  PORTABLE_SESSION_FORMAT, decodePortableSession, safeLabel, safeText,
  type ImportMode, type MessageRole, type PortableSession,
} from '@extalia/core';

/**
 * Parsers for native agent histories. Input is untrusted data: parsers have no
 * file access or side effects, never execute anything, drop reasoning fields,
 * mask credentials, and produce validated Extalia portable sessions.
 */
export type NativeSourceId = 'codex' | 'claude-code' | 'hermes' | 'gemini-cli';

export interface ParseContext {
  sourceId: NativeSourceId;
  /** Hermes profile; named profiles get their own session identities. */
  profile?: string;
  nativeSessionId?: string;
  projectPath?: string;
  title?: string;
  exportedAt?: string;
  importMode?: ImportMode;
}

export interface NativeParseResult {
  session?: PortableSession;
  diagnostics: string[];
}

type RecordValue = Record<string, unknown>;
type Draft = { role: MessageRole; content: string; at?: unknown };

export const MAX_PARSER_INPUT = 16 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_MESSAGES = 10_000;
const MESSAGE_LIMIT = 50_000;
const PROVIDERS: Record<NativeSourceId, string | undefined> = { codex: 'openai', 'claude-code': 'anthropic', hermes: undefined, 'gemini-cli': 'google' };

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

function finish(context: ParseContext, id: unknown, drafts: Draft[], diagnostics: string[], metadata: { path?: unknown; title?: unknown; start?: unknown; parser: string }): NativeParseResult {
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
  const firstUser = messages.find(message => message.role === 'user')?.content;
  const exportedAt = new Date(toEpochMs(context.exportedAt) ?? Date.now()).toISOString();
  const provider = PROVIDERS[context.sourceId];
  const session: PortableSession = {
    format: PORTABLE_SESSION_FORMAT,
    title: safeLabel(context.title || str(metadata.title) || firstUser || `${context.sourceId} conversation`, 160),
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
  return decoded.ok ? { session: decoded.value, diagnostics } : { diagnostics: [...diagnostics, `The conversation failed validation: ${decoded.errors.join(' ')}`] };
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
    if (row.type !== 'event_msg' || !['user_message', 'agent_message'].includes(str(payload.type))) continue;
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
    if (!content) continue;
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
  const drafts: Draft[] = [];
  for (const [index, row] of rows.entries()) {
    const payload = obj(row.payload);
    if (row.type === 'response_item') {
      if (payload.type === 'message' && ['user', 'assistant'].includes(str(payload.role)) && payload.channel !== 'analysis') drafts.push({ role: payload.role as MessageRole, content: partsText(payload.content), at: row.timestamp });
      else if (['function_call', 'custom_tool_call'].includes(str(payload.type))) drafts.push({ role: 'tool', content: `Tool call ${safeLabel(payload.name, 120)}${payload.call_id ? ` (${safeLabel(payload.call_id, 120)})` : ''}\n${jsonData(payload.arguments ?? payload.input)}`, at: row.timestamp });
      else if (['function_call_output', 'custom_tool_call_output'].includes(str(payload.type))) drafts.push({ role: 'tool', content: `Tool result${payload.call_id ? ` (${safeLabel(payload.call_id, 120)})` : ''}\n${jsonData(payload.output)}`, at: row.timestamp });
    } else if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(str(payload.type)) && !matched.has(index)) {
      drafts.push({ role: payload.type === 'user_message' ? 'user' : 'assistant', content: str(payload.message), at: row.timestamp });
    }
  }
  return finish(context, meta.id, drafts, diagnostics, { path: meta.cwd, start: meta.timestamp, parser: 'codex-rollout' });
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
  const seen = new Set<string>(), drafts: Draft[] = [];
  for (const row of selected) {
    const uuid = str(row.uuid);
    if (uuid && (seen.has(uuid) || (branch && !branch.has(uuid)) || byId.get(uuid) !== row)) continue;
    if (uuid) seen.add(uuid);
    const message = obj(row.message), role: MessageRole = row.type === 'user' ? 'user' : 'assistant';
    if (typeof message.content === 'string') drafts.push({ role, content: message.content, at: row.timestamp });
    else for (const raw of list(message.content)) {
      const block = obj(raw);
      if (block.type === 'text') drafts.push({ role, content: str(block.text), at: row.timestamp });
      else if (block.type === 'tool_use') drafts.push({ role: 'tool', content: `Tool call ${safeLabel(block.name, 120)} (${safeLabel(block.id, 120)})\n${jsonData(block.input)}`, at: row.timestamp });
      else if (block.type === 'tool_result') drafts.push({ role: 'tool', content: `Tool result (${safeLabel(block.tool_use_id, 120)})\n${typeof block.content === 'string' ? block.content : partsText(block.content)}`, at: row.timestamp });
    }
  }
  return finish(context, nativeId, drafts, diagnostics, { path: selected[0]?.cwd, start: selected[0]?.timestamp, parser: 'claude-jsonl' });
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
  const drafts: Draft[] = [];
  for (const raw of list(record.messages)) {
    const message = obj(raw);
    if (!['user', 'gemini'].includes(str(message.type))) continue;
    drafts.push({ role: message.type === 'user' ? 'user' : 'assistant', content: partsText(message.content), at: message.timestamp });
    for (const rawCall of list(message.toolCalls)) {
      const call = obj(rawCall);
      if (!str(call.name)) continue;
      drafts.push({ role: 'tool', content: `Tool call ${safeLabel(call.name, 120)} (${safeLabel(call.id, 120)})\n${jsonData(call.args)}`, at: call.timestamp ?? message.timestamp });
      if (call.result !== undefined && call.result !== null) drafts.push({ role: 'tool', content: `Tool result (${safeLabel(call.id, 120)})\n${jsonData(call.result)}`, at: call.timestamp ?? message.timestamp });
    }
  }
  return finish(context, record.sessionId, drafts, diagnostics, { start: record.startTime, title: record.summary, parser: 'gemini-recording' });
}

/** Hermes Agent state.db rows (sessions + messages), read by the host with a read-only connection. */
export function parseHermes(sessionRow: unknown, messages: unknown[], context: ParseContext): NativeParseResult {
  const diagnostics: string[] = [], session = obj(sessionRow), drafts: Draft[] = [];
  const sessionId = session.id ?? session.session_id;
  if (!str(sessionId) || !Array.isArray(messages)) return { diagnostics: ['Unsupported Hermes conversation.'] };
  if (messages.length > MAX_MESSAGES) return { diagnostics: ['The Hermes conversation exceeds the import message limit.'] };
  for (const raw of messages) {
    const message = obj(raw);
    if (message.active === 0 || message.active === false || (message.session_id && message.session_id !== sessionId) || !['user', 'assistant', 'tool'].includes(str(message.role))) continue;
    let content = message.content;
    // Hermes marks structured content with this prefix; ordinary JSON-looking prose stays prose.
    if (typeof content === 'string' && content.startsWith('\u0000json:')) {
      try { content = JSON.parse(content.slice('\u0000json:'.length)); } catch { diagnostics.push('Malformed multimodal content was skipped.'); content = ''; }
    }
    drafts.push({ role: message.role as MessageRole, content: typeof content === 'string' ? content : partsText(content), at: message.timestamp });
    let calls: unknown = message.tool_calls;
    if (typeof calls === 'string') { try { calls = JSON.parse(calls); } catch { diagnostics.push('Malformed tool metadata was skipped.'); calls = []; } }
    if (message.role === 'assistant') for (const rawCall of list(calls)) {
      const call = obj(rawCall), fn = obj(call.function);
      if (!str(fn.name || call.name)) continue;
      drafts.push({ role: 'tool', content: `Tool call ${safeLabel(fn.name || call.name, 120)} (${safeLabel(call.id, 120)})\n${jsonData(fn.arguments ?? call.arguments)}`, at: message.timestamp });
    }
  }
  return finish(context, sessionId, drafts, diagnostics, { path: session.git_repo_root || session.cwd || session.project_path, title: session.title, start: session.started_at ?? session.created_at, parser: 'hermes-sqlite' });
}
