import type { AgentTeam, SessionSummary } from '@extalia/platform';
import { describe, expect, it } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { dockTeamStatus, teamDialogScope, teamForNewSession, teamSpecPreview, workspaceTeamSupported } from '../src/office/team';

const TEAM: AgentTeam = {
  enabled: true, allowedModels: ['m-a'],
  members: [{ id: 'm-1', name: 'Elena Vael', role: 'Researcher', models: ['m-a'] }, { id: 'm-2', name: 'Theo Mark', role: 'Reviewer', models: ['m-a'] }],
};
const session = (team?: { enabled: boolean; size: number }) => ({ id: 's1', ...(team ? { team } : {}) }) as unknown as SessionSummary;

describe('v0.0.47 workspace default team (UI helpers)', () => {
  it('chooses what the dialog edits', () => {
    expect(teamDialogScope({ sessionId: 's1', workspaceDefaults: true })).toBe('session');
    expect(teamDialogScope({ sessionId: 's1', fromPrompt: true, workspaceDefaults: true })).toBe('session');
    expect(teamDialogScope({ workspaceDefaults: true })).toBe('workspace');
    expect(teamDialogScope({ fromPrompt: true, workspaceDefaults: true })).toBe('draft');
    // Hosts without workspace teams keep the unsaved draft for the next new session.
    expect(teamDialogScope({ workspaceDefaults: false })).toBe('draft');
  });

  it('shows the targeted session’s team, else the workspace default (no in-memory draft)', () => {
    expect(dockTeamStatus({ target: session({ enabled: true, size: 4 }), workspace: { team: TEAM }, workspaceDefaults: true })).toEqual({ enabled: true, size: 4 });
    expect(dockTeamStatus({ target: session(), workspace: { team: TEAM }, workspaceDefaults: true })).toBeUndefined();
    expect(dockTeamStatus({ workspace: { team: TEAM }, workspaceDefaults: true })).toEqual({ enabled: true, size: 2 });
    expect(dockTeamStatus({ workspace: { team: { ...TEAM, enabled: false } }, workspaceDefaults: true })).toEqual({ enabled: false, size: 2 });
    expect(dockTeamStatus({ workspace: { team: TEAM }, workspaceDefaults: false })).toBeUndefined();
  });

  it('sends no team for a plain prompt (the host copies the default), a draft as it is, and merges a prompt team into the default', () => {
    expect(teamForNewSession({ workspaceTeam: TEAM, reviewed: false, taken: [], seed: 'w' })).toEqual({});
    expect(teamForNewSession({ draft: TEAM, reviewed: false, taken: [], seed: 'w' })).toEqual({ team: TEAM });
    const spec = teamSpecPreview('Do it:\nSubagent A:\n- Name: Zara Quinn\n- Role: Tester\n- Tugas: Write tests')!.spec;
    const merged = teamForNewSession({ workspaceTeam: TEAM, spec, reviewed: false, taken: [], seed: 'w' });
    expect('team' in merged && merged.team?.members.map(member => member.name)).toEqual(['Elena Vael', 'Theo Mark', 'Zara Quinn']);
    // A reviewed prompt team is the draft itself.
    expect(teamForNewSession({ draft: TEAM, workspaceTeam: undefined, spec, reviewed: true, taken: [], seed: 'w' })).toEqual({ team: TEAM });
  });

  it('mock host: saves the default, new sessions copy it (explicit wins, null disables) and copies are independent', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    expect(workspaceTeamSupported(agents)).toBe(true);
    const workspace = (await agents.getState()).workspaces[0]!;
    const state = await agents.saveWorkspaceTeam(workspace.id, TEAM);
    expect(state.workspaces[0]!.team?.members).toHaveLength(2);
    await expect(agents.saveWorkspaceTeam(workspace.id, { ...TEAM, members: [{ ...TEAM.members[0]!, models: ['nope'] }] })).rejects.toThrow(/allowed models/);

    const inherited = await agents.createSession(workspace.id);
    expect(inherited.team).toEqual({ enabled: true, size: 2 });
    expect((await agents.createSession(workspace.id, { team: null })).team).toBeUndefined();
    expect((await agents.createSession(workspace.id, { team: { ...TEAM, members: [TEAM.members[0]!] } })).team).toEqual({ enabled: true, size: 1 });

    const copy = (await agents.getSessionTeam(inherited.id))!;
    await agents.saveSessionTeam(inherited.id, { ...copy, enabled: false });
    expect((await agents.getState()).workspaces[0]!.team?.enabled).toBe(true);
    expect((await agents.saveWorkspaceTeam(workspace.id, null)).workspaces[0]!.team).toBeUndefined();
    expect((await agents.getSessionTeam(inherited.id))?.members).toHaveLength(2);
  });
});
