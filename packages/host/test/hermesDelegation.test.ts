import { createAgentHost } from '../src/service.js';
import { assertHermesTeamCapacity, type AgentTeam } from '@extalia/core';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hermesDelegationLimits } from '../src/hermesDelegation.js';
import type * as HermesDelegationModule from '../src/hermesDelegation.js';
import { hermesEnvironment } from '../src/hermes.js';
import { type AgentHostRuntime } from '../src/service.js';
import { mockModelDiscovery } from './modelDiscoveryFixture.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
const profileReads = vi.hoisted(() => ({ afterRead: undefined as ((profile: string) => Promise<void>) | undefined }));
vi.mock('../src/hermesDelegation.js', async importOriginal => {
  const actual = await importOriginal<typeof HermesDelegationModule>();
  return { ...actual, hermesDelegationLimits: async (...args: Parameters<typeof actual.hermesDelegationLimits>) => {
    const limits = await actual.hermesDelegationLimits(...args);
    await profileReads.afterRead?.(args[2]);
    return limits;
  } };
});
afterEach(async () => { profileReads.afterRead = undefined; while (runtimes.length) await runtimes.pop()!.close(); });

function holdProfileRead(profile: string) {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let held = false;
  profileReads.afterRead = async current => { if (current === profile && !held) { held = true; entered(); await waiting; } };
  return { started, release };
}

async function fixture(files: Record<string, string> = {}) {
  const home = await tempDir();
  const root = path.join(home, '.hermes');
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  const env = { HERMES_MANAGED_DIR: path.join(home, 'no-managed-scope') };
  return { home, root, env };
}

function team(size: number): AgentTeam {
  return { enabled: true, allowedModels: [], members: Array.from({ length: size }, (_, index) => ({ id: `m-${index}`, name: `Member ${index}`, role: 'Reviewer', models: [] })) };
}

