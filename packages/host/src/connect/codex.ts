import { parse } from 'smol-toml';
import { ConnectError, quoteArgument } from './util.js';

/**
 * Codex hooks in the user-level `config.toml` (never project config).
 *
 * Extalia appends one block of `[[hooks.<Event>]]` tables between two marker
 * comments, so the user's own content, comments and formatting stay untouched
 * and the block can be found and removed byte for byte. The result is parsed
 * again before anything is written; a file that would not stay valid TOML (for
 * example the user defines `hooks.PreToolUse` inline) is refused.
 */

export const CODEX_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd',
] as const;

export const CODEX_BEGIN_MARKER = '# >>> extalia hooks (managed by Extalia; remove with: extalia disconnect codex) >>>';
export const CODEX_END_MARKER = '# <<< extalia hooks <<<';

export interface CodexDesired {
  /** The forwarder command as it should appear in the file. */
  command: string;
}

export function codexCommand(nodePath: string, forwarderPath: string, platform: string): string {
  return `${quoteArgument(nodePath, platform)} ${quoteArgument(forwarderPath, platform)} codex`;
}

/** Codex's snake_case event name as used in hook trust keys. */
export function codexEventKey(event: string): string {
  return event.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

export const isExtaliaCodexCommand = (command: unknown): boolean => typeof command === 'string' && /forward\.mjs['"]?\s+codex\s*$/.test(command);

const tomlString = (value: string) => JSON.stringify(value);

export function codexBlock(desired: CodexDesired): string {
  const command = desired.command;
  const lines = [CODEX_BEGIN_MARKER];
  for (const event of CODEX_EVENTS) {
    lines.push(`[[hooks.${event}]]`, 'matcher = "*"', `hooks = [{ type = "command", command = ${tomlString(command)}, async = true, timeout = 5 }]`, '');
  }
  lines.push(CODEX_END_MARKER, '');
  return lines.join('\n');
}

type Table = Record<string, unknown>;
const isTable = (value: unknown): value is Table => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseCodexConfig(text: string, file: string): Table {
  try { return parse(text) as Table; }
  catch (error) { throw new ConnectError(`${file} is not valid TOML (${error instanceof Error ? error.message.split('\n')[0] : 'parse error'}). Extalia left it unchanged; fix the file or add the hooks by hand.`); }
}

/** Extalia hook entries found by parsing (inside or outside the managed block). */
function ourEntries(config: Table): Array<{ event: string; group: number; hook: number; command: string }> {
  const hooks = isTable(config.hooks) ? config.hooks : {};
  const found: Array<{ event: string; group: number; hook: number; command: string }> = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === 'state' || !Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      const list = isTable(group) && Array.isArray(group.hooks) ? group.hooks : [];
      list.forEach((hook, hookIndex) => { if (isTable(hook) && isExtaliaCodexCommand(hook.command)) found.push({ event, group: groupIndex, hook: hookIndex, command: String(hook.command) }); });
    });
  }
  return found;
}

export interface CodexInspection {
  /** The managed block is present. */
  blockPresent: boolean;
  /** Events with an Extalia hook that has the desired command. */
  current: string[];
  /** Events with an Extalia hook whose command differs (Node or forwarder moved). */
  stale: string[];
  missing: string[];
  /** Extalia hooks found outside the managed block (edited by hand). */
  outsideBlock: boolean;
  userHookCount: number;
  /** `hooks.state` trust records for Extalia hooks, by key `<event>:<group>:<hook>`. */
  trustRecords: Array<{ key: string; hash?: string }>;
}

/** The command of the first Extalia hook already in the file. */
export function existingCodexCommand(text: string | undefined, file: string): string | undefined {
  return ourEntries(parseCodexConfig(text ?? '', file))[0]?.command;
}

export function findBlock(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(CODEX_BEGIN_MARKER);
  if (start < 0) return undefined;
  const endMarker = text.indexOf(CODEX_END_MARKER, start);
  if (endMarker < 0) return undefined;
  let end = endMarker + CODEX_END_MARKER.length;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  return { start, end };
}

