import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostMissionRun } from '@extalia/platform';
import { MissionCheckpointStore } from '../src/missionCheckpoints.js';
import { createAgentHost } from '../src/service.js';

const roots: string[] = [];
const hostClosers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (hostClosers.length) await hostClosers.pop()!();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(fetch: NonNullable<Parameters<typeof createAgentHost>[0]['fetch']> = async () => { throw new Error('Unexpected provider call.'); }) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-mission-checkpoints-'));
  roots.push(root);
  const data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(project, { recursive: true })]);
  const create = async () => {
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '' }, fetch });
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
    hostClosers.push(close);
    return { ...runtime, close };
  };
  return { root, data, project, create };
}

function run(sessionId: string, workspaceId: string, state: HostMissionRun['state'] = 'completed'): HostMissionRun {
  const stamp = '2026-10-18T00:00:00.000Z';
  return { id: '5d695f64-7fd4-45fc-9a73-24afcd1806eb', sessionId, workspaceId, title: 'Checkpoint fixture', state, createdAt: stamp, updatedAt: stamp, transient: false, tasks: [
    { id: 'inspect', taskId: '9f374f63-1458-401a-8146-a8dd69161d2b', agentId: '6c14429c-8c80-45a3-9d6f-a8f4e1cd08d9', title: 'Inspect', connectionId: 'connection-example', model: 'model-example', state: state === 'running' ? 'running' : 'completed', ...(state === 'completed' ? { verification: 'unverified' as const } : {}), evidenceIds: [] },
  ] };
}

/** A run interrupted with finished, in-flight and never-started tasks (no dependency edges: legacy shape). */
function mixedRun(sessionId: string, workspaceId: string): HostMissionRun {
  const stamp = '2026-10-18T00:00:00.000Z';
  const task = (index: number, id: string, state: HostMissionRun['tasks'][number]['state'], extra: Partial<HostMissionRun['tasks'][number]> = {}) => ({
    id, taskId: `9f374f63-1458-401a-8146-a8dd69161d2${index}`, agentId: `6c14429c-8c80-45a3-9d6f-a8f4e1cd08d${index}`, title: id, connectionId: 'connection-example', model: 'model-example', state, evidenceIds: [], ...extra,
  });
  return { id: '5d695f64-7fd4-45fc-9a73-24afcd1806eb', sessionId, workspaceId, title: 'Mixed fixture', state: 'running', createdAt: stamp, updatedAt: stamp, transient: false,
    usage: { inputTokens: 13, outputTokens: 5, unknownTasks: 0 }, tasks: [
      task(0, 'done', 'completed', { answer: 'Retained answer', verification: 'unverified', usage: { inputTokens: 10, outputTokens: 5 } }),
      task(1, 'active', 'running', { usage: { inputTokens: 3 } }),
      task(2, 'checking', 'verifying', { answer: 'Unconfirmed answer' }),
      task(3, 'later', 'queued'),
      task(4, 'held', 'blocked', { reason: 'dependency-failed' }),
      task(5, 'broken', 'failed', { reason: 'provider-failed' }),
    ] };
}

/** Restart recovery: only in-flight work becomes unknown; nothing else is rewritten (ADR 0013, 2026-10-22). */
function expectMixedRecovery(recovered: HostMissionRun, saved: HostMissionRun): void {
  expect(recovered.state).toBe('recovering');
  expect(recovered.tasks.map(task => [task.id, task.state, task.reason])).toEqual([
    ['done', 'completed', undefined], ['active', 'unknown', 'host-restarted'], ['checking', 'unknown', 'host-restarted'],
    ['later', 'queued', undefined], ['held', 'blocked', 'dependency-failed'], ['broken', 'failed', 'provider-failed'],
  ]);
  for (const index of [0, 3, 4, 5]) expect(recovered.tasks[index]).toEqual(saved.tasks[index]);
  // The interrupted calls may have consumed tokens and their output is unconfirmed.
  expect(recovered.tasks[1]).toMatchObject({ usage: { inputTokens: 3, unknown: true } });
  expect(recovered.tasks[2]?.usage).toEqual({ unknown: true });
  expect(recovered.tasks[2]?.answer).toBeUndefined();
  expect(recovered.usage).toEqual({ inputTokens: 13, outputTokens: 5, unknownTasks: 2 });
}

const dbFile = (data: string) => path.join(data, 'state', 'missions.sqlite');
const sidecar = (data: string, sessionId: string) => path.join(data, 'sessions', `${sessionId}.missions.json`);