describe('selected Hermes profile delegation limits', () => {
  it.each([[2, 2], [6, 6], [0, 32], [1, 1], [99, 32]])('resolves oneshot %s to the Extalia roster ceiling %s', async (configured, expected) => {
    const { env, home } = await fixture({ 'config.yaml': `delegation:\n  oneshot_max_children: ${configured}\n  max_concurrent_children: 1\n  model: vendor/shared-worker\n` });
    const limits = await hermesDelegationLimits(env, home, 'default', 'vendor/lead');
    expect(limits).toEqual({ profile: 'default', maxTeamMembers: expected, oneshotMaxChildren: configured, maxConcurrentChildren: 1, workerModel: 'vendor/shared-worker', workerModelSource: 'delegation', modelRouting: 'shared', source: 'profile' });
    expect(() => assertHermesTeamCapacity(team(expected), limits)).not.toThrow();
    expect(() => assertHermesTeamCapacity(team(expected + 1), limits)).toThrow(`at most ${expected}`);
  });

  it('uses conservative defaults for missing keys and a missing default config', async () => {
    const { env, home, root } = await fixture();
    expect(await hermesDelegationLimits(env, home, 'default')).toMatchObject({ oneshotMaxChildren: 2, maxTeamMembers: 2, maxConcurrentChildren: 10, source: 'defaults' });
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'config.yaml'), 'model:\n  default: vendor/default-lead\ndelegation: {}\n');
    expect(await hermesDelegationLimits(env, home, 'default')).toMatchObject({ workerModel: 'vendor/default-lead', workerModelSource: 'lead', maxTeamMembers: 2 });
    expect(await hermesDelegationLimits(env, home, 'default', 'vendor/session-lead')).toMatchObject({ workerModel: 'vendor/session-lead', workerModelSource: 'lead' });
  });

  it('honors YAML anchors and merge keys used by Hermes safe YAML loading', async () => {
    const { env, home } = await fixture({ 'config.yaml': 'limits: &limits\n  oneshot_max_children: 1\n  max_concurrent_children: 1\ndelegation:\n  <<: *limits\n  model: vendor/shared-worker\n' });
    expect(await hermesDelegationLimits(env, home, 'default')).toMatchObject({ maxTeamMembers: 1, maxConcurrentChildren: 1, workerModel: 'vendor/shared-worker' });
  });

  it.each(['delegation: { oneshot_max_children: 012 }', 'delegation: { oneshot_max_children: 0o6 }', 'limits: &limits { oneshot_max_children: 012 }\ndelegation: { <<: *limits }', 'limits: &limits { max_concurrent_children: 0o6 }\ndelegation: { <<: *limits }', 'delegation: { oneshot_max_children: 1e2 }', 'delegation: { oneshot_max_children: 0x6 }'])('refuses ambiguous YAML numeric spellings before they can widen a Hermes budget (%s)', async text => {
    const { env, home } = await fixture({ 'config.yaml': text });
    await expect(hermesDelegationLimits(env, home, 'default')).rejects.toThrow(/must be a non-negative integer/);
  });

  it('never inherits default-profile limits, models or dotenv into a named profile', async () => {
    const { env, home, root } = await fixture({ 'config.yaml': 'delegation: { oneshot_max_children: 6, model: vendor/default-worker }\n', '.env': 'DELEGATION_MAX_CONCURRENT_CHILDREN=8\n', 'profiles/lab/config.yaml': 'model: vendor/lab-lead\n' });
    expect(await hermesDelegationLimits(env, home, 'lab')).toMatchObject({ profile: 'lab', oneshotMaxChildren: 2, maxConcurrentChildren: 10, workerModel: 'vendor/lab-lead' });
    const selected = { ...env, HERMES_HOME: path.join(root, 'profiles', 'lab') };
    expect(await hermesDelegationLimits(selected, home, 'default')).toMatchObject({ maxTeamMembers: 6, workerModel: 'vendor/default-worker' });
    expect(await hermesDelegationLimits(selected, home, 'lab')).toMatchObject({ maxTeamMembers: 2, workerModel: 'vendor/lab-lead' });
  });

  it('uses config before selected dotenv before inherited environment, with a batch floor of one', async () => {
    const { env, home, root } = await fixture({ 'config.yaml': 'delegation: { oneshot_max_children: 6, max_concurrent_children: 4 }\n', '.env': 'DELEGATION_MAX_CONCURRENT_CHILDREN=3\nPRIVATE_TOKEN=PRIVATE_FIXTURE_VALUE\nDELEGATION_MAX_CONCURRENT_CHILDREN=2\n' });
    const environment = { ...env, DELEGATION_MAX_CONCURRENT_CHILDREN: '8' };
    expect(hermesEnvironment(environment).DELEGATION_MAX_CONCURRENT_CHILDREN).toBe('8');
    expect(await hermesDelegationLimits(environment, home, 'default')).toMatchObject({ maxConcurrentChildren: 4 });
    await writeFile(path.join(root, 'config.yaml'), 'delegation: { oneshot_max_children: 6 }\n');
    const limits = await hermesDelegationLimits(environment, home, 'default');
    expect(limits.maxConcurrentChildren).toBe(2);
    expect(JSON.stringify(limits)).not.toMatch(/PRIVATE_FIXTURE_VALUE|PRIVATE_TOKEN/);
    await writeFile(path.join(root, '.env'), '');
    expect(await hermesDelegationLimits(environment, home, 'default')).toMatchObject({ maxConcurrentChildren: 8 });
    expect(await hermesDelegationLimits({ ...environment, DELEGATION_MAX_CONCURRENT_CHILDREN: '0' }, home, 'default')).toMatchObject({ maxConcurrentChildren: 1 });
    await writeFile(path.join(root, '.env'), 'DELEGATION_MAX_CONCURRENT_CHILDREN=""\n');
    expect(await hermesDelegationLimits({ ...environment, DELEGATION_MAX_CONCURRENT_CHILDREN: '20' }, home, 'default')).toMatchObject({ maxConcurrentChildren: 10 });
    await writeFile(path.join(root, '.env'), 'DELEGATION_MAX_CONCURRENT_CHILDREN="${DELEGATION_MAX_CONCURRENT_CHILDREN}" # inherited\n');
    await writeFile(path.join(root, 'config.yaml'), 'delegation: { oneshot_max_children: "${DELEGATION_MAX_CONCURRENT_CHILDREN}" }\n');
    expect(await hermesDelegationLimits(environment, home, 'default')).toMatchObject({ oneshotMaxChildren: 8 });
  });

  it.each(['delegation: [', 'delegation: [1, 2]', 'delegation: 2026-01-01', 'delegation: { oneshot_max_children: nope }', 'delegation: { oneshot_max_children: -1 }', 'delegation: { oneshot_max_children: 1.5 }', 'delegation: { oneshot_max_children: true }', 'delegation: { max_concurrent_children: nope }'])('rejects invalid configuration without echoing content (%s)', async text => {
    const { env, home } = await fixture({ 'config.yaml': `${text}\n# PRIVATE_FIXTURE_VALUE\n` });
    await expect(hermesDelegationLimits(env, home, 'default')).rejects.toThrow(/Cannot read delegation limits/);
    try { await hermesDelegationLimits(env, home, 'default'); } catch (cause) { expect(String(cause)).not.toContain('PRIVATE_FIXTURE_VALUE'); }
  });

  it('rejects missing, deleted and unreadable named profiles and bounded-read violations', async () => {
    const { env, home, root } = await fixture({ 'profiles/deleted/config.yaml': '{}', 'profiles/unreadable/.env': '', 'profiles/large/config.yaml': '#'.repeat(1024 * 1024 + 1) });
    await mkdir(path.join(root, 'profiles', '.deleted'), { recursive: true });
    await writeFile(path.join(root, 'profiles', '.deleted', 'deleted'), 'deleted');
    await mkdir(path.join(root, 'profiles', 'unreadable', 'config.yaml'));
    for (const profile of ['missing', 'deleted', 'unreadable', 'large']) await expect(hermesDelegationLimits(env, home, profile)).rejects.toThrow(/Cannot read delegation limits/);
    await expect(hermesDelegationLimits(env, home, '../outside')).rejects.toThrow('Unknown Hermes profile.');
  });

  it('applies selected managed leaves and exposes only custom-routing capability', async () => {
    const { env, home, root } = await fixture({ 'config.yaml': 'delegation: { oneshot_max_children: 6, model: vendor/shared-worker }\n' });
    const managed = path.join(root, 'managed');
    await mkdir(managed);
    await writeFile(path.join(managed, 'config.yaml'), 'delegation: { oneshot_max_children: 1, backend: custom-routing }\n');
    await writeFile(path.join(managed, '.env'), 'DELEGATION_MAX_CONCURRENT_CHILDREN=2\n');
    const limits = await hermesDelegationLimits({ ...env, HERMES_MANAGED_DIR: managed }, home, 'default');
    expect(limits).toMatchObject({ maxTeamMembers: 1, maxConcurrentChildren: 2, source: 'managed', modelRouting: 'profile-custom' });
    expect(limits.workerModel).toBeUndefined();
    expect(JSON.stringify(limits)).not.toContain('custom-routing');
  });

  it('expands managed references after the selected profile and managed dotenv overrides', async () => {
    const { env, home, root } = await fixture({ 'config.yaml': 'delegation: { oneshot_max_children: 6 }\n', '.env': 'DELEGATION_MAX_CONCURRENT_CHILDREN=1\n' });
    const managed = path.join(root, 'managed');
    await mkdir(managed);
    await writeFile(path.join(managed, 'config.yaml'), 'delegation: { oneshot_max_children: "${DELEGATION_MAX_CONCURRENT_CHILDREN}" }\n');
    const environment = { ...env, HERMES_MANAGED_DIR: managed, DELEGATION_MAX_CONCURRENT_CHILDREN: '6' };
    expect(await hermesDelegationLimits(environment, home, 'default')).toMatchObject({ oneshotMaxChildren: 1, maxTeamMembers: 1, maxConcurrentChildren: 1 });
    await writeFile(path.join(managed, '.env'), 'DELEGATION_MAX_CONCURRENT_CHILDREN=2\n');
    expect(await hermesDelegationLimits(environment, home, 'default')).toMatchObject({ oneshotMaxChildren: 2, maxTeamMembers: 2, maxConcurrentChildren: 2 });
  });
});

