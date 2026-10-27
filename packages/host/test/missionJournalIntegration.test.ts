import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEvent, type ExtaliaEvent } from '@extalia/protocol';
import type { HostMissionRequest, HostMissionRun } from '@extalia/platform';
import type { AnyTool, ToolRunContext } from '@extalia/runtime';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import * as fileTools from '../src/tools/files.js';

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
  vi.restoreAllMocks();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

type Fetch = NonNullable<Parameters<typeof createAgentHost>[0]['fetch']>;
function response(text: string) {
  return Response.json({ model: 'model-a', choices: [{ message: { content: text }, finish_reason: 'stop' }] });
}
async function fixture(fetch: Fetch) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-mission-journal-'));
  roots.push(root);
  const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
  await Promise.all([mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
  const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '' }, fetch });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await runtime.close(); } };
  closes.push(close);
  const connectionResponse = await runtime.host.saveConnection({ name: 'Provider', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off' } });
  const connection = connectionResponse.connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Project', projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const session = await runtime.host.createSession(workspace.id);
  const request: HostMissionRequest = { title: 'Read-only evidence review', tasks: [{ id: 'inspect', title: 'Inspect project', instructions: 'Inspect project read-only.', connectionId: connection.id, model: 'model-a', dependsOn: [] }] };
  return { root, project, home, data, runtime, close, connection, workspace, session, request };
}
async function waitMission(host: AgentHostRuntime['host'], sessionId: string, missionId: string): Promise<HostMissionRun> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const run = await host.nativeMissionRun(sessionId, missionId);
    if (run.state !== 'running') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Mission did not settle in test fixture.');
}
/** The run releases its session after its final save; then only the unresolved quarantine may block. */
async function expectQuarantined(host: AgentHostRuntime['host'], sessionId: string, request: HostMissionRequest): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const message = await host.startNativeMission(sessionId, request).then(() => 'started', (error: unknown) => error instanceof Error ? error.message : String(error));
    if (/still working/.test(message)) { await new Promise(resolve => setTimeout(resolve, 5)); continue; }
    expect(message).toMatch(/active|unresolved/);
    return;
  }
  throw new Error('Session did not release in test fixture.');
}
const databaseFile = (data: string) => path.join(data, 'state', 'missions.sqlite');
function queryEvents(data: string, missionId: string) {
  const db = new DatabaseSync(databaseFile(data), { readOnly: true });
  try {
    const events = db.prepare('SELECT sequence,event_type,checkpoint_revision,checkpoint_digest,digest,payload FROM mission_events WHERE run_id = ? ORDER BY sequence').all(missionId) as { sequence: number; event_type: string; checkpoint_revision: number; checkpoint_digest: string; digest: string; payload: string }[];
    const revisions = db.prepare('SELECT revision,digest,state FROM mission_changes WHERE run_id = ? ORDER BY revision').all(missionId) as { revision: number; digest: string; state: string }[];
    const checkpoint = db.prepare('SELECT revision,digest,payload FROM mission_checkpoints WHERE run_id = ?').get(missionId) as { revision: number; digest: string; payload: string } | undefined;
    return { events, revisions, checkpoint };
  } finally { db.close(); }
}
function failEventType(data: string, type: string, triggerName: string) {
  const db = new DatabaseSync(databaseFile(data));
  try { db.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON mission_events WHEN NEW.event_type='${type}' BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END;`); }
  finally { db.close(); }
}
function dropTrigger(data: string, triggerName: string) {
  const db = new DatabaseSync(databaseFile(data));
  try { db.exec(`DROP TRIGGER ${triggerName};`); }
  finally { db.close(); }
}

describe('host mission event journal integration', () => {
  it('atomically stores event sequence with each checkpoint, keeps results in final snapshot, and preserves canonical v0 projection', async () => {
    const answer = 'UNTRUSTED_ANSWER_PAYLOAD_8b7ef';
    let calls = 0;
    const env = await fixture(async () => { calls++; return response(answer); });
    const started = await env.runtime.host.startNativeMission(env.session.id, env.request);
    const final = await waitMission(env.runtime.host, env.session.id, started.id);
    expect(final.state).toBe('completed');
    expect(final.tasks[0]).toMatchObject({ answer, state: 'completed', verification: 'unverified', evidenceIds: [] });
    expect(calls).toBe(1);
    await env.close();

    const { events, revisions, checkpoint } = queryEvents(env.data, started.id);
    expect(events.length).toBeGreaterThan(0);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.map(event => JSON.parse(event.payload).sequence)).toEqual(events.map(event => event.sequence));
    expect(events.some(event => event.event_type === 'task.state')).toBe(true);
    expect(events.every(event => {
      const revision = revisions.find(item => item.revision === event.checkpoint_revision);
      return Boolean(revision && revision.digest === event.checkpoint_digest);
    })).toBe(true);
    expect(revisions.at(-1)?.state).toBe('completed');
    expect(checkpoint && JSON.parse(checkpoint.payload).tasks[0]?.answer).toBe(answer);
    const journalText = JSON.stringify(events);
    expect(journalText).not.toContain(answer);
    expect(journalText).not.toContain('Inspect project read-only.');
    expect(journalText).not.toContain('synthetic-key');

    const reopened = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: env.data, homeDirectory: env.home, importHome: env.home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: env.home, PATH: '' }, fetch: async () => { throw new Error('No replay expected.'); } });
    closes.push(() => reopened.close());
    const v0 = await reopened.host.sessionEvents(env.session.id);
    expect(v0.every((event: ExtaliaEvent) => parseEvent(event).ok && event.v === 'extalia.v0')).toBe(true);
    expect(v0.some(event => event.correlationId === started.id && event.body.type === 'task.completed' && event.body.ok)).toBe(true);
    expect(JSON.stringify(v0)).not.toContain(answer);
  });

  it('rolls back an agent-state event/checkpoint atomically, blocks provider start, then recovers without replay', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('must never be requested'); });
    failEventType(env.data, 'agent.state', 'fail_agent_state');
    const started = await env.runtime.host.startNativeMission(env.session.id, env.request);
    const failed = await waitMission(env.runtime.host, env.session.id, started.id);
    expect(failed.state).toBe('recovering');
    expect(calls).toBe(0);
    expect(failed.tasks[0]?.state).toBe('unknown');
    await expectQuarantined(env.runtime.host, env.session.id, env.request);
    const storedBeforeRestart = queryEvents(env.data, started.id);
    expect(storedBeforeRestart.events.some(event => event.event_type === 'agent.state')).toBe(false);
    expect(storedBeforeRestart.checkpoint && JSON.parse(storedBeforeRestart.checkpoint.payload).state).toBe('recovering');
    dropTrigger(env.data, 'fail_agent_state');
    await env.close();

    const reopened = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: env.data, homeDirectory: env.home, importHome: env.home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: env.home, PATH: '' }, fetch: async () => { calls++; return response('no replay'); } });
    closes.push(() => reopened.close());
    const recovered = await reopened.host.nativeMissionRun(env.session.id, started.id);
    expect(recovered.state).toBe('recovering');
    expect(recovered.tasks[0]?.state).toBe('unknown');
    expect(calls).toBe(0);
    await expect(reopened.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/active|unresolved/);
  });

  it('does not run a read tool if the durable tool.started event is rejected; restart remains unknown and does not retry', async () => {
    let calls = 0;
    let readToolCalls = 0;
    const env = await fixture(async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { model: string };
      return Response.json({ model: body.model, choices: [{ message: { content: '', tool_calls: [{ id: 'call-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, finish_reason: 'tool_calls' }] });
    });
    const createFileTools = fileTools.createFileTools;
    vi.spyOn(fileTools, 'createFileTools').mockImplementation(root => createFileTools(root).map(tool => tool.name !== 'read_file' ? tool : ({
      ...tool,
      run: (input: unknown, context: ToolRunContext) => { readToolCalls++; return tool.run(input, context); },
    } as AnyTool)));
    failEventType(env.data, 'tool.started', 'fail_tool_started');
    const started = await env.runtime.host.startNativeMission(env.session.id, env.request);
    const failed = await waitMission(env.runtime.host, env.session.id, started.id);
    expect(failed.state).toBe('recovering');
    expect(calls).toBe(1); // The model request occurred; a second request would prove the read tool ran.
    expect(readToolCalls).toBe(0);
    expect(failed.tasks[0]?.state).not.toBe('completed');
    await expectQuarantined(env.runtime.host, env.session.id, env.request);
    const beforeClose = queryEvents(env.data, started.id);
    expect(beforeClose.events.some(event => event.event_type === 'tool.started')).toBe(false);
    expect(beforeClose.events.some(event => JSON.stringify(event).includes('README.md'))).toBe(false);
    dropTrigger(env.data, 'fail_tool_started');
    await env.close();

    const reopened = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: env.data, homeDirectory: env.home, importHome: env.home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: env.home, PATH: '' }, fetch: async () => { calls++; return response('must not retry'); } });
    closes.push(() => reopened.close());
    const recovered = await reopened.host.nativeMissionRun(env.session.id, started.id);
    expect(recovered.state).toBe('recovering');
    expect(recovered.tasks[0]?.state).toBe('unknown');
    expect(calls).toBe(1);
    await expect(reopened.host.startNativeMission(env.session.id, env.request)).rejects.toThrow(/active|unresolved/);
  });

  it('latches mission-wide on a failed SQLite commit: aborts the running sibling, never starts queued work and recovers without replay', async () => {
    const calls: string[] = [];
    let betaAborted = false;
    const env = await fixture(async (_url, init) => {
      const text = String(init?.body);
      const task = text.includes('Task alpha') ? 'alpha' : text.includes('Task beta') ? 'beta' : 'gamma';
      calls.push(task);
      if (task === 'alpha') return Response.json({ model: 'model-a', choices: [{ message: { content: '', tool_calls: [{ id: 'call-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) } }] }, finish_reason: 'tool_calls' }] });
      if (task === 'beta') return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => { betaAborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
      return response('gamma must never run');
    });
    failEventType(env.data, 'tool.started', 'fail_tool_started_latch');
    const base = env.request.tasks[0]!;
    const request: HostMissionRequest = { title: 'Latch review', maxConcurrency: 2, tasks: [
      { ...base, id: 'alpha', title: 'Alpha', instructions: 'Task alpha: read the README.' },
      { ...base, id: 'beta', title: 'Beta', instructions: 'Task beta: inspect the project.' },
      { ...base, id: 'gamma', title: 'Gamma', instructions: 'Task gamma: summarize.' },
    ] };
    const started = await env.runtime.host.startNativeMission(env.session.id, request);
    const failed = await waitMission(env.runtime.host, env.session.id, started.id);
    expect(failed.state).toBe('recovering');
    expect(betaAborted).toBe(true);
    expect(calls.filter(task => task === 'gamma')).toEqual([]);
    expect(calls.filter(task => task === 'alpha')).toEqual(['alpha']);
    expect(failed.tasks.map(task => [task.id, task.state, task.reason])).toEqual([
      ['alpha', 'unknown', 'persistence-failed'], ['beta', 'unknown', 'persistence-failed'], ['gamma', 'blocked', 'persistence-failed'],
    ]);
    expect(JSON.stringify(failed)).not.toContain('synthetic journal failure');
    await expectQuarantined(env.runtime.host, env.session.id, request);
    const stored = queryEvents(env.data, started.id);
    expect(stored.events.some(event => event.event_type === 'tool.started')).toBe(false);
    expect(stored.events.some(event => JSON.parse(event.payload).taskId === failed.tasks[2]!.taskId)).toBe(false);
    dropTrigger(env.data, 'fail_tool_started_latch');
    await env.close();

    const reopened = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: env.data, homeDirectory: env.home, importHome: env.home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: env.home, PATH: '' }, fetch: async () => { calls.push('replay'); return response('no replay'); } });
    closes.push(() => reopened.close());
    const recovered = await reopened.host.nativeMissionRun(env.session.id, started.id);
    expect(recovered.state).toBe('recovering');
    expect(calls).not.toContain('replay');
  });

  it('keeps history-off mission events and checkpoint state in memory only', async () => {
    let calls = 0;
    const env = await fixture(async () => { calls++; return response('transient response'); });
    await env.close();
    const transientRuntime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: env.data, homeDirectory: env.home, importHome: env.home, observationIntervalMs: 60_000, env: { EXTALIA_SECRET_STORE: 'memory', HOME: env.home, PATH: '' }, fetch: async () => { calls++; return response('transient response'); } });
    closes.push(() => transientRuntime.close());
    const noHistory = await transientRuntime.host.saveConnection({ name: 'No history', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'model-a', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: false } });
    const connection = noHistory.connections.find(item => item.name === 'No history')!;
    const workspace = (await transientRuntime.host.saveWorkspace({ name: 'Transient project', projectLocation: env.project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.name === 'Transient project')!;
    const session = await transientRuntime.host.createSession(workspace.id);
    const request = { ...env.request, tasks: [{ ...env.request.tasks[0]!, connectionId: connection.id }] };
    expect(session.transient).toBe(true);
    const started = await transientRuntime.host.startNativeMission(session.id, request);
    expect((await waitMission(transientRuntime.host, session.id, started.id)).state).toBe('completed');
    await transientRuntime.close();
    const db = new DatabaseSync(databaseFile(env.data), { readOnly: true });
    try {
      expect(db.prepare('SELECT session_id FROM checkpoint_sessions WHERE session_id = ?').get(session.id)).toBeUndefined();
      expect(db.prepare('SELECT event_id FROM mission_events WHERE session_id = ?').all(session.id)).toEqual([]);
    } finally { db.close(); }
    expect(calls).toBe(1);
  });
});
