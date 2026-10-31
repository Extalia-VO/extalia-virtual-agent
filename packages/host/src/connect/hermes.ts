import { ConnectError } from './util.js';

/**
 * Hermes Agent outbound webhooks in `config.yaml` (default and named profiles).
 *
 * Extalia inserts a comment-delimited block under `hooks.outbound` (or a
 * top-level `hooks:` section when the file has none), preserving every user
 * comment, key and blank line. Each entry posts to the local loopback ingest
 * route `/api/hooks/hermes` with HMAC-SHA256 (`secret: "<ingest token>"`) and
 * `timeout: 2`.
 */

export const HERMES_EVENTS = [
  'on_session_start',
  'on_session_end',
  'pre_llm_call',
  'post_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'subagent_start',
  'subagent_stop',
  'pre_approval_request',
] as const;

export const HERMES_HOOK_PATH = '/api/hooks/hermes';
export const HERMES_BEGIN_MARKER = '# >>> extalia hooks (managed by Extalia; remove with: extalia disconnect hermes) >>>';
export const HERMES_END_MARKER = '# <<< extalia hooks <<<';

export interface HermesDesired {
  /** `undefined` accepts whatever loopback port the existing entry uses (inspection only). */
  port: number | undefined;
  token: string;
}

export function hermesWebhookUrl(port: number): string {
  return `http://127.0.0.1:${port}${HERMES_HOOK_PATH}`;
}

/** Verify that a webhook URL is a plain-HTTP loopback `/api/hooks/hermes` endpoint. */
export function parseExtaliaHermesUrl(raw: string): { port: number } | undefined {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:') return undefined;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
    if (url.pathname !== HERMES_HOOK_PATH) return undefined;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
    return { port };
  } catch {
    return undefined;
  }
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try { return trimmed.startsWith('"') ? (JSON.parse(trimmed) as string) : trimmed.slice(1, -1).replace(/''/g, "'"); }
    catch { return trimmed.slice(1, -1); }
  }
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/** Check basic YAML structure before editing so malformed files are never touched. */
export function validateHermesYaml(text: string, file: string): void {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (/^\t/.test(line)) {
      throw new ConnectError(`${file} uses tab indentation on line ${index + 1}, which is not valid YAML. Extalia left it unchanged.`);
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue;
    if (/^hooks\s*:\s*\S/.test(trimmed) && !/^hooks\s*:\s*#/.test(trimmed)) {
      throw new ConnectError(`${file} defines "hooks" as a scalar or inline value on line ${index + 1}. Extalia left it unchanged; make "hooks:" a mapping first.`);
    }
  }
}

export interface ParsedHermesBlock {
  start: number;
  end: number;
  indent: string;
  mode: 'root' | 'hooks' | 'outbound';
  port?: number;
  token?: string;
  timeout?: number;
  events: string[];
}

