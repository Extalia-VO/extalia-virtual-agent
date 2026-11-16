import { redact } from '@extalia/core';
import type { ToolCall, ToolResultEntry } from './model.js';

export interface ToolContextProjection {
  content: string;
  method: 'json-whitespace' | 'repeated-lines' | 'evidence-excerpts';
  retainedDiagnosticLines: number;
  redacted: boolean;
}

const MAX_SCAN_CHARACTERS = 2_000_000;
const MAX_LINES = 32_768;
const DIAGNOSTIC = /(?:^|[^\p{L}\p{N}_])(?:error|errors|failed|failure|failures|exception|warning|warnings|fatal|panic|assertion|decision|constraint|constraints|pending|unresolved|must|shall|never|not|cannot|only|unless|required|denied|preserve|limit|jangan|tidak|belum|hanya|kecuali|wajib|harus|gagal|kesalahan|peringatan|keputusan|batas|tertunda)(?:$|[^\p{L}\p{N}_])/iu;
const SOURCE_TOOLS = /(?:^|_)(?:skill|skills|knowledge|memory|handover|continuity|approval)(?:_|$)/i;
const EXACT_SOURCE = /(?:^|[\\/])(?:SKILL|AGENTS|CLAUDE|GEMINI|INSTRUCTIONS)\.md$|\.(?:[cm]?[jt]sx?|py|rs|go|java|c|cc|cpp|h|hpp|cs|rb|swift|kt|kts|sh|bash|ps1|sql|toml|ya?ml|json|jsonc|json5|env|ini|conf|xml|md|mdx)$/i;

/** Source-read receipts and control results cannot be substituted with a summary. */
export function toolContextIsProtected(result: ToolResultEntry, call: ToolCall, readTool: string): boolean {
  if (result.isError || result.name === readTool || result.name === 'caveman_retrieve'
    || SOURCE_TOOLS.test(result.name) || /(?:^|_)(?:archive|recovery)(?:_|$)/i.test(result.name)
    || result.content.trimStart().startsWith('[Archived tool output;') || result.content.trimStart().startsWith('[Optimized tool output;')
    || /(?:^|\n)\[(?:\d+ identical lines omitted;|source characters \d+-\d+\])/u.test(result.content)) return true;
  if (call.input && typeof call.input === 'object') {
    for (const key of ['path', 'file', 'filePath', 'filename']) {
      const descriptor = Object.getOwnPropertyDescriptor(call.input, key);
      if (descriptor && !('value' in descriptor)) return true;
      if (typeof descriptor?.value === 'string' && EXACT_SOURCE.test(descriptor.value)) return true;
    }
  }
  return false;
}

interface Line { start: number; end: number; text: string; important: boolean }
function linesOf(content: string): Line[] | undefined {
  if (content.length > MAX_SCAN_CHARACTERS) return undefined;
  const lines: Line[] = [];
  for (let start = 0; start < content.length;) {
    if (lines.length === MAX_LINES) return undefined;
    const newline = content.indexOf('\n', start);
    const end = newline < 0 ? content.length : newline + 1;
    const text = content.slice(start, newline < 0 ? end : newline).replace(/\r$/u, '');
    lines.push({ start, end, text, important: DIAGNOSTIC.test(text) });
    start = end;
  }
  return lines;
}

/** A third-party transform may not remove explicit diagnostic/constraint lines. */
export function retainsRequiredToolEvidence(source: string, projected: string): boolean {
  const lines = linesOf(source);
  if (!lines) return false;
  let offset = 0;
  for (const line of lines) if (line.important) {
    const index = projected.indexOf(line.text, offset);
    if (index < 0) return false;
    offset = index + line.text.length;
  }
  return true;
}

function boundary(content: string, offset: number, end = false): number {
  if (offset > 0 && offset < content.length && /[\uDC00-\uDFFF]/u.test(content[offset]!)
    && /[\uD800-\uDBFF]/u.test(content[offset - 1]!)) return end ? offset + 1 : offset - 1;
  return offset;
}

/** Deterministic local projections; every omitted byte still requires scoped recovery. */
export function projectToolContext(original: string, targetCharacters: number): ToolContextProjection | undefined {
  const content = redact(original), redacted = content !== original;
  if (content.length < targetCharacters + 800) return undefined;
  const lines = linesOf(content);
  if (!lines) return undefined;
  const retainedDiagnosticLines = lines.filter(line => line.important).length;
  const result = (value: string, method: ToolContextProjection['method']) => value.length + 320 < content.length
    ? { content: value, method, retainedDiagnosticLines, redacted } : undefined;

  // Parsing and reserializing changes formatting only. String values, order of array
  // entries, numbers and every field remain present; no schema fields are elided.
  if (content.length <= 256_000 && /^\s*[[{]/u.test(content)) {
    try {
      const parsed: unknown = JSON.parse(content);
      const compact = JSON.stringify(parsed);
      // JSON number normalization can change exact numeric spelling/precision. Only
      // whitespace outside strings is removed from the original bytes instead.
      if (compact.length < content.length) {
        let quoted = false, escaped = false, minified = '';
        for (const char of content) {
          if (quoted || !/\s/u.test(char)) minified += char;
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
        }
        const projected = result(minified, 'json-whitespace');
        if (projected && minified.length <= targetCharacters * 2) return projected;
      }
    } catch { /* Non-JSON prose keeps exact excerpts below. */ }
  }

  // Collapse only consecutive identical non-diagnostic lines. Counts and source
  // ranges remain visible; failures and constraints are never folded into a count.
  const folded: string[] = [];
  let repeats = 0;
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    let end = i + 1;
    if (!line.important && line.text.trim()) while (end < lines.length && lines[end]!.text === line.text) end++;
    folded.push(content.slice(line.start, line.end));
    if (end - i > 1) {
      folded.push(`[${end - i - 1} identical lines omitted; source lines ${i + 2}-${end}]\n`);
      repeats += end - i - 1;
    }
    i = end;
  }
  if (repeats) {
    const projected = result(folded.join(''), 'repeated-lines');
    if (projected && projected.content.length <= targetCharacters * 2) return projected;
  }

  const edgeSize = Math.max(80, Math.floor(targetCharacters / 3));
  const ranges: { start: number; end: number }[] = [
    { start: 0, end: boundary(content, Math.min(content.length, edgeSize), true) },
    { start: boundary(content, Math.max(0, content.length - edgeSize)), end: content.length },
  ];
  for (let i = 0; i < lines.length; i++) if (lines[i]!.important) {
    // Preserve the complete marked line and short neighboring context. Extremely
    // large diagnostic lines intentionally make compaction ineffective.
    const current = lines[i]!, previous = lines[i - 1], next = lines[i + 1];
    ranges.push({ start: previous && previous.end - previous.start <= 240 ? previous.start : current.start,
      end: next && next.end - next.start <= 240 ? next.end : current.end });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: typeof ranges = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range.start <= prior.end) prior.end = Math.max(prior.end, range.end);
    else merged.push({ ...range });
  }
  const excerpts = merged.map(range => `[source characters ${range.start}-${range.end}]\n${content.slice(range.start, range.end)}`).join('\n[omitted; recover original evidence before relying on it]\n');
  return result(excerpts, 'evidence-excerpts');
}
