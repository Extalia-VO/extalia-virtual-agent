import { describe, expect, it } from 'vitest';
import { buildSessionBrowserHarnessGroups, buildSessionBrowserSnapshot, type LibrarySessionSummary, type SessionSummary } from '@extalia/platform';

function observed(id: string, sourceId: string, path: string | undefined, running = false): SessionSummary {
  return { id, title: `Session ${id}`, workspaceId: '', connectionId: 'observe', control: 'observed', running,
    createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-02T00:00:00Z',
    observation: { sourceId, nativeSessionId: id, ...(path ? { projectPath: path } : {}), watching: true, status: 'watching' } };
}
function imported(): LibrarySessionSummary {
  return { id: 'imported', title: 'Imported title', sourceId: 'codex', importMode: 'imported', state: 'active',
    startedAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-01-02T00:00:00Z', projectLocation: '/projects/example', messageCount: 3 };
}

describe('harness-root session navigation', () => {
  it('keeps each source folder under its own harness even when project paths are identical', () => {
    const sessions = [observed('codex', 'codex', '/projects/example'), observed('claude', 'claude-code', '/projects/example')];
    const input = { collection: 'observed' as const, observed: sessions };
    const roots = buildSessionBrowserHarnessGroups(input, { collection: 'observed' });
    expect(roots.map(root => root.sourceId).sort()).toEqual(['claude-code', 'codex']);
    for (const root of roots) {
      const child = buildSessionBrowserSnapshot(input, { collection: 'observed', harness: root.sourceId });
      expect(child.groups).toHaveLength(1);
      expect(child.groups[0]!.name).toBe('example');
      expect(child.sessionsByGroup.get(child.groups[0]!.id)?.map(row => row.id)).toEqual([root.sourceId === 'codex' ? 'codex' : 'claude']);
    }
  });

  it('exposes running counts for collapsed observed roots and folders independently of current view', () => {
    const working = observed('working', 'codex', '/projects/example', true);
    const ready = observed('ready', 'claude-code', '/projects/example');
    const input = { collection: 'observed' as const, observed: [working, ready] };
    const roots = buildSessionBrowserHarnessGroups(input, { collection: 'observed' });
    expect(roots.find(root => root.sourceId === 'codex')?.runningCount).toBe(1);
    expect(roots.find(root => root.sourceId === 'claude-code')?.runningCount).toBe(0);
    const child = buildSessionBrowserSnapshot(input, { collection: 'observed', harness: 'codex' });
    expect(child.groups[0]!.runningCount).toBe(1);
  });

  it('keeps idle no-project sessions free of working indicators', () => {
    const row = observed('ready', 'codex', undefined);
    const input = { collection: 'observed' as const, observed: [row] };
    const root = buildSessionBrowserHarnessGroups(input, { collection: 'observed' })[0]!;
    const child = buildSessionBrowserSnapshot(input, { collection: 'observed', harness: 'codex' }).groups[0]!;
    expect(root.runningCount).toBe(0);
    expect(child.id).toBe('unassigned');
    expect(child.runningCount).toBe(0);
  });

  it('never turns imported active archival state into a working indicator', () => {
    const row = imported(), input = { collection: 'library' as const, library: [row] };
    const root = buildSessionBrowserHarnessGroups(input, { collection: 'library' })[0]!;
    const child = buildSessionBrowserSnapshot(input, { collection: 'library', harness: 'codex' }).groups[0]!;
    expect(root.runningCount).toBeUndefined();
    expect(child.runningCount).toBeUndefined();
  });
});