/** Locate the managed Extalia block in a Hermes `config.yaml` and parse its fields. */
export function findHermesBlock(text: string): ParsedHermesBlock | undefined {
  const beginIndex = text.indexOf(HERMES_BEGIN_MARKER);
  if (beginIndex < 0) return undefined;
  const endMarkerIndex = text.indexOf(HERMES_END_MARKER, beginIndex);
  if (endMarkerIndex < 0) return undefined;

  let start = beginIndex;
  while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
  const indent = text.slice(start, beginIndex);

  let end = endMarkerIndex + HERMES_END_MARKER.length;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;

  const body = text.slice(start, end);
  const mode: ParsedHermesBlock['mode'] = /^\s*hooks\s*:/m.test(body)
    ? 'root'
    : /^\s*outbound\s*:/m.test(body)
      ? 'hooks'
      : 'outbound';

  let port: number | undefined;
  let token: string | undefined;
  let timeout: number | undefined;
  const events: string[] = [];
  let inEvents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const urlMatch = /^(?:-\s+)?url\s*:\s*(.+)$/.exec(trimmed);
    if (urlMatch) {
      const parsed = parseExtaliaHermesUrl(unquoteYaml(urlMatch[1] as string));
      if (parsed) port = parsed.port;
      inEvents = false;
      continue;
    }
    const secretMatch = /^secret\s*:\s*(.+)$/.exec(trimmed);
    if (secretMatch) {
      token = unquoteYaml(secretMatch[1] as string);
      inEvents = false;
      continue;
    }
    const timeoutMatch = /^timeout\s*:\s*(\d+)\s*$/.exec(trimmed);
    if (timeoutMatch) {
      timeout = Number(timeoutMatch[1]);
      inEvents = false;
      continue;
    }
    const inlineEventsMatch = /^events\s*:\s*\[(.*)\]\s*$/.exec(trimmed);
    if (inlineEventsMatch) {
      for (const item of (inlineEventsMatch[1] as string).split(',')) {
        const clean = unquoteYaml(item);
        if (clean) events.push(clean);
      }
      inEvents = false;
      continue;
    }
    if (/^events\s*:\s*$/.test(trimmed)) {
      inEvents = true;
      continue;
    }
    if (inEvents) {
      const itemMatch = /^-\s+(.+)$/.exec(trimmed);
      if (itemMatch) events.push(unquoteYaml(itemMatch[1] as string));
      else inEvents = false;
    }
  }

  return {
    start,
    end,
    indent,
    mode,
    ...(port !== undefined ? { port } : {}),
    ...(token !== undefined ? { token } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    events,
  };
}

function renderEntryLines(itemIndent: string, port: number, token: string): string[] {
  const fieldIndent = `${itemIndent}  `;
  const eventIndent = `${fieldIndent}  `;
  return [
    `${itemIndent}- url: ${JSON.stringify(hermesWebhookUrl(port))}`,
    `${fieldIndent}secret: ${JSON.stringify(token)}`,
    `${fieldIndent}timeout: 2`,
    `${fieldIndent}events:`,
    ...HERMES_EVENTS.map(event => `${eventIndent}- ${event}`),
  ];
}

export function renderHermesBlock(mode: 'root' | 'hooks' | 'outbound', indent: string, port: number, token: string): string {
  const lines = [`${indent}${HERMES_BEGIN_MARKER}`];
  if (mode === 'root') {
    lines.push(`${indent}hooks:`, `${indent}  outbound:`, ...renderEntryLines(`${indent}    `, port, token));
  } else if (mode === 'hooks') {
    lines.push(`${indent}outbound:`, ...renderEntryLines(`${indent}  `, port, token));
  } else {
    lines.push(...renderEntryLines(indent, port, token));
  }
  lines.push(`${indent}${HERMES_END_MARKER}`, '');
  return lines.join('\n');
}

export function existingHermesPort(text: string | undefined, file: string): number | undefined {
  if (!text) return undefined;
  validateHermesYaml(text, file);
  return findHermesBlock(text)?.port;
}

export interface HermesInspection {
  blockPresent: boolean;
  current: string[];
  stale: string[];
  missing: string[];
  port?: number;
}

export function inspectHermesConfig(text: string | undefined, file: string, desired: HermesDesired): HermesInspection {
  const source = text ?? '';
  validateHermesYaml(source, file);
  const block = findHermesBlock(source);
  if (!block || block.port === undefined) {
    return { blockPresent: false, current: [], stale: [], missing: [...HERMES_EVENTS] };
  }
  const portMatches = desired.port === undefined || block.port === desired.port;
  const tokenMatches = Boolean(desired.token) && block.token === desired.token;
  const timeoutMatches = block.timeout === 2;
  const current: string[] = [];
  const stale: string[] = [];
  const missing: string[] = [];

  for (const event of HERMES_EVENTS) {
    if (!block.events.includes(event)) missing.push(event);
    else if (portMatches && tokenMatches && timeoutMatches) current.push(event);
    else stale.push(event);
  }
  return { blockPresent: true, current, stale, missing, port: block.port };
}

