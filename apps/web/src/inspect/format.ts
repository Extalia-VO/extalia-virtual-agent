import type { GitChange, GitChangeKind, HostState } from '@extalia/platform';

/** Pure helpers for the Files and Git pages. */

export interface Crumb { name: string; path: string }

/** `a/b/c` → a, a/b, a/b/c. The project folder itself (`.`) has no crumbs. */
export function breadcrumbs(dir: string): Crumb[] {
  const parts = dir.split('/').filter(part => part && part !== '.');
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
}

export function parentPath(dir: string): string {
  const parts = dir.split('/').filter(part => part && part !== '.');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
}

export function formatSize(bytes: number, language: string): string {
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  if (bytes < 1024) return `${number.format(bytes)} B`;
  if (bytes < 1024 * 1024) return `${number.format(bytes / 1024)} KB`;
  return `${number.format(bytes / 1024 / 1024)} MB`;
}

/** `1\n2\n…` for a line-number gutter. */
export function lineNumbers(count: number): string {
  return Array.from({ length: count }, (_, index) => index + 1).join('\n');
}

/** The workspace a page opens with: the one selected elsewhere (Chat), else the first. */
export function initialWorkspace(state: HostState, preferred?: string): string | undefined {
  return state.workspaces.find(item => item.id === preferred)?.id ?? state.workspaces[0]?.id;
}

export type ChangeState = GitChangeKind | 'untracked';
export type Tone = 'ok' | 'warn' | 'error' | 'neutral';

const LETTERS: Record<ChangeState, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', 'type-changed': 'T', unmerged: 'U', untracked: '?', unmodified: '·',
};
const TONES: Record<ChangeState, Tone> = {
  modified: 'warn', added: 'ok', deleted: 'error', renamed: 'warn', copied: 'ok', 'type-changed': 'warn', unmerged: 'error', untracked: 'ok', unmodified: 'neutral',
};

/** The badge for a change: its most significant state (a conflict, else the staged change, else the unstaged one). */
export function changeBadge(change: GitChange): { state: ChangeState; letter: string; tone: Tone } {
  const state: ChangeState = change.untracked ? 'untracked' : change.conflicted ? 'unmerged' : change.index !== 'unmodified' ? change.index : change.worktree;
  return { state, letter: LETTERS[state], tone: TONES[state] };
}

export type DiffLineKind = 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';
export interface DiffLine { kind: DiffLineKind; text: string }
export interface DiffStats { files: number; additions: number; deletions: number }

/** Classify the lines of a unified diff (`git diff` output) for colouring. */
export function parseDiff(text: string): DiffLine[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let inHunk = false;
  return lines.map(line => {
    if (line.startsWith('diff --git ')) { inHunk = false; return { kind: 'file', text: line }; }
    if (line.startsWith('@@')) { inHunk = true; return { kind: 'hunk', text: line }; }
    if (!inHunk) return { kind: 'meta', text: line };
    if (line.startsWith('+')) return { kind: 'add', text: line };
    if (line.startsWith('-')) return { kind: 'del', text: line };
    if (line.startsWith('\\')) return { kind: 'note', text: line };
    return { kind: 'context', text: line };
  });
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  const stats: DiffStats = { files: 0, additions: 0, deletions: 0 };
  for (const line of lines) {
    if (line.kind === 'file') stats.files++;
    else if (line.kind === 'add') stats.additions++;
    else if (line.kind === 'del') stats.deletions++;
  }
  return stats;
}
