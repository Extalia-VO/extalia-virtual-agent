import { ConnectError, quoteArgument } from './util.js';

/**
 * Claude Code hooks in the user-level `settings.json` (never project or managed files).
 *
 * HTTP hooks carry most events; `SessionStart` does not fire HTTP hooks, so it
 * uses the forwarder as a command hook. Entries are marked by what they are:
 * an HTTP hook to `/api/hooks/claude` on loopback, or a command that runs
 * `forward.mjs claude`. Nothing else in the file is touched.
 */

export const CLAUDE_HTTP_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd',
] as const;
export const CLAUDE_COMMAND_EVENTS = ['SessionStart'] as const;
export const CLAUDE_EVENTS: readonly string[] = [CLAUDE_COMMAND_EVENTS[0], ...CLAUDE_HTTP_EVENTS];

export const CLAUDE_HOOK_PATH = '/api/hooks/claude';

export interface ClaudeDesired {
  /** `undefined` accepts whatever port the existing HTTP hooks use (inspection only). */
  port: number | undefined;
  token: string;
  /** The forwarder command for `SessionStart`, as it should appear in the file. */
  command: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function claudeCommand(nodePath: string, forwarderPath: string, platform: string): string {
  return `${quoteArgument(nodePath, platform)} ${quoteArgument(forwarderPath, platform)} claude`;
}

function desiredHook(event: string, desired: ClaudeDesired, existing?: unknown): Json {
  if (event === 'SessionStart') return { type: 'command', command: desired.command, timeout: 5 };
  let port = desired.port;
  if (port === undefined) {
    try { port = Number(new URL(String((existing as Json | undefined)?.url)).port) || undefined; } catch { /* keep undefined */ }
  }
  return { type: 'http', url: `http://127.0.0.1:${port ?? 0}${CLAUDE_HOOK_PATH}`, headers: { Authorization: `Bearer ${desired.token}` }, timeout: 2 };
}

/** Whether a hook entry was added by Extalia. */
export function isExtaliaClaudeHook(hook: unknown): boolean {
  if (!isObject(hook)) return false;
  if (hook.type === 'http' && typeof hook.url === 'string') {
    try {
      const url = new URL(hook.url);
      return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === CLAUDE_HOOK_PATH;
    } catch { return false; }
  }
  return hook.type === 'command' && typeof hook.command === 'string' && /forward\.mjs['"]?\s+claude\s*$/.test(hook.command);
}

function parseSettings(text: string | undefined, file: string): Json {
  if (text === undefined || !text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new ConnectError(`${file} is not valid JSON (${error instanceof Error ? error.message : 'parse error'}). Extalia left it unchanged; fix the file or add the hooks by hand.`); }
  if (!isObject(value)) throw new ConnectError(`${file} must contain a JSON object. Extalia left it unchanged.`);
  return value;
}

export interface JsonStyle { indent: string | number; newline: '\n' | '\r\n'; trailingNewline: boolean }

/** Indentation and line ending of an existing file, so a rewrite keeps its look. */
export function detectJsonStyle(text: string | undefined): JsonStyle {
  if (!text) return { indent: 2, newline: '\n', trailingNewline: true };
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const match = /\n([ \t]+)\S/.exec(text);
  const indent: string | number = match ? (match[1] as string).startsWith('\t') ? '\t' : (match[1] as string).length : 2;
  return { indent, newline, trailingNewline: text.endsWith('\n') };
}

/** Whether writing the parsed file back changes its layout (indentation, compact lists). */
export function wouldReformat(text: string): boolean {
  try { return serializeJson(JSON.parse(text), detectJsonStyle(text)) !== text; } catch { return false; }
}

export function serializeJson(value: unknown, style: JsonStyle): string {
  let text = JSON.stringify(value, null, style.indent);
  if (style.newline === '\r\n') text = text.replace(/\n/g, '\r\n');
  return style.trailingNewline ? text + style.newline : text;
}

function hooksOf(settings: Json, create: boolean): Json | undefined {
  const hooks = settings.hooks;
  if (isObject(hooks)) return hooks;
  if (hooks !== undefined) throw new ConnectError('The "hooks" entry of the Claude Code settings is not an object. Extalia left the file unchanged.');
  if (!create) return undefined;
  const created: Json = {};
  settings.hooks = created;
  return created;
}

/** The forwarder command and the HTTP port of the entries already in the file, if any. */
export function existingClaudeEntries(text: string | undefined, file: string): { command?: string; port?: number } {
  const hooks = hooksOf(parseSettings(text, file), false) ?? {};
  const found: { command?: string; port?: number } = {};
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
      if (!isExtaliaClaudeHook(hook)) continue;
      const entry = hook as Json;
      if (entry.type === 'command' && typeof entry.command === 'string') found.command ??= entry.command;
      else if (typeof entry.url === 'string') { const port = Number(new URL(entry.url).port); if (port) found.port ??= port; }
    }
  }
  return found;
}