/** Find an existing `hooks:` or `hooks.outbound:` section in a YAML file without modifying comments. */
function findHooksSection(text: string): { mode: 'root' | 'hooks' | 'outbound'; insertAt: number; indent: string } {
  const lines = text.split('\n');
  let offset = 0;
  let hooksIndent: number | undefined;
  let hooksEnd = text.length;
  let outboundIndent: number | undefined;
  let outboundEnd = text.length;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.replace(/\r$/, '');
    const nextOffset = offset + raw.length + (i < lines.length - 1 ? 1 : 0);
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      offset = nextOffset;
      continue;
    }
    const leading = (/^[ ]*/.exec(line)?.[0] ?? '').length;

    if (hooksIndent === undefined) {
      if (leading === 0 && /^hooks\s*:(?:\s*#.*)?$/.test(line)) {
        hooksIndent = 0;
      }
      offset = nextOffset;
      continue;
    }

    if (leading <= hooksIndent) {
      hooksEnd = offset;
      if (outboundIndent !== undefined && outboundEnd > offset) outboundEnd = offset;
      break;
    }

    if (outboundIndent === undefined) {
      if (/^\s+outbound\s*:/.test(line)) {
        if (!/^\s+outbound\s*:(?:\s*#.*)?$/.test(line)) {
          throw new ConnectError('The "hooks.outbound" entry in the Hermes config uses an inline value. Extalia left it unchanged; change it to a block list or remove it first.');
        }
        outboundIndent = leading;
      }
    } else if (leading <= outboundIndent) {
      outboundEnd = offset;
      break;
    }

    offset = nextOffset;
  }

  if (outboundIndent !== undefined) {
    return { mode: 'outbound', insertAt: outboundEnd, indent: ' '.repeat(outboundIndent + 2) };
  }
  if (hooksIndent !== undefined) {
    return { mode: 'hooks', insertAt: hooksEnd, indent: ' '.repeat(hooksIndent + 2) };
  }
  return { mode: 'root', insertAt: text.length, indent: '' };
}

export interface HermesPlan {
  after: string;
  changed: boolean;
  inserted: string;
  events: string[];
}

export function planHermesConfig(text: string | undefined, file: string, desired: { port: number; token: string }): HermesPlan {
  const source = text ?? '';
  validateHermesYaml(source, file);
  const existing = findHermesBlock(source);
  let after: string;
  let inserted: string;

  if (existing) {
    const block = renderHermesBlock(existing.mode, existing.indent, desired.port, desired.token);
    inserted = '';
    after = source.slice(0, existing.start) + block + source.slice(existing.end);
  } else {
    const target = findHooksSection(source);
    const block = renderHermesBlock(target.mode, target.indent, desired.port, desired.token);
    const beforeSlice = source.slice(0, target.insertAt);
    const afterSlice = source.slice(target.insertAt);
    const separator = !beforeSlice
      ? ''
      : target.mode === 'root'
        ? (beforeSlice.endsWith('\n\n') ? '' : beforeSlice.endsWith('\n') ? '\n' : '\n\n')
        : (beforeSlice.endsWith('\n') ? '' : '\n');
    inserted = separator + block;
    after = beforeSlice + inserted + afterSlice;
  }

  const changed = after !== source;
  const inspected = inspectHermesConfig(source, file, desired);
  const events = [...inspected.missing, ...inspected.stale];
  return { after, changed, inserted, events: changed ? (events.length ? events : [...HERMES_EVENTS]) : [] };
}

export function removeHermesBlock(text: string, insertedHint?: string): { after: string; removed: number } {
  if (insertedHint && text.includes(insertedHint)) {
    return { after: text.replace(insertedHint, ''), removed: HERMES_EVENTS.length };
  }
  const block = findHermesBlock(text);
  if (!block) return { after: text, removed: 0 };
  let start = block.start;
  if (block.mode === 'root' && text.slice(0, start).endsWith('\n\n')) start -= 1;
  return { after: text.slice(0, start) + text.slice(block.end), removed: HERMES_EVENTS.length };
}
