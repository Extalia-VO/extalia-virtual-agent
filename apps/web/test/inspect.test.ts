import type { GitChange, HostState } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { breadcrumbs, changeBadge, diffStats, formatSize, initialWorkspace, lineNumbers, parentPath, parseDiff } from '../src/inspect/format';

describe('paths', () => {
  it('builds breadcrumbs and parent folders', () => {
    expect(breadcrumbs('.')).toEqual([]);
    expect(breadcrumbs('src/app/ui')).toEqual([{ name: 'src', path: 'src' }, { name: 'app', path: 'src/app' }, { name: 'ui', path: 'src/app/ui' }]);
    expect(parentPath('src/app/ui')).toBe('src/app');
    expect(parentPath('src')).toBe('.');
    expect(parentPath('.')).toBe('.');
  });

  it('formats sizes and line numbers', () => {
    expect(formatSize(512, 'en')).toBe('512 B');
    expect(formatSize(1536, 'en')).toBe('1.5 KB');
    expect(formatSize(1536, 'id')).toBe('1,5 KB');
    expect(formatSize(3 * 1024 * 1024, 'en')).toBe('3 MB');
    expect(lineNumbers(3)).toBe('1\n2\n3');
    expect(lineNumbers(0)).toBe('');
  });

  it('opens the workspace selected in Chat, else the first', () => {
    const state = { workspaces: [{ id: 'w1' }, { id: 'w2' }] } as unknown as HostState;
    expect(initialWorkspace(state, 'w2')).toBe('w2');
    expect(initialWorkspace(state, 'gone')).toBe('w1');
    expect(initialWorkspace({ workspaces: [] } as unknown as HostState)).toBeUndefined();
  });
});

describe('changeBadge', () => {
  const change = (overrides: Partial<GitChange>): GitChange => ({ path: 'a.ts', index: 'unmodified', worktree: 'unmodified', ...overrides });

  it('shows the most significant state', () => {
    expect(changeBadge(change({ worktree: 'modified' }))).toEqual({ state: 'modified', letter: 'M', tone: 'warn' });
    expect(changeBadge(change({ index: 'added', worktree: 'modified' }))).toEqual({ state: 'added', letter: 'A', tone: 'ok' });
    expect(changeBadge(change({ worktree: 'deleted' }))).toEqual({ state: 'deleted', letter: 'D', tone: 'error' });
    expect(changeBadge(change({ index: 'renamed' }))).toMatchObject({ letter: 'R' });
    expect(changeBadge(change({ untracked: true }))).toEqual({ state: 'untracked', letter: '?', tone: 'ok' });
    expect(changeBadge(change({ index: 'unmerged', worktree: 'unmerged', conflicted: true }))).toEqual({ state: 'unmerged', letter: 'U', tone: 'error' });
  });
});

describe('parseDiff', () => {
  const text = [
    'diff --git a/a.ts b/a.ts', 'index 1..2 100644', '--- a/a.ts', '+++ b/a.ts', '@@ -1,3 +1,3 @@ export', ' keep', '-old', '+new', '\\ No newline at end of file',
    'diff --git a/b.txt b/b.txt', 'new file mode 100644', '--- /dev/null', '+++ b/b.txt', '@@ -0,0 +1 @@', '+--- not a header', '',
  ].join('\n');

  it('classifies header, hunk and content lines', () => {
    const lines = parseDiff(text);
    expect(lines.map(line => line.kind)).toEqual([
      'file', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'note',
      'file', 'meta', 'meta', 'meta', 'hunk', 'add',
    ]);
    expect(diffStats(lines)).toEqual({ files: 2, additions: 2, deletions: 1 });
  });

  it('handles empty diffs and binary notices', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n').map(line => line.kind)).toEqual(['file', 'meta']);
  });
});
