import type { HostState, SessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { resolveChat } from '../src/chat/selection';

const stamp = '2026-10-09T00:00:00.000Z';
const session = (id: string, workspaceId: string, lastActiveAt: string): SessionSummary => ({ id, workspaceId, connectionId: 'connection', title: id, createdAt: stamp, lastActiveAt, control: 'managed', running: false });
const state: HostState = {
  setupComplete: true, profile: { id: 'profile', name: 'Example' }, connections: [],
  workspaces: ['alpha', 'beta'].map(id => ({ id, profileId: 'profile', name: id, projectLocation: `/projects/${id}`, createdAt: stamp, updatedAt: stamp })),
  sessions: [session('alpha-old', 'alpha', stamp), session('beta-one', 'beta', '2026-10-09T00:00:02.000Z'), session('alpha-new', 'alpha', '2026-10-09T00:00:01.000Z')],
  library: [], dataDirectory: '/example/extalia', storage: { dataDirectory: '/example/extalia', secretStore: 'memory' }, host: { kind: 'bridge', version: 'test' },
};

describe('project and session selection', () => {
  it('shows only the selected project’s sessions and preserves the requested session', () => {
    const selected = resolveChat(state, { workspaceId: 'alpha', sessionId: 'alpha-old' });
    expect(selected.workspace?.id).toBe('alpha');
    expect(selected.sessions.map(item => item.id)).toEqual(['alpha-new', 'alpha-old']);
    expect(selected.session?.id).toBe('alpha-old');
    const switched = resolveChat(state, { workspaceId: 'beta', sessionId: 'alpha-old' });
    expect(switched.sessions.map(item => item.id)).toEqual(['beta-one']);
    expect(switched.session?.id).toBe('beta-one');
  });
  it('does not choose an Observe-only workspace for a new managed chat', () => {
    const mixed = { ...state, workspaces: state.workspaces.map(item => item.id === 'alpha' ? { ...item, mode: 'observe' as const } : item) };
    expect(resolveChat(mixed, { workspaceId: 'alpha' }).workspace?.id).toBe('beta');
    expect(resolveChat({ ...mixed, workspaces: mixed.workspaces.filter(item => item.mode === 'observe') }, {}).workspace).toBeUndefined();
  });
  it('starts a new session explicitly and handles a removed project without mixing session lists', () => {
    expect(resolveChat(state, { workspaceId: 'alpha', sessionId: null }).session).toBeUndefined();
    expect(resolveChat(state, { workspaceId: 'removed', sessionId: 'beta-one' }).session?.id).toBe('alpha-new');
    expect(resolveChat({ ...state, workspaces: [] }, {}).sessions).toEqual([]);
    expect(state.sessions.map(item => item.id)).toEqual(['alpha-old', 'beta-one', 'alpha-new']);
  });
});
