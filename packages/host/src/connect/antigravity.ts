import { detectJsonStyle, serializeJson, type JsonStyle } from './claude.js';
import { ConnectError, quoteArgument } from './util.js';

/**
 * Antigravity command hooks in `~/.gemini/config/hooks.json` (user level only).
 *
 * Antigravity organizes hooks by top-level group name (for example `"extalia"`).
 * Tool events (`PreToolUse`, `PostToolUse`) use matcher groups
 * (`[{ matcher: "*", hooks: [...] }]`), while lifecycle events
 * (`PreInvocation`, `PostInvocation`, `Stop`) use a flat array of command hooks.
 * Because Antigravity does not include `hook_event_name` in its stdin JSON payload,
 * each command passes the event name as the second argument to `forward.mjs`
 * (`<node> <forward.mjs> antigravity <EventName>`).
 *
 * Antigravity's `PreToolUse` contract requires a `decision`; a `{}` reply is
 * read as a deny, so the forwarder prints nothing for that event (an observer
 * must never decide). Other events receive `{}`.
 */

export const ANTIGRAVITY_GROUPED_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
export const ANTIGRAVITY_FLAT_EVENTS = ['PreInvocation', 'PostInvocation', 'Stop'] as const;
export const ANTIGRAVITY_EVENTS = [
  'PreInvocation',
  'PostInvocation',
  'PreToolUse',
  'PostToolUse',
  'Stop',
] as const;

export const ANTIGRAVITY_HOOK_GROUP = 'extalia';
export const ANTIGRAVITY_HOOK_TIMEOUT_SEC = 5;

