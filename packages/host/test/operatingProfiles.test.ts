import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../src/sessions.js';
import { createOperatingProfileStore } from '../src/operatingProfiles.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
const temp = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });
const team = { enabled: true, allowedModels: ['profile-model', 'explicit-model'], members: [{ id: 'member-one', name: 'Example Worker', role: 'Reviewer', models: ['profile-model'], soul: 'Individual worker style' }] };
async function fixture() {
  const root = await temp('extalia-operating-'), data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
  await mkdir(home); await mkdir(project);
  const requests: { messages: { role: string; content: string }[]; model: string }[] = [];
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: data, importHome: home, env: { EXTALIA_SECRET_STORE: 'memory', PATH: '', HERMES_MANAGED_DIR: path.join(root, 'unavailable') }, fetch: async (_url: string, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body))); return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } };
  let runtime = await createAgentHost(options); runtimes.push(runtime);
  const saveConnection = async (name: string) => (await runtime.host.saveConnection({ name, preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'base-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections.find(item => item.name === name)!;
  const first = await saveConnection('First'), second = await saveConnection('Second');
  const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: first.id, permissions: { fileWrite: 'ask', commands: 'ask' }, crossWorkspaceAccess: 'isolated' })).workspaces[0]!;
  return { root, data, project, first, second, workspace, requests, get runtime() { return runtime; }, get host() { return runtime.host; }, restart: async () => { await runtime.close(); runtime = await createAgentHost(options); runtimes.push(runtime); } };
}
async function idle(runtime: AgentHostRuntime) { for (let n = 0; n < 500 && runtime.isBusy(); n++) await new Promise(resolve => setTimeout(resolve, 5)); expect(runtime.isBusy()).toBe(false); }
describe('operating profile library and resolved sessions', () => {
  it('persists revision-checked bounded profiles without overwriting damaged stores', async () => {
    const directory = await temp(), store = createOperatingProfileStore(directory);
    const saved = await store.save({ name: 'Example', defaults: {} });
    const updated = await store.save({ ...saved, expectedRevision: saved.revision } as never).catch(() => undefined);
    // CRUD input excludes durable metadata rather than accepting a forged revision/timestamp.
    expect(updated).toBeUndefined();
    const next = await store.save({ id: saved.id, expectedRevision: saved.revision, name: 'Updated', defaults: {} });
    expect(next.revision).toBe(2); await expect(store.delete(saved.id, 1)).rejects.toThrow(/changed/);
    expect(await createOperatingProfileStore(directory).list()).toEqual([next]);
    await writeFile(path.join(directory, 'operating-profiles.json'), '{invalid');
    await expect(store.save({ name: 'Another', defaults: {} })).rejects.toThrow();
    expect(await readFile(path.join(directory, 'operating-profiles.json'), 'utf8')).toBe('{invalid');
  });
  it('bounds the persisted catalog and serializes stale optimistic updates', async () => {
    const store = createOperatingProfileStore(await temp());
    const first = await store.save({ name: 'Revision', defaults: {} });
    const updates = await Promise.allSettled(['One', 'Two'].map(name => store.save({ id: first.id, expectedRevision: first.revision, name, defaults: {} })));
    expect(updates.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(updates.filter(result => result.status === 'rejected')).toHaveLength(1);
    const bounded = createOperatingProfileStore(await temp());
    const defaults = { team: { enabled: false, allowedModels: [], members: [], goalDocument: { name: 'Goal', text: 'x'.repeat(60_000) } } };
    for (let index = 0; index < 8; index++) await bounded.save({ name: `Profile ${index}`, defaults });
    await expect(bounded.save({ name: 'Too much', defaults })).rejects.toThrow(/512 KiB/);
    expect(await bounded.list()).toHaveLength(8);
  });
  it('reconciles a committed create after a lost acknowledgement without duplicating or silently changing it', async () => {
    const directory = await temp(), store = createOperatingProfileStore(directory);
    const input = { createRequestId: '00000000-0000-4000-8000-000000000001', name: 'Idempotent', personality: 'Shared style', defaults: { lead: { soul: '' }, team: null } };
    const lostAcknowledgement = async () => { await store.save(input); throw new Error('Synthetic lost RPC acknowledgement'); };
    await expect(lostAcknowledgement()).rejects.toThrow(/lost RPC/);
    const bytes = await readFile(path.join(directory, 'operating-profiles.json'), 'utf8');
    const reopened = createOperatingProfileStore(directory);
    const replay = await reopened.save({ ...input, name: '  Idempotent  ' });
    expect(replay.id).toBe(`op_${input.createRequestId}`); expect(replay.revision).toBe(1);
    expect(await reopened.list()).toEqual([replay]);
    expect(await readFile(path.join(directory, 'operating-profiles.json'), 'utf8')).toBe(bytes);
    await expect(reopened.save({ ...input, personality: 'Changed after uncertainty' })).rejects.toThrow(/already saved a different profile/);
    expect(await readFile(path.join(directory, 'operating-profiles.json'), 'utf8')).toBe(bytes);
    const edited = await reopened.save({ id: replay.id, expectedRevision: 1, name: 'Edited', defaults: {} }); expect(edited.revision).toBe(2);
  });
  it('applies profile defaults, explicit choices and immutable per-session snapshots across restart', async () => {
    const h = await fixture();
    const profile = await h.host.saveOperatingProfile!({ name: 'Team preset', purpose: 'Shared purpose', personality: 'Shared personality', defaults: { connectionId: h.second.id, model: 'profile-model', lead: { role: 'Architect', soul: 'Own lead style' }, team } });
    const originalBoundary = h.workspace.crossWorkspaceAccess, vaultProfile = h.workspace.profileId;
    const state = await h.host.setWorkspaceOperatingProfile!(h.workspace.id, { profileId: profile.id });
    expect(state.workspaces[0]).toMatchObject({ providerProfileId: h.second.id, profileId: vaultProfile, crossWorkspaceAccess: originalBoundary, permissions: h.workspace.permissions, operatingProfileId: profile.id });
    const first = await h.host.createSession(h.workspace.id);
    expect(first.connectionId).toBe(h.second.id); expect(first.options?.model).toBe('profile-model'); expect(first.operatingProfile).toEqual({ id: profile.id, name: profile.name, revision: 1 });
    expect(JSON.stringify(first)).not.toContain('Own lead style');
    expect((await h.host.getSessionTeam(first.id))?.members[0]?.soul).toBe('Individual worker style');
    await h.host.saveOperatingProfile!({ id: profile.id, expectedRevision: 1, name: profile.name, personality: 'Edited background', defaults: { connectionId: h.first.id, model: 'new-model', lead: { soul: 'New lead' } } });
    expect((await h.host.getSessionOperatingProfile!(first.id))?.lead?.soul).toBe('Own lead style');
    const second = await h.host.createSession(h.workspace.id, { model: 'explicit-model', team: null, operatingProfile: { lead: { soul: '' } } });
    expect(second.connectionId).toBe(h.first.id); expect(second.options?.model).toBe('explicit-model'); expect(await h.host.getSessionTeam(second.id)).toBeUndefined();
    expect((await h.host.getSessionOperatingProfile!(second.id))?.lead?.soul).toBe('');
    await h.restart();
    expect((await h.host.getSessionOperatingProfile!(first.id))?.personality).toBe('Shared personality');
    expect((await h.host.listOperatingProfiles!())[0]?.revision).toBe(2);
    await h.host.sendPrompt(first.id, 'Write a short poem.'); await idle(h.runtime);
    expect(h.requests.at(-1)?.model).toBe('profile-model');
    expect(h.requests.at(-1)?.messages[0]?.content).toContain('Own lead style');
    expect(h.requests.at(-1)?.messages.at(-1)?.content).toBe('Write a short poem.');
    await expect(h.host.deleteOperatingProfile!(profile.id, 2)).rejects.toThrow(/workspaces/);
    await h.host.setWorkspaceOperatingProfile!(h.workspace.id, { profileId: null }); await h.host.deleteOperatingProfile!(profile.id, 2);
    expect((await h.host.getSessionOperatingProfile!(first.id))?.revision).toBe(1);
  });
  it('keeps inheritance on unrelated workspace edits and makes team/connection overrides explicit and resettable', async () => {
    const h = await fixture();
    const p = await h.host.saveOperatingProfile!({ name: 'Defaults', defaults: { connectionId: h.second.id, model: 'profile-model', team } });
    await h.host.setWorkspaceOperatingProfile!(h.workspace.id, { profileId: p.id });
    await h.host.saveWorkspace({ id: h.workspace.id, name: 'Renamed', projectLocation: h.project, connectionId: h.second.id, permissions: h.workspace.permissions! });
    let raw = JSON.parse(await readFile(path.join(h.data, 'config/extalia.json'), 'utf8'));
    expect(raw.workspaces[0].operatingProfileOverrides).toEqual({}); expect(raw.workspaces[0].providerProfileId).toBe(h.first.id);
    await h.host.saveWorkspaceTeam(h.workspace.id, null); expect((await h.host.getState()).workspaces[0]?.team).toBeUndefined();
    await h.host.setWorkspaceOperatingProfile!(h.workspace.id, { profileId: p.id, overrides: {} });
    expect((await h.host.getState()).workspaces[0]?.team?.members).toHaveLength(1);
    await h.host.saveWorkspace({ id: h.workspace.id, name: 'Renamed', projectLocation: h.project, connectionId: h.first.id, permissions: h.workspace.permissions! });
    raw = JSON.parse(await readFile(path.join(h.data, 'config/extalia.json'), 'utf8'));
    expect(raw.workspaces[0].operatingProfileOverrides.connectionId).toBe(h.first.id);
    const solo = await h.host.createSession(h.workspace.id, { team: null, model: 'explicit-model' }); expect(await h.host.getSessionTeam(solo.id)).toBeUndefined();
  });
  it('refuses missing connections, unsupported workspaces and malformed saved snapshots before a provider call', async () => {
    const h = await fixture();
    await expect(h.host.saveOperatingProfile!({ name: 'Missing', defaults: { connectionId: 'missing' } })).rejects.toThrow(/connection/i);
    const profile = await h.host.saveOperatingProfile!({ name: 'Valid', defaults: {} });
    const observed = (await h.host.saveWorkspace({ name: 'Observed', projectLocation: h.project, mode: 'observe', permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.mode === 'observe')!;
    await expect(h.host.setWorkspaceOperatingProfile!(observed.id, { profileId: profile.id })).rejects.toThrow(/Native/);
    const session = await h.host.createSession(h.workspace.id);
    await h.host.saveSessionOperatingProfile!(session.id, { lead: { soul: 'Individual' } });
    await h.runtime.close();
    const file = path.join(h.data, 'sessions', 'index.json');
    const records = JSON.parse(await readFile(file, 'utf8')); records.find((record: { id: string }) => record.id === session.id).operatingProfile = { personality: { invalid: 'shape' } }; await writeFile(file, JSON.stringify(records));
    await h.restart();
    await expect(h.host.sendPrompt(session.id, 'Hello')).rejects.toThrow(/invalid operating/); expect(h.requests).toEqual([]);
  });
  it('refuses a concurrent profile edit during session admission rather than mixing revisions', async () => {
    const h = await fixture();
    const p = await h.host.saveOperatingProfile!({ name: 'Admission', personality: 'Original', defaults: { connectionId: h.first.id, model: 'profile-model', team } });
    await h.host.setWorkspaceOperatingProfile!(h.workspace.id, { profileId: p.id });
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const original = SessionStore.prototype.list;
    const spy = vi.spyOn(SessionStore.prototype, 'list').mockImplementationOnce(async function(this: SessionStore) { entered(); await gate; return original.call(this); });
    const pending = h.host.createSession(h.workspace.id);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await reached;
    await h.host.saveOperatingProfile!({ id: p.id, expectedRevision: 1, name: p.name, personality: 'Changed', defaults: { connectionId: h.first.id, model: 'updated-model', team: null } });
    release();
    const result = await outcome; spy.mockRestore();
    expect('error' in result && result.error.message).toMatch(/defaults changed/);
    expect((await h.host.getState()).sessions).toEqual([]);
    const retry = await h.host.createSession(h.workspace.id);
    expect(retry.options?.model).toBe('updated-model'); expect(retry.operatingProfile?.revision).toBe(2); expect(await h.host.getSessionTeam(retry.id)).toBeUndefined();
  });
  it('validates actual explicit solo/model choices without requiring an unused inherited worker connection', async () => {
    const h = await fixture();
    const p = await h.host.saveOperatingProfile!({ name: 'Optional worker', defaults: { connectionId: h.first.id, model: 'profile-model', team: { ...team, connections: [{ connectionId: h.second.id, allowedModels: ['profile-model'] }], members: [{ ...team.members[0]!, connectionId: h.second.id }] } } });
    await h.host.setWorkspaceOperatingProfile!(h.workspace.id, { profileId: p.id });
    await h.host.deleteConnection(h.second.id);
    await expect(h.host.createSession(h.workspace.id)).rejects.toThrow(/connection/i);
    const solo = await h.host.createSession(h.workspace.id, { team: null, model: 'explicit-model' });
    expect(solo.options?.model).toBe('explicit-model'); expect(await h.host.getSessionTeam(solo.id)).toBeUndefined();
  });

  it('keeps existing prompt and Native memory admission independent of future persona edits', async () => {
    const h = await fixture();
    const p = await h.host.saveOperatingProfile!({ name: 'Background', personality: 'Original background', defaults: {} });
    await h.host.setWorkspaceOperatingProfile!(h.workspace.id, { profileId: p.id });
    const session = await h.host.createSession(h.workspace.id);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
    const original = SessionStore.prototype.list;
    const spy = vi.spyOn(SessionStore.prototype, 'list').mockImplementationOnce(async function(this: SessionStore) { entered(); await gate; return original.call(this); });
    const pending = h.host.sendPrompt(session.id, 'Write a short poem.');
    const outcome = pending.then(() => undefined, error => error);
    await reached;
    const saving = h.host.saveOperatingProfile!({ id: p.id, expectedRevision: 1, name: p.name, personality: 'Future background', defaults: {} });
    await expect(h.host.nativeMemoryList!(h.workspace.id, {})).resolves.toBeDefined();
    await saving; release(); expect(await outcome).toBeUndefined(); spy.mockRestore(); await idle(h.runtime);
    expect(h.requests.at(-1)?.messages[0]?.content).toContain('Original background');
    expect(h.requests.at(-1)?.messages[0]?.content).not.toContain('Future background');
    await h.host.saveSessionOperatingProfile!(session.id, { lead: { role: 'Lead', soul: 'Custom' } });
    await h.host.saveSessionOperatingProfile!(session.id, { lead: { role: 'Lead' } });
    expect((await h.host.getSessionOperatingProfile!(session.id))?.lead).toEqual({ role: 'Lead' });
  });

});
