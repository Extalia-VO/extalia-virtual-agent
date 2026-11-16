import type { AgentTeam, OperatingProfile } from '@extalia/core';
import { describe, expect, it } from 'vitest';
import { profileDraft, profileInput, workspaceProfileInput } from '../src/operatingProfiles/profileDraft';
import { createMockPlatform } from '../src/host/mockHost';

const team: AgentTeam = { enabled: true, allowedModels: ['model-a'], members: [
  { id: 'reviewer', name: 'Example Reviewer', role: 'Reviewer', models: ['model-a'], soul: 'Check evidence before deciding.' },
] };
const stamp = '2026-01-01T00:00:00.000Z';
const profile: OperatingProfile = { id: 'op_example', name: 'Review team', revision: 2, createdAt: stamp, updatedAt: stamp,
  purpose: 'Improve a product', personality: 'Be concise', defaults: { model: 'model-a', team, lead: { role: 'Lead' } } };

describe('operating profile editor state', () => {
  it('preserves revision, individually configured agents and inheritance without mutating saved values', () => {
    const draft = profileDraft(profile);
    expect(draft.inheritPersonality).toBe(true);
    const input = profileInput(draft);
    expect(input).toMatchObject({ id: profile.id, expectedRevision: 2, purpose: profile.purpose, defaults: { model: 'model-a', lead: { role: 'Lead' }, team } });
    expect(input.defaults.lead).not.toHaveProperty('soul');
    draft.team!.members[0]!.soul = 'Custom instructions';
    expect(profile.defaults.team!.members[0]!.soul).toBe('Check evidence before deciding.');
  });
  it('distinguishes an empty custom lead personality, inherited team and explicitly solo setup', () => {
    const draft = { ...profileDraft(profile), inheritPersonality: false, leadSoul: '', team: null };
    expect(profileInput(draft).defaults).toMatchObject({ lead: { soul: '' }, team: null });
    expect(profileInput({ ...draft, team: undefined }).defaults).not.toHaveProperty('team');
    expect(() => profileInput({ ...draft, model: 'not a valid model' })).toThrow(/model/i);
    expect(() => profileInput({ ...draft, name: '' })).toThrow(/name/i);
  });
  it('keeps unrelated project edits from pinning a changed inherited connection, while preserving intentional choices', () => {
    const workspace = { id: 'w_example', profileId: 'default', operatingProfileId: profile.id, name: 'Example project', providerProfileId: 'c_new', createdAt: stamp, updatedAt: stamp };
    const input = { id: workspace.id, name: 'Renamed project', projectLocation: '/example/project', connectionId: 'c_old', permissions: { fileWrite: 'ask' as const, commands: 'ask' as const } };
    expect(workspaceProfileInput(input, workspace, false)).toEqual({ ...input, connectionId: 'c_new' });
    expect(workspaceProfileInput(input, workspace, true)).toBe(input);
    expect(input.connectionId).toBe('c_old');
    expect(workspaceProfileInput(input, undefined, false)).toBe(input);
  });
  it('keeps one creation ID for a new draft and omits it for revision-bound edits', () => {
    const draft = { ...profileDraft(), name: 'A reusable team' };
    expect(draft.createRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(profileInput(draft).createRequestId).toBe(draft.createRequestId);
    expect(profileInput({ ...draft, purpose: 'A new description' }).createRequestId).toBe(draft.createRequestId);
    expect(profileInput(profileDraft(profile))).not.toHaveProperty('createRequestId');
  });
});

describe('development operating profile flows', () => {
  it('retries a committed creation with a lost response without creating a second profile', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const input = profileInput({ ...profileDraft(), name: 'Stable creation' });
    const save = agents.saveOperatingProfile!.bind(agents);
    let first = true;
    const uncertainSave = async () => { const saved = await save(input); if (first) { first = false; throw new Error('The response was lost.'); } return saved; };
    await expect(uncertainSave()).rejects.toThrow(/response was lost/);
    const retried = await uncertainSave();
    expect(await agents.listOperatingProfiles!()).toEqual([retried]); expect(retried.revision).toBe(1);
    await expect(save({ ...input, name: 'Different draft' })).rejects.toThrow(/differs/);
    expect(await agents.listOperatingProfiles!()).toHaveLength(1);
  });
  it('creates, assigns, overrides, resets and deletes a reusable profile while existing sessions retain snapshots', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge' }).capabilities.agents!;
    const state = await agents.getState(), workspace = state.workspaces[0]!, connection = state.connections[0]!;
    const first = await agents.saveOperatingProfile!({ name: 'Product team', purpose: 'Build carefully', personality: 'Use evidence', defaults: { connectionId: connection.id, model: connection.model, team } });
    const assigned = await agents.setWorkspaceOperatingProfile!(workspace.id, { profileId: first.id, overrides: {} });
    expect(assigned.workspaces[0]).toMatchObject({ operatingProfileId: first.id, team });
    const old = await agents.createSession(workspace.id);
    expect(old.operatingProfile).toEqual({ id: first.id, name: first.name, revision: 1 });
    expect(old.operatingProfile).not.toHaveProperty('personality');
    const second = await agents.saveOperatingProfile!({ id: first.id, expectedRevision: 1, name: first.name, purpose: 'Build the next version', personality: 'Explain clearly', defaults: { ...first.defaults, team: null } });
    const current = await agents.createSession(workspace.id);
    expect((await agents.getSessionOperatingProfile!(old.id))?.personality).toBe('Use evidence');
    expect((await agents.getSessionOperatingProfile!(current.id))?.personality).toBe('Explain clearly');
    expect(await agents.getSessionTeam(old.id)).toMatchObject(team);
    expect(await agents.getSessionTeam(current.id)).toBeUndefined();
    await expect(agents.saveOperatingProfile!({ id: first.id, expectedRevision: 1, name: 'Stale', defaults: {} })).rejects.toThrow(/changed/i);
    await agents.saveWorkspaceTeam(workspace.id, team);
    expect((await agents.getState()).workspaces[0]?.operatingProfileOverrides?.team).toMatchObject(team);
    const reset = await agents.setWorkspaceOperatingProfile!(workspace.id, { profileId: first.id, overrides: {} });
    expect(reset.workspaces[0]?.team).toBeUndefined();
    await expect(agents.deleteOperatingProfile!(first.id, second.revision)).rejects.toThrow(/assignments/i);
    await agents.setWorkspaceOperatingProfile!(workspace.id, { profileId: null });
    await agents.deleteOperatingProfile!(first.id, second.revision);
    expect(await agents.listOperatingProfiles!()).toEqual([]);
    expect((await agents.getSessionOperatingProfile!(old.id))?.revision).toBe(1);
  });
  it('replaces individual lead settings and rejects unsupported or active session edits', async () => {
    const agents = createMockPlatform({ seed: 'ready', host: 'bridge', hermes: true }).capabilities.agents!;
    const state = await agents.getState(), workspace = state.workspaces[0]!;
    const created = await agents.createSession(workspace.id);
    await agents.saveSessionOperatingProfile!(created.id, { lead: { role: 'Reviewer', soul: 'Custom style' } });
    expect(await agents.saveSessionOperatingProfile!(created.id, { lead: { role: 'Lead' } })).toMatchObject({ lead: { role: 'Lead' } });
    expect((await agents.getSessionOperatingProfile!(created.id))?.lead).not.toHaveProperty('soul');
    await expect(agents.setWorkspaceOperatingProfile!(state.workspaces.find(item => item.runtimeId === 'hermes')!.id, { profileId: null })).rejects.toThrow(/Native/i);
    await agents.sendPrompt(created.id, 'Review the tests');
    await expect(agents.saveSessionOperatingProfile!(created.id, { lead: {} })).rejects.toThrow(/Finish/i);
    await agents.cancel(created.id);
  });
});
