import type { HostMissionRun } from '@extalia/platform';
import type { AgentEvent, AgentEventBody } from '@extalia/protocol';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { MissionRecords } from '../src/mission.js';

const directories: string[] = [];
const opened: MissionRecords[] = [];
afterEach(async () => {
  for (const records of opened.splice(0)) records.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const at = '2026-10-18T00:00:00.000Z';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-transient-journal-')); directories.push(directory);
  const database = path.join(directory, 'state', 'missions.sqlite');
  const records = new MissionRecords(path.join(directory, 'sessions'), database); opened.push(records);
  await records.initialize([]);
  const run: HostMissionRun = {
    id: randomUUID(), sessionId: 's_transient001', workspaceId: 'workspace', title: 'History-off mission', state: 'running', createdAt: at, updatedAt: at, transient: true,
    tasks: [{ id: 'survey', taskId: randomUUID(), agentId: randomUUID(), title: 'Survey', connectionId: 'connection', model: 'model-a', state: 'queued', evidenceIds: [] }],
  };
  const identity = { workspaceId: randomUUID(), sessionId: randomUUID(), leadId: randomUUID() };
  const event = (body: AgentEventBody, patch: Partial<AgentEvent> = {}): AgentEvent => ({
    schemaVersion: 1, id: randomUUID(), workspaceId: identity.workspaceId, sessionId: identity.sessionId, missionId: run.id,
    ...(body.type === 'mission.state' ? { agentId: identity.leadId } : { agentId: run.tasks[0]!.agentId, taskId: run.tasks[0]!.taskId }),
    source: { runtime: 'extalia-native', channel: 'system' }, observedAt: at, confidence: 'reported', body, ...patch,
  });
  return { directory, database, records, run, event };
}

describe('history-off (transient) native mission journal in RAM (ADR 0014)', () => {
  it('assigns per-mission sequences, acknowledges identical duplicates without rewinding and rejects conflicting reuse', async () => {
    const { records, run, event } = await fixture();
    const start = event({ type: 'mission.state', state: 'running' }, { sequence: 77 });
    expect(records.commitEvent(run, start)).toBe(1);
    const running = { ...run, tasks: [{ ...run.tasks[0]!, state: 'running' as const }] };
    expect(records.commitEvent(running, event({ type: 'task.state', state: 'running' }))).toBe(2);
    // Same ID, same normalized event and the same associated snapshot: original acknowledgement.
    expect(records.commitEvent(run, { ...start, sequence: 5 })).toBe(1);
    expect(records.get(run.sessionId, run.id).tasks[0]!.state).toBe('running');
    // Same ID with a different snapshot or a different body is a conflict and changes nothing.
    expect(() => records.commitEvent(running, start)).toThrow();
    expect(() => records.commitEvent(running, event({ type: 'turn.failed', error: 'provider-failed' }, { id: start.id }))).toThrow();
    expect(records.get(run.sessionId, run.id)).toEqual(running);
    expect(records.commitEvent(running, event({ type: 'agent.state', state: 'thinking' }))).toBe(3);
    const other = { ...run, id: randomUUID() };
    expect(() => records.commitEvent(other, { ...start, missionId: other.id })).toThrow();
    expect(records.list(run.sessionId)).toHaveLength(1);
  });

  it('enforces ownership, stable native bindings, prose rejection and state agreement before mutation', async () => {
    const { records, run, event } = await fixture();
    records.commitEvent(run, event({ type: 'mission.state', state: 'running' }));
    const before = records.get(run.sessionId, run.id);
    const invalid: AgentEvent[] = [
      event({ type: 'agent.state', state: 'thinking' }, { agentId: randomUUID() }),
      event({ type: 'mission.state', state: 'running' }, { agentId: randomUUID() }),
      event({ type: 'agent.state', state: 'thinking' }, { workspaceId: randomUUID() }),
      event({ type: 'task.state', state: 'completed' }),
      event({ type: 'model.completed', text: 'model prose must not enter the journal' } as AgentEventBody),
      event({ type: 'turn.failed', error: 'raw provider error text' }),
      event({ type: 'turn.completed', usage: { inputTokens: 1, cachedInputTokens: 2 } }),
    ];
    for (const item of invalid) expect(() => records.commitEvent(run, item)).toThrow();
    expect(records.get(run.sessionId, run.id)).toEqual(before);
    expect(records.commitEvent(run, event({ type: 'turn.completed', usage: { inputTokens: 3, outputTokens: 4 } }))).toBe(2);
  });

  it('refuses event 8193 for one mission without changing the retained snapshot', async () => {
    const { records, run, event } = await fixture();
    records.commitEvent(run, event({ type: 'mission.state', state: 'running' }));
    for (let index = 2; index <= 8192; index++) records.commitEvent(run, event({ type: 'agent.state', state: 'thinking' }));
    const changed = { ...run, title: 'Should not be stored' };
    expect(() => records.commitEvent(changed, event({ type: 'agent.state', state: 'idle' }))).toThrow();
    expect(records.get(run.sessionId, run.id).title).toBe(run.title);
  }, 30_000);

  it('never creates SQLite rows or sidecars for transient missions and forgets them on removal', async () => {
    const { directory, database, records, run, event } = await fixture();
    records.commitEvent(run, event({ type: 'mission.state', state: 'running' }));
    await records.save({ ...run, state: 'completed' });
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare('SELECT count(*) AS count FROM checkpoint_sessions').get()).toEqual({ count: 0 });
      expect(db.prepare('SELECT count(*) AS count FROM mission_events').get()).toEqual({ count: 0 });
    } finally { db.close(); }
    expect((await readdir(directory)).includes('sessions')).toBe(false);
    await records.remove(run.sessionId);
    expect(records.list(run.sessionId)).toEqual([]);
  });
});