export function inspectCodexConfig(text: string | undefined, file: string, desired: CodexDesired): CodexInspection {
  const source = text ?? '';
  const config = parseCodexConfig(source, file);
  const block = findBlock(source);
  const command = desired.command;
  const ours = ourEntries(config);
  const result: CodexInspection = { blockPresent: Boolean(block), current: [], stale: [], missing: [], outsideBlock: false, userHookCount: 0, trustRecords: [] };
  const hooks = isTable(config.hooks) ? config.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (event === 'state' || !Array.isArray(groups)) continue;
    for (const group of groups) result.userHookCount += isTable(group) && Array.isArray(group.hooks) ? group.hooks.filter(hook => !(isTable(hook) && isExtaliaCodexCommand(hook.command))).length : 0;
  }
  for (const event of CODEX_EVENTS) {
    const entries = ours.filter(entry => entry.event === event);
    if (!entries.length) result.missing.push(event);
    else if (entries.length === 1 && entries[0]?.command === command) result.current.push(event);
    else result.stale.push(event);
  }
  result.outsideBlock = ours.length > 0 && !block;
  const state = isTable(hooks.state) ? hooks.state : {};
  for (const entry of ours) {
    const suffix = `:${codexEventKey(entry.event)}:${entry.group}:${entry.hook}`;
    for (const [key, value] of Object.entries(state)) {
      if (key.endsWith(suffix) && isTable(value)) result.trustRecords.push({ key, ...(typeof value.trusted_hash === 'string' ? { hash: value.trusted_hash } : {}) });
    }
  }
  return result;
}

export interface CodexPlan { after: string; changed: boolean; inserted: string; events: string[] }

/** Append the managed block, or replace it in place when present. */
export function planCodexConfig(text: string | undefined, file: string, desired: CodexDesired): CodexPlan {
  const source = text ?? '';
  parseCodexConfig(source, file); // refuse an unreadable file before planning anything
  const block = codexBlock(desired);
  const existing = findBlock(source);
  let after: string, inserted: string;
  if (existing) {
    inserted = '';
    after = source.slice(0, existing.start) + block + source.slice(existing.end);
  } else {
    const separator = !source ? '' : source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    inserted = separator + block;
    after = source + inserted;
  }
  let parsed: Table;
  try { parsed = parse(after) as Table; }
  catch {
    throw new ConnectError(`Adding the Extalia hooks would make ${file} invalid TOML, usually because it already defines "hooks" in a different style (for example an inline list). Extalia left it unchanged; add the hooks by hand or restructure the existing ones as [[hooks.<Event>]] tables.`);
  }
  const hooks = isTable(parsed.hooks) ? parsed.hooks : {};
  for (const event of CODEX_EVENTS) {
    if (!Array.isArray(hooks[event]) || !ourEntries(parsed).some(entry => entry.event === event)) {
      throw new ConnectError(`The Extalia hooks for ${event} would not be recognised in ${file}. Extalia left it unchanged.`);
    }
  }
  const changed = after !== source;
  return { after, changed, inserted, events: changed ? [...CODEX_EVENTS] : [] };
}

/** Remove the managed block. With the exact text Extalia inserted the original bytes come back. */
export function removeCodexBlock(text: string, insertedHint?: string): { after: string; removed: boolean } {
  if (insertedHint && text.includes(insertedHint)) return { after: text.replace(insertedHint, ''), removed: true };
  const block = findBlock(text);
  if (!block) return { after: text, removed: false };
  let start = block.start;
  // Take back the blank line separating the block from the preceding content.
  if (text.slice(0, start).endsWith('\n\n')) start -= 1;
  return { after: text.slice(0, start) + text.slice(block.end), removed: true };
}

/** Remove `[hooks.state."<key>"]` tables (header plus its lines up to the next table) for the given keys. */
export function removeTrustTables(text: string, keys: readonly string[]): { after: string; removed: number } {
  if (!keys.length) return { after: text, removed: 0 };
  const wanted = new Set(keys.map(key => `[hooks.state.${tomlString(key)}]`));
  const lines = text.split('\n');
  const kept: string[] = [];
  let removed = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] as string).replace(/\r$/, '').trim();
    if (!wanted.has(line)) { kept.push(lines[index] as string); continue; }
    removed++;
    index++;
    while (index < lines.length && !/^\s*\[/.test(lines[index] as string)) index++;
    index--;
  }
  let after = kept.join('\n');
  if (removed && text.endsWith('\n') && !after.endsWith('\n')) after += '\n';
  return { after, removed };
}
