import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const active = new Set<AgentHostRuntime>();
afterEach(async () => { await Promise.all([...active].map(runtime => runtime.close())); active.clear(); });

type Link = { sessionId: string; revision: string; projectPath?: string; mode: 'automatic' | 'explicit' | 'unbound' | 'ambiguous' | 'invalid';
  workspaceId?: string; linkedWorkspaceId?: string; lockedWorkspaceId?: string; candidates: Array<{ workspaceId: string; name: string; root: string }>; reason?: string };
type LinkApi = {
  observedWorkspaceLink(sessionId: string): Promise<Link>;
  setObservedWorkspaceLink(sessionId: string, input: { revision: string; workspaceId: string | null }): Promise<unknown>;
  sessionContinuity(sessionId: string): Promise<{ canonicalId: string; handovers: unknown[] }>;
  previewHandover(sessionId: string, input: unknown): Promise<{ workspaceId?: string; targetSessionId?: string; reviewId: string }>;
  applyHandover(sessionId: string, input: { reviewId: string; operationId: string }): Promise<unknown>;
};
function linked(host: unknown) { return host as LinkApi; }

async function fixture() {
  const root = await temp('extalia-observed-workspace-');
  const data = path.join(root, 'data'), home = path.join(root, 'home');
  const project = path.join(root, 'project'), nested = path.join(project, 'nested'), secondary = path.join(root, 'secondary');
  await mkdir(nested, { recursive: true }); await mkdir(secondary); await mkdir(home);
  const sourceFile = path.join(home, '.codex', 'sessions', 'rollout.jsonl');
  await mkdir(path.dirname(sourceFile), { recursive: true });
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const meta = (cwd: string) => [
    { type: 'session_meta', payload: { id: sessionId, cwd, timestamp: '2026-01-01T00:00:00.000Z' } },
    { type: 'response_item', timestamp: '2026-01-01T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Workspace link fixture context' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(sourceFile, meta(nested));
  const open = () => createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000 });
  let runtime = await open(); active.add(runtime);
  const connectionState = await runtime.host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'http://fixture.example/v1',
    model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } });
  const connection = connectionState.connections[0]!;
  async function workspace(name: string, location: string, additionalProjectLocations?: string[]) {
    const state = await runtime.host.saveWorkspace({ name, projectLocation: location, ...(additionalProjectLocations ? { additionalProjectLocations } : {}),
      connectionId: connection.id, crossWorkspaceAccess: 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } });
    return state.workspaces.find(item => item.name === name)!;
  }
  async function relocate(workspaceId: string, location: string) {
    return runtime.host.saveWorkspace({ id: workspaceId, name: 'Relocated', projectLocation: location, connectionId: connection.id,
      crossWorkspaceAccess: 'read-only', permissions: { fileWrite: 'ask', commands: 'ask' } });
  }
  async function observe() {
    const scan = await runtime.host.scanImports(['codex']);
    const imported = await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
    return imported.sessions.find(session => session.observation?.nativeSessionId === sessionId)!;
  }
  return { root, data, home, project, nested, secondary, sessionId, sourceFile, meta, connection,
    get runtime() { return runtime; }, get host() { return runtime.host; }, workspace, relocate, observe,
    async restart() { await runtime.close(); active.delete(runtime); runtime = await open(); active.add(runtime); }, };
}

