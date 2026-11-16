import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveGeneralScheduleInput } from '@extalia/platform';
import { createAgentHost } from '../src/service.js';
import { SessionStore } from '../src/sessions.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length) await cleanup.pop()!();
});

async function fixture(api: 'openai-chat' | 'anthropic-messages' = 'openai-chat') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'extalia-schedule-safety-')));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), project = path.join(root, 'project'), other = path.join(root, 'other');
  await Promise.all([home, project, other].map(folder => mkdir(folder)));
  const data = path.join(root, 'data');
  const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: 'Unexpected scheduled inference.' }, finish_reason: 'stop' }] }));
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { PATH: '', EXTALIA_SECRET_STORE: 'memory' }, observationIntervalMs: 60_000, fetch: async (_input, init) => init?.method === 'HEAD' ? new Response(null, { status: 204 }) : fetch() });
  cleanup.push(() => runtime.close());
  const host = runtime.host;
  const connectionInput = { name: 'Fixture', preset: 'custom' as const, api, baseUrl: 'https://example.com/v1', model: 'fixture-model',
    credential: { kind: 'none' as const }, features: { memory: 'off' as const, skills: 'off' as const, history: true } };
  const connectionId = (await host.saveConnection(connectionInput)).connections[0]!.id;
  const workspaceInput = { connectionId, crossWorkspaceAccess: 'read-only' as const, permissions: { fileWrite: 'allow' as const, commands: 'ask' as const } };
  const workspaceId = (await host.saveWorkspace({ ...workspaceInput, name: 'Project', projectLocation: project })).workspaces[0]!.id;
  const otherWorkspaceId = (await host.saveWorkspace({ ...workspaceInput, name: 'Other', projectLocation: other })).workspaces.find(item => item.id !== workspaceId)!.id;
  const store = new SessionStore(path.join(data, 'sessions'));
  const save = async (sessionTarget: SaveGeneralScheduleInput['sessionTarget'], assignment?: SaveGeneralScheduleInput['assignment']) => {
    const catalog = await host.saveSchedule!({ workspaceId, name: 'Repository review', prompt: 'Review the current project.', enabled: false,
      trigger: { kind: 'interval', intervalMinutes: 60 }, sessionTarget, ...(assignment ? { assignment } : {}) });
    return catalog.schedules[0]!;
  };
  return { host, fetch, store, workspaceId, otherWorkspaceId, connectionId, connectionInput, save };
}

describe('scheduled host execution safety', () => {
  it('refuses inference when the requested permission/model patch can no longer be applied', async () => {
    const f = await fixture('anthropic-messages');
    const session = await f.host.createSession(f.workspaceId, { permissionMode: 'accept-edits' });
    const schedule = await f.save({ mode: 'existing', sessionId: session.id }, {
      teamMode: 'workspace', leadModel: 'alternate-model', permissionMode: 'plan', leadEffort: 'high',
    });
    // The saved assignment was valid, but the connection changed before execution.
    await f.host.saveConnection({ ...f.connectionInput, id: f.connectionId, api: 'openai-chat' });
    await expect(f.host.runScheduleNow!(schedule.id, schedule.revision)).rejects.toThrow(/reasoning effort/);
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.store.get(session.id))?.options).toMatchObject({ permissionMode: 'accept-edits' });
    expect(await f.store.readMessages(session.id)).toEqual([]);
    expect((await f.host.listSchedules!()).schedules[0]).toMatchObject({ lastOutcome: 'failed', runCount: 0 });
  });

  it.each(['missing', 'foreign', 'stale-boundary'] as const)('rejects a %s derivation source without creating a substitute session', async change => {
    const f = await fixture();
    const source = await f.host.createSession(f.workspaceId);
    await f.store.writeMessages(source.id, [{ role: 'user', text: 'Keep this source conversation.' }]);
    const schedule = await f.save({ mode: 'derive-from-session', sourceSessionId: source.id });
    if (change === 'missing') await f.host.deleteSession(source.id);
    else if (change === 'foreign') await f.store.update(source.id, { workspaceId: f.otherWorkspaceId });
    else await f.store.update(source.id, { workspaceBoundary: 'obsolete-workspace-boundary' });
    const before = (await f.store.list()).map(item => item.id).sort();
    await expect(f.host.runScheduleNow!(schedule.id, schedule.revision)).rejects.toThrow();
    expect((await f.store.list()).map(item => item.id).sort()).toEqual(before);
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.host.listSchedules!()).schedules[0]).toMatchObject({ lastOutcome: 'failed', runCount: 0 });
  });

  it('does not replace unreadable source history with an empty conversation', async () => {
    const f = await fixture();
    const source = await f.host.createSession(f.workspaceId);
    const schedule = await f.save({ mode: 'derive-from-session', sourceSessionId: source.id });
    const before = (await f.store.list()).map(item => item.id).sort();
    const originalRead = SessionStore.prototype.readMessages;
    vi.spyOn(SessionStore.prototype, 'readMessages').mockImplementation(function (this: SessionStore, id: string) {
      return id === source.id ? Promise.reject(new Error('Source history is unavailable.')) : originalRead.call(this, id);
    });
    await expect(f.host.runScheduleNow!(schedule.id, schedule.revision)).rejects.toThrow();
    expect((await f.store.list()).map(item => item.id).sort()).toEqual(before);
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await f.host.listSchedules!()).schedules[0]).toMatchObject({ lastOutcome: 'failed', runCount: 0 });
  });
});