export interface AntigravityDesired {
  /** Base forwarder command (`<node> <forward.mjs> antigravity`), without the trailing event name. */
  command: string;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isGroupedEvent = (event: string): boolean => (ANTIGRAVITY_GROUPED_EVENTS as readonly string[]).includes(event);

export function antigravityCommand(nodePath: string, forwarderPath: string, platform: string): string {
  return `${quoteArgument(nodePath, platform)} ${quoteArgument(forwarderPath, platform)} antigravity`;
}

function desiredHook(desired: AntigravityDesired, event: string): Json {
  return { type: 'command', command: `${desired.command} ${event}`, timeout: ANTIGRAVITY_HOOK_TIMEOUT_SEC };
}

/** Whether a hook entry in `~/.gemini/config/hooks.json` was added by Extalia. */
export function isExtaliaAntigravityHook(hook: unknown): boolean {
  if (!isObject(hook)) return false;
  return hook.type === 'command' && typeof hook.command === 'string' && /forward\.mjs['"]?\s+antigravity(?:\s+\w+)?\s*$/.test(hook.command);
}

/** Strip a trailing event argument from a full hook command so `commandValid` can inspect `<node> <forward.mjs> antigravity`. */
function baseAntigravityCommand(fullCommand: string): string {
  return fullCommand.replace(/\s+(?:PreInvocation|PostInvocation|PreToolUse|PostToolUse|Stop)\s*$/, '');
}

function parseHooksFile(text: string | undefined, file: string): Json {
  if (text === undefined || !text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new ConnectError(`${file} is not valid JSON (${error instanceof Error ? error.message : 'parse error'}). Extalia left it unchanged; fix the file or add the hooks by hand.`); }
  if (!isObject(value)) throw new ConnectError(`${file} must contain a JSON object. Extalia left it unchanged.`);
  return value;
}

function collectHooksForEvent(groupObj: Json, event: string): Json[] {
  const entries = groupObj[event];
  if (!Array.isArray(entries)) return [];
  if (isGroupedEvent(event)) {
    return entries.flatMap(item => (isObject(item) && Array.isArray(item.hooks) ? item.hooks.filter(isObject) : []));
  }
  return entries.filter(isObject);
}

/** The base forwarder command (`<node> <forward.mjs> antigravity`) of the first Extalia hook already in the file, if any. */
export function existingAntigravityCommand(text: string | undefined, file: string): string | undefined {
  const root = parseHooksFile(text, file);
  for (const groupVal of Object.values(root)) {
    if (!isObject(groupVal)) continue;
    for (const event of Object.keys(groupVal)) {
      for (const hook of collectHooksForEvent(groupVal, event)) {
        if (isExtaliaAntigravityHook(hook) && typeof hook.command === 'string') {
          return baseAntigravityCommand(hook.command);
        }
      }
    }
  }
  return undefined;
}

export interface AntigravityInspection {
  /** Events with an Extalia entry that matches the desired one exactly. */
  current: string[];
  /** Events with an Extalia entry that differs (Node path, forwarder path, or timeout). */
  stale: string[];
  /** Events with no Extalia entry. */
  missing: string[];
  /** Hook entries in the file that are not Extalia's. */
  userHookCount: number;
}

export function inspectAntigravityHooks(text: string | undefined, file: string, desired: AntigravityDesired): AntigravityInspection {
  const root = parseHooksFile(text, file);
  const result: AntigravityInspection = { current: [], stale: [], missing: [], userHookCount: 0 };
  for (const groupVal of Object.values(root)) {
    if (!isObject(groupVal)) continue;
    for (const event of Object.keys(groupVal)) {
      for (const hook of collectHooksForEvent(groupVal, event)) {
        if (!isExtaliaAntigravityHook(hook)) result.userHookCount++;
      }
    }
  }

  for (const event of ANTIGRAVITY_EVENTS) {
    const ours: Json[] = [];
    for (const groupVal of Object.values(root)) {
      if (!isObject(groupVal)) continue;
      for (const hook of collectHooksForEvent(groupVal, event)) {
        if (isExtaliaAntigravityHook(hook)) ours.push(hook);
      }
    }
    const expected = JSON.stringify(desiredHook(desired, event));
    if (!ours.length) result.missing.push(event);
    else if (ours.length === 1 && JSON.stringify(ours[0]) === expected) result.current.push(event);
    else result.stale.push(event);
  }
  return result;
}

export interface AntigravityPlan { after: string; changed: boolean; events: string[] }

/** Add or update Extalia's hook group (`"extalia"`) in `~/.gemini/config/hooks.json`, keeping everything else. */
export function planAntigravityHooks(text: string | undefined, file: string, desired: AntigravityDesired): AntigravityPlan {
  const root = parseHooksFile(text, file);
  const existingGroup = root[ANTIGRAVITY_HOOK_GROUP];
  if (existingGroup !== undefined && !isObject(existingGroup)) {
    throw new ConnectError(`The "${ANTIGRAVITY_HOOK_GROUP}" entry in the Antigravity hooks file is not an object. Extalia left the file unchanged.`);
  }
  const group: Json = isObject(existingGroup) ? existingGroup : {};
  root[ANTIGRAVITY_HOOK_GROUP] = group;
  const events: string[] = [];

  for (const event of ANTIGRAVITY_EVENTS) {
    const targetHook = desiredHook(desired, event);
    const existing = group[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new ConnectError(`The "${event}" hooks in the Antigravity hooks file are not a list. Extalia left the file unchanged.`);
    }
    const items = (existing ?? []) as unknown[];
    let found = false, touched = false;
    const kept: unknown[] = [];

    if (isGroupedEvent(event)) {
      for (const item of items) {
        if (!isObject(item) || !Array.isArray(item.hooks) || !item.hooks.some(isExtaliaAntigravityHook)) {
          kept.push(item);
          continue;
        }
        const entries: unknown[] = [];
        for (const entry of item.hooks) {
          if (!isExtaliaAntigravityHook(entry)) { entries.push(entry); continue; }
          if (found) { touched = true; continue; }
          found = true;
          if (JSON.stringify(entry) !== JSON.stringify(targetHook)) { entries.push(targetHook); touched = true; }
          else entries.push(entry);
        }
        if (entries.length) { item.hooks = entries; kept.push(item); }
      }
      if (!found) { kept.push({ matcher: '*', hooks: [targetHook] }); touched = true; }
    } else {
      for (const entry of items) {
        if (!isExtaliaAntigravityHook(entry)) { kept.push(entry); continue; }
        if (found) { touched = true; continue; }
        found = true;
        if (JSON.stringify(entry) !== JSON.stringify(targetHook)) { kept.push(targetHook); touched = true; }
        else kept.push(entry);
      }
      if (!found) { kept.push(targetHook); touched = true; }
    }

    if (touched) { group[event] = kept; events.push(event); }
  }

  const style: JsonStyle = detectJsonStyle(text);
  const after = serializeJson(root, style);
  return { after, changed: after !== text, events };
}

/** Remove every Extalia hook entry from `~/.gemini/config/hooks.json`. */
export function removeAntigravityEntries(text: string, file: string): { after: string; removed: number } {
  const root = parseHooksFile(text, file);
  let removed = 0;

  for (const [groupName, groupVal] of Object.entries(root)) {
    if (!isObject(groupVal)) continue;
    for (const [event, items] of Object.entries(groupVal)) {
      if (!Array.isArray(items)) continue;
      const kept: unknown[] = [];
      let eventRemoved = 0;
      if (isGroupedEvent(event)) {
        for (const item of items) {
          if (!isObject(item) || !Array.isArray(item.hooks)) { kept.push(item); continue; }
          const remaining = item.hooks.filter(hook => !isExtaliaAntigravityHook(hook));
          const count = item.hooks.length - remaining.length;
          eventRemoved += count;
          if (!count) kept.push(item);
          else if (remaining.length) { item.hooks = remaining; kept.push(item); }
        }
      } else {
        for (const item of items) {
          if (isExtaliaAntigravityHook(item)) eventRemoved++;
          else kept.push(item);
        }
      }
      removed += eventRemoved;
      if (!eventRemoved) continue;
      if (kept.length) groupVal[event] = kept;
      else delete groupVal[event];
    }
    if (!Object.keys(groupVal).length && removed) delete root[groupName];
  }

  return { after: removed ? serializeJson(root, detectJsonStyle(text)) : text, removed };
}