async function setup() {
  const context = await fixture({ 'config.yaml': 'model: vendor/lead\ndelegation: { oneshot_max_children: 6, model: vendor/shared-worker }\n', 'profiles/lower/config.yaml': 'delegation: { oneshot_max_children: 1 }\n' });
  const project = path.join(context.home, 'project');
  await mkdir(project);
  const requests: string[] = [];
  const runtime = await createAgentHost({ kind: 'bridge', version: '0.0.0-test', dataDirectory: path.join(context.home, 'data'), importHome: context.home,
    env: { ...context.env, EXTALIA_SECRET_STORE: 'memory', PATH: '' }, fetch: async input => { requests.push(String(input)); throw new Error('Unexpected model request'); }, modelDiscovery: mockModelDiscovery(async input => { requests.push(String(input)); throw new Error('Unexpected model request'); }) });
  runtimes.push(runtime);
  const state = await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'default', permissions: { fileWrite: 'ask', commands: 'ask' } });
  return { ...context, host: runtime.host, workspace: state.workspaces[0]!, project, requests };
}

describe('host fresh Hermes team admission', () => {
  it('serializes a profile switch behind an admitted workspace roster and revalidates it', async () => {
    const { host, workspace, project } = await setup();
    const gate = holdProfileRead('default');
    const savingTeam = host.saveWorkspaceTeam(workspace.id, team(6));
    await gate.started;
    const switching = host.saveWorkspace({ id: workspace.id, name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'lower', permissions: { fileWrite: 'ask', commands: 'ask' } })
      .then(() => undefined, (error: Error) => error);
    try { await new Promise(resolve => setTimeout(resolve, 30)); } finally { gate.release(); }
    await savingTeam;
    expect(await switching).toMatchObject({ message: expect.stringContaining('at most 1') });
    const saved = (await host.getState()).workspaces.find(item => item.id === workspace.id)!;
    expect(saved.runtimeProfileId).toBe('default');
    expect(saved.team?.members).toHaveLength(6);
  });

  it('serializes roster saving behind a profile switch without overwriting the saved team snapshot', async () => {
    const { host, workspace, project } = await setup();
    await host.saveWorkspaceTeam(workspace.id, team(1));
    const gate = holdProfileRead('lower');
    const switching = host.saveWorkspace({ id: workspace.id, name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'lower', permissions: { fileWrite: 'ask', commands: 'ask' } });
    await gate.started;
    const savingTeam = host.saveWorkspaceTeam(workspace.id, team(6)).then(() => undefined, (error: Error) => error);
    try { await new Promise(resolve => setTimeout(resolve, 30)); } finally { gate.release(); }
    await switching;
    expect(await savingTeam).toMatchObject({ message: expect.stringContaining('at most 1') });
    const saved = (await host.getState()).workspaces.find(item => item.id === workspace.id)!;
    expect(saved.runtimeProfileId).toBe('lower');
    expect(saved.team?.members).toHaveLength(1);
  });

  it('accepts six members, then refuses lowered limits before persistence or inference', async () => {
    const { host, workspace, root, requests } = await setup();
    await host.saveWorkspaceTeam(workspace.id, team(6));
    const session = await host.createSession(workspace.id);
    expect(session.team?.size).toBe(6);
    expect((await host.modelChoices(workspace.id, session.id)).hermesDelegation).toMatchObject({ maxTeamMembers: 6, workerModel: 'vendor/shared-worker' });
    const originalTeam = await host.getSessionTeam(session.id);
    await writeFile(path.join(root, 'config.yaml'), 'delegation: { oneshot_max_children: 1 }\n');
    expect((await host.modelChoices(workspace.id, session.id)).hermesDelegation?.maxTeamMembers).toBe(1);
    const before = await host.getState();
    await expect(host.saveWorkspaceTeam(workspace.id, team(2))).rejects.toThrow(/at most 1/);
    await expect(host.createSession(workspace.id)).rejects.toThrow(/at most 1/);
    await expect(host.saveSessionTeam(session.id, team(2))).rejects.toThrow(/at most 1/);
    await expect(host.sendPrompt(session.id, 'Review the code')).rejects.toThrow(/at most 1/);
    await expect(host.sendPrompt(session.id, 'Subagent 1:\nRole: Reviewer\nSubagent 2:\nRole: Writer')).rejects.toThrow(/at most 1/);
    await expect(host.planTeam(workspace.id, { count: 2, goal: 'Review code', allowedModels: [] }, session.id)).rejects.toThrow(/at most 1/);
    expect(await host.getSessionTeam(session.id)).toEqual(originalTeam);
    expect((await host.getState()).workspaces).toEqual(before.workspaces);
    expect((await host.getState()).sessions).toEqual(before.sessions);
    expect(requests).toEqual([]);
  });

  it('targets saved session profiles for metadata, saves, sends and planning after workspace changes', async () => {
    const { host, workspace, project, root } = await setup();
    const session = await host.createSession(workspace.id, { team: team(6), model: 'vendor/session-lead' });
    await host.saveWorkspace({ id: workspace.id, name: 'Project', projectLocation: project, runtimeId: 'hermes', runtimeProfileId: 'lower', permissions: { fileWrite: 'ask', commands: 'ask' } });
    expect((await host.modelChoices(workspace.id)).hermesDelegation).toMatchObject({ profile: 'lower', maxTeamMembers: 1 });
    expect((await host.modelChoices(workspace.id, session.id)).hermesDelegation).toMatchObject({ profile: 'default', maxTeamMembers: 6 });
    await expect(host.saveSessionTeam(session.id, team(6))).resolves.toMatchObject({ members: expect.any(Array) });
    await expect(host.planTeam(workspace.id, { count: 6, goal: '', allowedModels: [] })).rejects.toThrow(/at most 1/);
    await expect(host.planTeam(workspace.id, { count: 6, goal: '', allowedModels: [] }, session.id)).resolves.toMatchObject({ members: expect.any(Array) });
    await writeFile(path.join(root, 'config.yaml'), 'delegation: { oneshot_max_children: 1 }\n');
    await expect(host.sendPrompt(session.id, 'Review')).rejects.toThrow(/at most 1/);
    expect((await host.modelChoices(workspace.id, session.id)).hermesDelegation).toMatchObject({ workerModel: 'vendor/session-lead', workerModelSource: 'lead' });
  });

  it('rejects invalid profiles and custom delegation before an enabled roster can be saved', async () => {
    const { host, workspace, root, requests } = await setup();
    const session = await host.createSession(workspace.id);
    for (const config of ['delegation: [', 'delegation: { oneshot_max_children: 6, backend: custom-routing }']) {
      await writeFile(path.join(root, 'config.yaml'), config);
      await expect(host.saveSessionTeam(session.id, team(2))).rejects.toThrow(/delegation|shared worker model/);
      await expect(host.createSession(workspace.id, { team: team(2) })).rejects.toThrow(/delegation|shared worker model/);
      await expect(host.planTeam(workspace.id, { count: 2, goal: '', allowedModels: [] })).rejects.toThrow(/delegation|shared worker model/);
      expect(await host.getSessionTeam(session.id)).toBeUndefined();
    }
    expect(requests).toEqual([]);
  });

  it('does not apply Hermes limits or broken profile errors to Native sessions', async () => {
    const { host, workspace, root, project } = await setup();
    await writeFile(path.join(root, 'config.yaml'), 'delegation: [');
    await expect(host.createSession(workspace.id)).rejects.toThrow(/Cannot read delegation limits/);
    const state = await host.saveConnection({ name: 'Example', preset: 'custom', api: 'openai-chat', baseUrl: 'https://provider.example.com/v1', model: 'vendor/native', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const native = await host.saveWorkspace({ name: 'Native', projectLocation: project, connectionId: state.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
    const nativeWorkspace = native.workspaces.find(item => item.runtimeId !== 'hermes')!;
    const session = await host.createSession(nativeWorkspace.id, { team: team(6) });
    expect(session.team?.size).toBe(6);
    expect((await host.modelChoices(nativeWorkspace.id, session.id)).hermesDelegation).toBeUndefined();
  });
});