describe('host mission checkpoint integration', () => {
  it('imports a validated legacy sidecar once, preserves it read-only, and survives repeated reopen', async () => {
    const env = await fixture();
    const host = await env.create();
    const connection = await host.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const saved = connection.connections[0]!;
    const workspace = (await host.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: saved.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await host.host.createSession(workspace.id);
    await host.close();

    const legacy = { schema: 'extalia.native-missions.v1', runs: [run(session.id, workspace.id)] };
    const legacyText = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(sidecar(env.data, session.id), legacyText);
    const first = await env.create();
    expect(await first.host.nativeMissionRun(session.id, legacy.runs[0]!.id)).toEqual(legacy.runs[0]);
    await first.close();
    expect(await readFile(sidecar(env.data, session.id), 'utf8')).toBe(legacyText);

    // A committed import marker makes the original compatibility file inert.
    await writeFile(sidecar(env.data, session.id), '{malformed legacy content');
    const second = await env.create();
    expect(await second.host.nativeMissionRun(session.id, legacy.runs[0]!.id)).toEqual(legacy.runs[0]);
    await second.close();
  });

  it('recovers a persisted in-progress checkpoint as unknown and quarantines without replay', async () => {
    const env = await fixture();
    const host = await env.create();
    const connection = await host.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const workspace = (await host.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: connection.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await host.host.createSession(workspace.id);
    await host.close();

    const checkpoint = await MissionCheckpointStore.open(dbFile(env.data));
    checkpoint.writeSession(session.id, [run(session.id, workspace.id, 'running')]);
    checkpoint.close();
    const reopened = await env.create();
    const recovered = await reopened.host.nativeMissionRun(session.id, '5d695f64-7fd4-45fc-9a73-24afcd1806eb');
    expect(recovered.state).toBe('recovering');
    expect(recovered.tasks[0]).toMatchObject({ state: 'unknown', reason: 'host-restarted' });
    await expect(reopened.host.sendPrompt(session.id, 'must remain quarantined')).rejects.toThrow(/unresolved/);
    await reopened.close();
    const again = await env.create();
    expect((await again.host.nativeMissionRun(session.id, recovered.id)).tasks[0]?.state).toBe('unknown');
    await again.close();
  });

  it('recovers only in-flight tasks of a mixed checkpoint as unknown and never replays queued work', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; throw new Error('Must not replay'); });
    const host = await env.create();
    const connection = await host.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const workspace = (await host.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: connection.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await host.host.createSession(workspace.id);
    await host.close();

    const saved = mixedRun(session.id, workspace.id);
    const checkpoint = await MissionCheckpointStore.open(dbFile(env.data));
    checkpoint.writeSession(session.id, [saved]);
    checkpoint.close();
    const reopened = await env.create();
    const recovered = await reopened.host.nativeMissionRun(session.id, saved.id);
    expectMixedRecovery(recovered, saved);
    await expect(reopened.host.sendPrompt(session.id, 'must remain quarantined')).rejects.toThrow(/unresolved/);
    await reopened.close();
    // The recovery checkpoint is durable and stable; a later restart neither replays nor rewrites it.
    const inspect = await MissionCheckpointStore.open(dbFile(env.data));
    expect(inspect.readSession(session.id)).toEqual([recovered]);
    inspect.close();
    const again = await env.create();
    expect(await again.host.nativeMissionRun(session.id, saved.id)).toEqual(recovered);
    await again.close();
    expect(calls).toBe(0);
  });

  it('applies the same in-flight-only recovery when importing an interrupted legacy sidecar', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; throw new Error('Must not replay'); });
    const host = await env.create();
    const connection = await host.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const workspace = (await host.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: connection.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await host.host.createSession(workspace.id);
    await host.close();

    const saved = mixedRun(session.id, workspace.id);
    const legacyText = `${JSON.stringify({ schema: 'extalia.native-missions.v1', runs: [saved] }, null, 2)}\n`;
    await writeFile(sidecar(env.data, session.id), legacyText);
    const imported = await env.create();
    const recovered = await imported.host.nativeMissionRun(session.id, saved.id);
    expectMixedRecovery(recovered, saved);
    await expect(imported.host.sendPrompt(session.id, 'must remain quarantined')).rejects.toThrow(/unresolved/);
    await imported.close();
    expect(await readFile(sidecar(env.data, session.id), 'utf8')).toBe(legacyText);
    const again = await env.create();
    expect(await again.host.nativeMissionRun(session.id, saved.id)).toEqual(recovered);
    await again.close();
    expect(calls).toBe(0);
  });

  it('fails startup closed when a saved session record is missing but a mission checkpoint remains', async () => {
    const env = await fixture();
    const host = await env.create();
    const connection = await host.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const workspace = (await host.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: connection.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await host.host.createSession(workspace.id);
    await host.close();

    const checkpoint = await MissionCheckpointStore.open(dbFile(env.data));
    checkpoint.writeSession(session.id, [run(session.id, workspace.id, 'running')]);
    checkpoint.close();

    const indexFile = path.join(env.data, 'sessions', 'index.json');
    const index = await readFile(indexFile, 'utf8');
    const records = JSON.parse(index) as { id: string }[];
    await writeFile(indexFile, `${JSON.stringify(records.filter(record => record.id !== session.id), null, 2)}\n`);
    await expect(env.create()).rejects.toThrow(/metadata is unavailable/);

    // Failed initialization must not alter or hide the durable unresolved record.
    const inspect = await MissionCheckpointStore.open(dbFile(env.data));
    expect(inspect.readSession(session.id)?.[0]).toMatchObject({ state: 'running', id: '5d695f64-7fd4-45fc-9a73-24afcd1806eb' });
    inspect.close();

    // Restoring the session record makes startup recover the same work as unknown;
    // it cannot be replayed or bypass the session admission guard.
    await writeFile(indexFile, index);
    const recoveredHost = await env.create();
    const recovered = await recoveredHost.host.nativeMissionRun(session.id, '5d695f64-7fd4-45fc-9a73-24afcd1806eb');
    expect(recovered.state).toBe('recovering');
    expect(recovered.tasks[0]).toMatchObject({ state: 'unknown', reason: 'host-restarted' });
    await expect(recoveredHost.host.sendPrompt(session.id, 'cannot resume missing execution')).rejects.toThrow(/unresolved/);
    await recoveredHost.close();
  });

  it('fails closed on a corrupt database and releases the host lock after initialization failure', async () => {
    const env = await fixture();
    await mkdir(path.dirname(dbFile(env.data)), { recursive: true });
    await writeFile(dbFile(env.data), 'not a sqlite database');
    await expect(env.create()).rejects.toThrow(/metadata is unavailable/);
    await rm(dbFile(env.data));
    const reopened = await env.create();
    await reopened.close();
  });

  it('rejects a newer checkpoint schema, releases its lock, and does not reinterpret it', async () => {
    const env = await fixture();
    await mkdir(path.dirname(dbFile(env.data)), { recursive: true });
    const database = new DatabaseSync(dbFile(env.data));
    database.exec('PRAGMA user_version = 99;');
    database.close();
    await expect(env.create()).rejects.toThrow(/metadata is unavailable/);
    await rm(dbFile(env.data));
    const reopened = await env.create();
    await reopened.close();
  });

  it('does not persist transient history-off sessions or mission records', async () => {
    const env = await fixture();
    const host = await env.create();
    const connection = await host.host.saveConnection({ name: 'No history', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: false } });
    const workspace = (await host.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: connection.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await host.host.createSession(workspace.id);
    expect(session.transient).toBe(true);
    await host.close();
    const database = new DatabaseSync(dbFile(env.data));
    try {
      expect(database.prepare('SELECT session_id FROM checkpoint_sessions WHERE session_id = ?').get(session.id)).toBeUndefined();
    } finally { database.close(); }
  });

  it('keeps database failure from claiming completion or admitting duplicate work', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return Response.json({}); });
    const host = await env.create();
    const connection = await host.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
    const workspace = (await host.host.saveWorkspace({ name: 'Project', projectLocation: env.project, connectionId: connection.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
    const session = await host.host.createSession(workspace.id);
    const database = new DatabaseSync(dbFile(env.data));
    database.exec("CREATE TRIGGER fail_mission_changes BEFORE INSERT ON mission_changes BEGIN SELECT RAISE(ABORT, 'synthetic checkpoint failure'); END;");
    database.close();
    await expect(host.host.startNativeMission(session.id, { title: 'Should not start', tasks: [{ id: 'inspect', title: 'Inspect', instructions: 'Read only', connectionId: connection.connections[0]!.id, model: 'model', dependsOn: [] }] })).rejects.toThrow();
    await expect(host.host.startNativeMission(session.id, { title: 'Retry remains blocked by storage failure', tasks: [{ id: 'inspect', title: 'Inspect', instructions: 'Read only', connectionId: connection.connections[0]!.id, model: 'model', dependsOn: [] }] })).rejects.toThrow();
    expect(calls).toBe(0);
    expect(await host.host.listNativeMissions(session.id)).toEqual([]);
    await host.close();
  });
});