export interface ClaudeInspection {
  /** Events with an Extalia entry that matches the desired one exactly. */
  current: string[];
  /** Events with an Extalia entry that differs (port, token, Node path). */
  stale: string[];
  /** Events with no Extalia entry. */
  missing: string[];
  /** Hook entries in the file that are not Extalia's. */
  userHookCount: number;
  disableAllHooks: boolean;
  allowManagedHooksOnly: boolean;
}

export function inspectClaudeSettings(text: string | undefined, file: string, desired: ClaudeDesired): ClaudeInspection {
  const settings = parseSettings(text, file);
  const hooks = hooksOf(settings, false) ?? {};
  const result: ClaudeInspection = { current: [], stale: [], missing: [], userHookCount: 0, disableAllHooks: settings.disableAllHooks === true, allowManagedHooksOnly: settings.allowManagedHooksOnly === true };
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) if (!isExtaliaClaudeHook(hook)) result.userHookCount++;
  }
  for (const event of CLAUDE_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = groups.flatMap(group => (isObject(group) && Array.isArray(group.hooks) ? group.hooks : [])).filter(isExtaliaClaudeHook);
    if (!ours.length) result.missing.push(event);
    else if (ours.length === 1 && JSON.stringify(ours[0]) === JSON.stringify(desiredHook(event, desired, ours[0]))) result.current.push(event);
    else result.stale.push(event);
  }
  return result;
}

export interface ClaudePlan { after: string; changed: boolean; events: string[] }

/** Add or update Extalia's hook groups, keeping everything else (content and key order). */
export function planClaudeSettings(text: string | undefined, file: string, desired: ClaudeDesired): ClaudePlan {
  const settings = parseSettings(text, file);
  const hooks = hooksOf(settings, true) as Json;
  const events: string[] = [];

  for (const event of CLAUDE_EVENTS) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) throw new ConnectError(`The "${event}" hooks in the Claude Code settings are not a list. Extalia left the file unchanged.`);
    const groups = (existing ?? []) as unknown[];
    let found = false, touched = false;
    const kept: unknown[] = [];
    const hookFor = (current?: unknown) => desiredHook(event, desired, current);
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isExtaliaClaudeHook)) { kept.push(group); continue; }
      const entries: unknown[] = [];
      for (const entry of group.hooks) {
        if (!isExtaliaClaudeHook(entry)) { entries.push(entry); continue; }
        if (found) { touched = true; continue; } // a duplicate from an earlier version
        found = true;
        if (JSON.stringify(entry) !== JSON.stringify(hookFor(entry))) { entries.push(hookFor(entry)); touched = true; } else entries.push(entry);
      }
      if (entries.length) { group.hooks = entries; kept.push(group); }
    }
    if (!found) { kept.push({ matcher: '*', hooks: [hookFor()] }); touched = true; }
    if (touched) { hooks[event] = kept; events.push(event); }
  }

  const style = detectJsonStyle(text);
  const after = serializeJson(settings, style);
  return { after, changed: after !== text, events };
}

/** Remove every Extalia entry (and groups or lists left empty by that). Returns the new text and the number removed. */
export function removeClaudeEntries(text: string, file: string): { after: string; removed: number } {
  const settings = parseSettings(text, file);
  const hooks = hooksOf(settings, false);
  let removed = 0;
  if (hooks) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept: unknown[] = [];
      let eventRemoved = 0;
      for (const group of groups) {
        if (!isObject(group) || !Array.isArray(group.hooks)) { kept.push(group); continue; }
        const remaining = group.hooks.filter(hook => !isExtaliaClaudeHook(hook));
        const count = group.hooks.length - remaining.length;
        eventRemoved += count;
        if (!count) kept.push(group);
        else if (remaining.length) { group.hooks = remaining; kept.push(group); }
      }
      removed += eventRemoved;
      if (!eventRemoved) continue;
      if (kept.length) hooks[event] = kept;
      else delete hooks[event];
    }
    if (!Object.keys(hooks).length && removed) delete settings.hooks;
  }
  return { after: removed ? serializeJson(settings, detectJsonStyle(text)) : text, removed };
}
