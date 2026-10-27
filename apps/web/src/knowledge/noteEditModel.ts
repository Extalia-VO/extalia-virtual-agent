import {
  KNOWLEDGE_EDIT_UNSUPPORTED, KNOWLEDGE_IMPORT_UNSUPPORTED, KNOWLEDGE_NOTE_EDIT_METHODS, normalizeKnowledgeNotePath, type AgentHostApi, type KnowledgeHistoryEntry,
  type KnowledgeImportOutcome, type KnowledgeMemoryImport, type KnowledgeStatus,
} from '@extalia/platform';
import { isUnsupportedMessage } from './knowledgeModel';

/**
 * Note editing on the Knowledge page (W5 slice 2b): what the host offers, front matter helpers, a small
 * side-by-side line diff for conflicts, and history/import helpers. Pure functions only.
 */

/** The edit methods, all present. */
export type KnowledgeEditApi = Pick<Required<AgentHostApi>, (typeof KNOWLEDGE_NOTE_EDIT_METHODS)[number]>;
export type MemoryImportApi = Pick<Required<AgentHostApi>, 'importMemoryNotes'>;

export interface EditSupport { notes: boolean; memoryImport: boolean }

/**
 * Editing shows only when the host has the methods (Desktop and the Bridge always forward them) and its
 * status says the native core serves them; a host without either keeps the page read-only.
 */
export function editSupport(agents: Partial<AgentHostApi> | undefined, status: KnowledgeStatus | undefined): EditSupport {
  const ready = status?.state === 'ready';
  return {
    notes: ready && status.editing?.notes === true && KNOWLEDGE_NOTE_EDIT_METHODS.every(method => typeof agents?.[method] === 'function'),
    memoryImport: ready && status.editing?.memoryImport === true && typeof agents?.importMemoryNotes === 'function',
  };
}

/** A refusal that means "this host or core cannot edit": the actions hide instead of showing an error. */
export function isEditUnsupportedMessage(message: string): boolean {
  return isUnsupportedMessage(message) || message === KNOWLEDGE_EDIT_UNSUPPORTED || message === KNOWLEDGE_IMPORT_UNSUPPORTED;
}

const FRONT_MATTER = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Split a note file into its YAML front matter (without the fences) and the Markdown after it. */
export function splitFrontMatter(text: string): { frontMatter?: string; body: string } {
  const match = FRONT_MATTER.exec(text);
  return match ? { frontMatter: match[1]!, body: text.slice(match[0].length) } : { body: text };
}