describe('observed workspace link host contract', () => {
  it('keeps same-folder ambiguity explicit and persists a user-selected workspace across restart', async () => {
    const f = await fixture(), one = await f.workspace('Workspace one', f.project), two = await f.workspace('Workspace two', f.project);
    const session = await f.observe(), api = linked(f.host);
    let link = await api.observedWorkspaceLink(session.id);
    expect(link).toMatchObject({ sessionId: session.id, mode: 'ambiguous', projectPath: f.nested });
    expect(link.revision).toMatch(/^[a-f0-9]{64}$/); expect(link.candidates.map(item => item.workspaceId)).toEqual(expect.arrayContaining([one.id, two.id]));
    await expect(api.setObservedWorkspaceLink(session.id, { revision: link.revision, workspaceId: 'missing-workspace' })).rejects.toThrow();
    await api.setObservedWorkspaceLink(session.id, { revision: link.revision, workspaceId: one.id });
    link = await api.observedWorkspaceLink(session.id);
    expect(link).toMatchObject({ mode: 'explicit', workspaceId: one.id, linkedWorkspaceId: one.id });
    await f.restart();
    const restarted = linked(f.host);
    link = await restarted.observedWorkspaceLink(session.id);
    expect(link).toMatchObject({ mode: 'explicit', workspaceId: one.id });
    expect((await f.host.getState()).sessions.find(item => item.id === session.id)?.observation?.nativeSessionId).toBe(f.sessionId);
    await restarted.setObservedWorkspaceLink(session.id, { revision: link.revision, workspaceId: null });
    expect(await restarted.observedWorkspaceLink(session.id)).toMatchObject({ mode: 'ambiguous' });
  });

  it('uses the deepest automatic match across secondary roots and refuses arbitrary unrelated workspaces', async () => {
    const f = await fixture(), outer = await f.workspace('Outer', f.project), deep = await f.workspace('Nested', f.nested), unused = path.join(f.root, 'unused');
    await mkdir(unused);
    const extra = await f.workspace('Secondary root', unused, [f.secondary]);
    const session = await f.observe(), api = linked(f.host);
    expect(await api.observedWorkspaceLink(session.id)).toMatchObject({ mode: 'automatic', workspaceId: deep.id });
    expect((await api.observedWorkspaceLink(session.id)).candidates.map(item => item.workspaceId)).toContain(outer.id);
    const revision = (await api.observedWorkspaceLink(session.id)).revision;
    await expect(api.setObservedWorkspaceLink(session.id, { revision, workspaceId: extra.id })).rejects.toThrow(/project|candidate|workspace/i);
    await writeFile(f.sourceFile, f.meta(f.secondary));
    const fromSecondary = await f.observe();
    expect(await api.observedWorkspaceLink(fromSecondary.id)).toMatchObject({ mode: 'automatic', workspaceId: extra.id });
    await writeFile(f.sourceFile, f.meta(path.join(f.root, 'outside')));
    const refreshed = await f.observe();
    expect((await api.observedWorkspaceLink(refreshed.id))).toMatchObject({ mode: 'unbound' });
  });

  it('invalidates stale compare-and-set revisions when source CWD changes', async () => {
    const f = await fixture(), first = await f.workspace('First', f.project), secondRoot = path.join(f.root, 'second');
    await mkdir(secondRoot); const second = await f.workspace('Second', secondRoot);
    const session = await f.observe(), api = linked(f.host), initial = await api.observedWorkspaceLink(session.id);
    await api.setObservedWorkspaceLink(session.id, { revision: initial.revision, workspaceId: first.id });
    const pinned = await api.observedWorkspaceLink(session.id);
    await writeFile(f.sourceFile, f.meta(secondRoot));
    const changed = await f.observe();
    expect(await api.observedWorkspaceLink(changed.id)).toMatchObject({ mode: 'invalid', reason: 'source-changed' });
    await expect(api.setObservedWorkspaceLink(changed.id, { revision: pinned.revision, workspaceId: second.id })).rejects.toThrow(/revision|changed|source/i);
    expect((await f.host.getState()).sessions.find(item => item.id === session.id)?.observation?.nativeSessionId).toBe(f.sessionId);
    expect(second.id).toBeTruthy();
  });

  it('locks workspace association after a continuity handover', async () => {
    const f = await fixture(), first = await f.workspace('First', f.project), second = await f.workspace('Second', f.project);
    const session = await f.observe(), api = linked(f.host), initial = await api.observedWorkspaceLink(session.id);
    await api.setObservedWorkspaceLink(session.id, { revision: initial.revision, workspaceId: first.id });
    const preview = await api.previewHandover(session.id, { target: { kind: 'native', connectionId: f.connection.id } });
    await api.applyHandover(session.id, { reviewId: preview.reviewId, operationId: 'workspace-scope-lock' });
    const locked = await api.observedWorkspaceLink(session.id);
    expect(locked).toMatchObject({ mode: 'explicit', workspaceId: first.id, lockedWorkspaceId: first.id });
    await expect(api.setObservedWorkspaceLink(session.id, { revision: locked.revision, workspaceId: second.id })).rejects.toThrow(/locked|continuity|handover/i);
    expect((await api.sessionContinuity(session.id)).handovers).toHaveLength(1);
  });

  it('invalidates links if the linked workspace root changes or the workspace is deleted', async () => {
    const f = await fixture(), root = await f.workspace('Original root', f.project), session = await f.observe(), api = linked(f.host);
    const link = await api.observedWorkspaceLink(session.id);
    expect(link).toMatchObject({ mode: 'automatic', workspaceId: root.id });
    await api.setObservedWorkspaceLink(session.id, { revision: link.revision, workspaceId: root.id });
    const relocated = path.join(f.root, 'relocated'); await mkdir(relocated);
    await f.relocate(root.id, relocated);
    expect(await api.observedWorkspaceLink(session.id)).toMatchObject({ mode: 'invalid', reason: 'workspace-changed' });
    await f.host.deleteWorkspace(root.id);
    expect(await api.observedWorkspaceLink(session.id)).toMatchObject({ mode: 'invalid' });
    expect((await f.host.getState()).sessions.find(item => item.id === session.id)?.observation?.nativeSessionId).toBe(f.sessionId);
  });

  it('rejects symlink escapes rather than accepting lexical containment', async () => {
    const f = await fixture(), workspace = await f.workspace('Symlink parent', f.project);
    const outside = path.join(f.root, 'outside'); await mkdir(outside);
    const escape = path.join(f.project, 'escape'); await symlink(outside, escape);
    await writeFile(f.sourceFile, f.meta(path.join(escape, 'child')));
    const session = await f.observe();
    expect(await linked(f.host).observedWorkspaceLink(session.id)).toMatchObject({ mode: 'unbound' });
    expect(workspace.id).toBeTruthy();
  });

  it('does not match a dangling symlink whose destination escapes the workspace', async () => {
    const f = await fixture(); await f.workspace('Owned root', f.project);
    const dangling = path.join(f.project, 'dangling');
    await symlink(path.join(f.root, 'outside-missing', 'project'), dangling);
    await writeFile(f.sourceFile, f.meta(path.join(dangling, 'child')));
    const session = await f.observe();
    expect(await linked(f.host).observedWorkspaceLink(session.id)).toMatchObject({ mode: 'unbound' });
    expect((await f.host.getState()).sessions.some(item => item.id === session.id)).toBe(true);
  });

  it('keeps cyclic symlink project paths unbound without crashing state or association reads', async () => {
    const f = await fixture(); await f.workspace('Owned root', f.project);
    const left = path.join(f.project, 'left'), right = path.join(f.project, 'right');
    await symlink(right, left); await symlink(left, right);
    await writeFile(f.sourceFile, f.meta(path.join(left, 'child')));
    const session = await f.observe();
    expect((await f.host.getState()).sessions.some(item => item.id === session.id)).toBe(true);
    expect(await linked(f.host).observedWorkspaceLink(session.id)).toMatchObject({ mode: 'unbound' });
  });

  it('invalidates an explicit association when the same raw CWD symlink is repointed', async () => {
    const f = await fixture(), workspace = await f.workspace('Owned root', f.project);
    const first = path.join(f.project, 'first'), second = path.join(f.project, 'second'), alias = path.join(f.project, 'alias');
    await mkdir(first); await mkdir(second); await symlink(first, alias);
    const rawCwd = path.join(alias, 'child');
    await writeFile(f.sourceFile, f.meta(rawCwd));
    const session = await f.observe(), api = linked(f.host), initial = await api.observedWorkspaceLink(session.id);
    expect(initial).toMatchObject({ mode: 'automatic', workspaceId: workspace.id });
    await api.setObservedWorkspaceLink(session.id, { revision: initial.revision, workspaceId: workspace.id });
    expect(await api.observedWorkspaceLink(session.id)).toMatchObject({ mode: 'explicit', workspaceId: workspace.id });
    await rm(alias); await symlink(second, alias);
    expect(await api.observedWorkspaceLink(session.id)).toMatchObject({ mode: 'invalid', reason: 'workspace-changed' });
    expect((await f.host.getState()).sessions.find(item => item.id === session.id)?.observation?.projectPath).toBe(rawCwd);
  });
});
