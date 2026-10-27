import { detectJsonStyle, serializeJson, type JsonStyle } from './claude.js';
import { ConnectError, quoteArgument } from './util.js';

/**
 * Gemini CLI command hooks in `~/.gemini/settings.json` (user level only).
 *
 * Gemini CLI invokes command hooks with a JSON payload on stdin and a timeout
 * in milliseconds (`2000`). Entries added by Extalia are identified by their
 * forwarder command (`forward.mjs gemini`); user hooks and unrelated settings
 * are preserved unchanged.
 */

export const GEMINI_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'BeforeAgent',
  'AfterAgent',
  'BeforeTool',
  'AfterTool',
  'Notification',
] as const;

export const GEMINI_HOOK_TIMEOUT_MS = 2000;

export interface GeminiDesired {
  /** The forwarder command as it should appear in `~/.gemini/settings.json`. */
  command: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function geminiCommand(nodePath: string, forwarderPath: string, platform: string): string {
  return `${quoteArgument(nodePath, platform)} ${quoteArgument(forwarderPath, platform)} gemini`;
}

function desiredHook(desired: GeminiDesired): Json {
  return { type: 'command', command: desired.command, timeout: GEMINI_HOOK_TIMEOUT_MS };
}

/** Whether a hook entry in `~/.gemini/settings.json` was added by Extalia. */
export function isExtaliaGeminiHook(hook: unknown): boolean {
  if (!isObject(hook)) return false;
  return hook.type === 'command' && typeof hook.command === 'string' && /forward\.mjs['"]?\s+gemini\s*$/.test(hook.command);
}

function parseSettings(text: string | undefined, file: string): Json {
  if (text === undefined || !text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new ConnectError(`${file} is not valid JSON (${error instanceof Error ? error.message : 'parse error'}). Extalia left it unchanged; fix the file or add the hooks by hand.`); }
  if (!isObject(value)) throw new ConnectError(`${file} must contain a JSON object. Extalia left it unchanged.`);
  return value;
}

function hooksOf(settings: Json, create: boolean): Json | undefined {
  const hooks = settings.hooks;
  if (isObject(hooks)) return hooks;
  if (hooks !== undefined) throw new ConnectError('The "hooks" entry of the Gemini CLI settings is not an object. Extalia left the file unchanged.');
  if (!create) return undefined;
  const created: Json = {};
  settings.hooks = created;
  return created;
}

/** The forwarder command of the first Extalia hook already in the file, if any. */
export function existingGeminiCommand(text: string | undefined, file: string): string | undefined {
  const hooks = hooksOf(parseSettings(text, file), false) ?? {};
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
      if (isExtaliaGeminiHook(hook) && typeof (hook as Json).command === 'string') return (hook as Json).command as string;
    }
  }
  return undefined;
}

export interface GeminiInspection {
  /** Events with an Extalia entry that matches the desired one exactly. */
  current: string[];
  /** Events with an Extalia entry that differs (Node path, forwarder path, or timeout). */
  stale: string[];
  /** Events with no Extalia entry. */
  missing: string[];
  /** Hook entries in the file that are not Extalia's. */
  userHookCount: number;
}

export function inspectGeminiSettings(text: string | undefined, file: string, desired: GeminiDesired): GeminiInspection {
  const settings = parseSettings(text, file);
  const hooks = hooksOf(settings, false) ?? {};
  const result: GeminiInspection = { current: [], stale: [], missing: [], userHookCount: 0 };
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of isObject(group) && Array.isArray(group.hooks) ? group.hooks : []) {
      if (!isExtaliaGeminiHook(hook)) result.userHookCount++;
    }
  }
  const expected = JSON.stringify(desiredHook(desired));
  for (const event of GEMINI_EVENTS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const ours = groups.flatMap(group => (isObject(group) && Array.isArray(group.hooks) ? group.hooks : [])).filter(isExtaliaGeminiHook);
    if (!ours.length) result.missing.push(event);
    else if (ours.length === 1 && JSON.stringify(ours[0]) === expected) result.current.push(event);
    else result.stale.push(event);
  }
  return result;
}

export interface GeminiPlan { after: string; changed: boolean; events: string[] }

/** Add or update Extalia's command hook groups in `~/.gemini/settings.json`, keeping everything else. */
export function planGeminiSettings(text: string | undefined, file: string, desired: GeminiDesired): GeminiPlan {
  const settings = parseSettings(text, file);
  const hooks = hooksOf(settings, true) as Json;
  const events: string[] = [];
  const targetHook = desiredHook(desired);

  for (const event of GEMINI_EVENTS) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new ConnectError(`The "${event}" hooks in the Gemini CLI settings are not a list. Extalia left the file unchanged.`);
    }
    const groups = (existing ?? []) as unknown[];
    let found = false, touched = false;
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isExtaliaGeminiHook)) {
        kept.push(group);
        continue;
      }
      const entries: unknown[] = [];
      for (const entry of group.hooks) {
        if (!isExtaliaGeminiHook(entry)) { entries.push(entry); continue; }
        if (found) { touched = true; continue; }
        found = true;
        if (JSON.stringify(entry) !== JSON.stringify(targetHook)) { entries.push(targetHook); touched = true; }
        else entries.push(entry);
      }
      if (entries.length) { group.hooks = entries; kept.push(group); }
    }
    if (!found) { kept.push({ matcher: '*', hooks: [targetHook] }); touched = true; }
    if (touched) { hooks[event] = kept; events.push(event); }
  }

  const style: JsonStyle = detectJsonStyle(text);
  const after = serializeJson(settings, style);
  return { after, changed: after !== text, events };
}

/** Remove every Extalia hook entry from `~/.gemini/settings.json`. */
export function removeGeminiEntries(text: string, file: string): { after: string; removed: number } {
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
        const remaining = group.hooks.filter(hook => !isExtaliaGeminiHook(hook));
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