/** Whether the front matter says `managed_by: extalia` (Extalia may then update the note itself). */
export function isManagedText(text: string): boolean {
  const { frontMatter } = splitFrontMatter(text);
  return frontMatter !== undefined && /^managed_by:[ \t]*(["']?)extalia\1[ \t]*(?:#.*)?$/m.test(frontMatter);
}

/** A typed note path: trimmed, without a leading `/`, `.md` added. Throws the validator's message. */
export function notePathFrom(input: string): string {
  let path = input.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (path && !/\.md$/i.test(path)) path = `${path}.md`;
  return normalizeKnowledgeNotePath(path);
}

/** The text a new note starts with: its title as the first heading. */
export function newNoteText(title: string, path: string): string {
  const heading = title.trim().replace(/\s+/g, ' ') || path.split('/').pop()!.replace(/\.md$/i, '');
  return `# ${heading}\n\n`;
}

export const shortHash = (sha: string | undefined): string => (sha ? sha.slice(0, 8) : '—');

/** Whether a history entry is a version the note can be rolled back to (a conflict entry's hash is the copy). */
export function restorableEntry(entry: KnowledgeHistoryEntry): boolean {
  return entry.kind !== 'conflict';
}

export interface DiffCell { line: number; text: string }
export interface DiffRow { kind: 'same' | 'removed' | 'added' | 'changed'; left?: DiffCell; right?: DiffCell }
export interface LineDiff { rows: DiffRow[]; added: number; removed: number; approximate: boolean }

/**
 * A side-by-side line diff (longest common subsequence after trimming the common start and end). When the
 * changed middle is too large for the table (`maxCells`), it is shown as removed then added (`approximate`).
 */
export function lineDiff(before: string, after: string, maxCells = 4_000_000): LineDiff {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  const ops: ('=' | '-' | '+')[] = [];
  const approximate = n * m > maxCells;
  if (approximate) {
    ops.push(...Array<'-'>(n).fill('-'), ...Array<'+'>(m).fill('+'));
  } else if (n || m) {
    // lcs[i][j]: common lines of a[start+i..endA) and b[start+j..endB).
    const width = m + 1;
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = a[start + i] === b[start + j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { ops.push('='); i++; j++; }
      else if (j < m && (i === n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) { ops.push('+'); j++; }
      else { ops.push('-'); i++; }
    }
  }
  const rows: DiffRow[] = [];
  for (let index = 0; index < start; index++) rows.push({ kind: 'same', left: { line: index + 1, text: a[index]! }, right: { line: index + 1, text: b[index]! } });
  let left = start, right = start, added = 0, removed = 0;
  for (let at = 0; at < ops.length;) {
    if (ops[at] === '=') {
      rows.push({ kind: 'same', left: { line: left + 1, text: a[left]! }, right: { line: right + 1, text: b[right]! } });
      left++; right++; at++;
      continue;
    }
    // A run of removals and additions: pair them up as changed lines.
    const gone: DiffCell[] = [], come: DiffCell[] = [];
    while (at < ops.length && ops[at] !== '=') {
      if (ops[at] === '-') { gone.push({ line: left + 1, text: a[left]! }); left++; } else { come.push({ line: right + 1, text: b[right]! }); right++; }
      at++;
    }
    removed += gone.length; added += come.length;
    for (let index = 0; index < Math.max(gone.length, come.length); index++) {
      const l = gone[index], r = come[index];
      rows.push(l && r ? { kind: 'changed', left: l, right: r } : l ? { kind: 'removed', left: l } : { kind: 'added', right: r! });
    }
  }
  for (let index = 0; index < a.length - endA; index++) rows.push({ kind: 'same', left: { line: endA + index + 1, text: a[endA + index]! }, right: { line: endB + index + 1, text: b[endB + index]! } });
  return { rows, added, removed, approximate };
}

/** Rows to show: changes with `context` unchanged lines around them; longer unchanged stretches fold into one gap row. */
export function foldDiff(rows: readonly DiffRow[], context = 2): (DiffRow | { kind: 'gap'; count: number })[] {
  const keep = rows.map(() => false);
  rows.forEach((row, index) => {
    if (row.kind === 'same') return;
    for (let at = Math.max(0, index - context); at <= Math.min(rows.length - 1, index + context); at++) keep[at] = true;
  });
  const out: (DiffRow | { kind: 'gap'; count: number })[] = [];
  let hidden = 0;
  rows.forEach((row, index) => {
    if (keep[index]) { if (hidden) { out.push({ kind: 'gap', count: hidden }); hidden = 0; } out.push(row); } else hidden++;
  });
  if (hidden) out.push({ kind: 'gap', count: hidden });
  return out;
}

/** Notes a confirmed import would write (new notes and new revisions). */
export function importWrites(result: KnowledgeMemoryImport): number {
  return result.notes.filter(note => note.outcome === 'created' || note.outcome === 'updated' || note.outcome === 'conflict').length;
}

/** Outcomes in display order with their counts (from the notes, so a truncated list still adds up on screen). */
export function importOutcomeCounts(result: KnowledgeMemoryImport): [KnowledgeImportOutcome, number][] {
  const order: KnowledgeImportOutcome[] = ['created', 'updated', 'unchanged', 'conflict', 'pending_conflict', 'missing_in_vault', 'skipped'];
  const counts = new Map<KnowledgeImportOutcome, number>();
  for (const note of result.notes) counts.set(note.outcome, (counts.get(note.outcome) ?? 0) + 1);
  return order.filter(outcome => counts.has(outcome)).map(outcome => [outcome, counts.get(outcome)!]);
}
