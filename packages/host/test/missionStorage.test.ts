import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HostMissionRun } from '@extalia/platform';
import { MissionRecords } from '../src/mission.js';
import type { SessionRecord } from '../src/sessions.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const session: SessionRecord = { id: 's_storage123', workspaceId: 'workspace', connectionId: 'connection', title: 'Storage', createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z' };
const MAX_BYTES = 8 * 1024 * 1024;
function record(index: number, answer: string, state: HostMissionRun['state'] = 'completed'): HostMissionRun {
  const at = new Date(Date.parse(session.createdAt) + index * 1000).toISOString();
  return {
    id: randomUUID(), sessionId: session.id, workspaceId: session.workspaceId, title: `Mission ${index}`, state, createdAt: at, updatedAt: at, transient: false,
    tasks: Array.from({ length: 16 }, (_, n) => ({ id: `task_${n}`, taskId: randomUUID(), agentId: randomUUID(), title: 'Read-only task', connectionId: session.connectionId, model: 'model-a', state: state === 'recovering' ? 'unknown' : 'completed', answer, verification: 'unverified' as const, evidenceIds: [] })),
  };
}
async function storage() {
  const directory = await mkdtemp(path.join(tmpdir(), 'extalia-mission-storage-')); directories.push(directory);
  return { directory, file: path.join(directory, `${session.id}.missions.json`), records: new MissionRecords(directory) };
}

describe('native mission metadata byte retention', () => {
  it('retains current/unresolved records, prunes oldest terminal history and reopens UTF-8 escaped answers', async () => {
    const { records, directory, file } = await storage();
    // All answers respect the 16000-code-unit limit, but JSON escaping and UTF-8
    // encoding make sixteen full records exceed the reader's eight-MiB ceiling.
    const answer = '\u0001界\\"'.repeat(4000);
    expect(answer.length).toBe(16_000);
    const unresolved = record(0, answer, 'recovering');
    await records.save(unresolved);
    const terminalIds: string[] = [];
    let current!: HostMissionRun;
    for (let n = 1; n <= 16; n++) {
      current = record(n, answer); terminalIds.push(current.id); await records.save(current);
      expect((await stat(file)).size).toBeLessThanOrEqual(MAX_BYTES);
    }
    const retained = records.list(session.id);
    expect(retained.length).toBeLessThan(16);
    expect(retained.some(run => run.id === unresolved.id)).toBe(true);
    expect(retained.some(run => run.id === current.id)).toBe(true);
    expect(retained.some(run => run.id === terminalIds[0])).toBe(false);
    const serialized = await readFile(file, 'utf8');
    const parsed = JSON.parse(serialized) as { schema: string; runs: HostMissionRun[] };
    expect(Buffer.byteLength(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8')).toBe((await stat(file)).size);
    const reopened = new MissionRecords(directory); await reopened.initialize([session]);
    expect(reopened.list(session.id)).toEqual(retained);
  });

  it('rejects an unfit protected set without changing existing memory or file bytes', async () => {
    const { records, file } = await storage();
    const answer = '\u0001'.repeat(16_000);
    for (let n = 0; n < 4; n++) await records.save(record(n, answer, 'recovering'));
    const before = records.list(session.id), bytes = await readFile(file, 'utf8');
    // This is deliberately beyond the service's per-answer bound to exercise
    // storage's independent fail-safe when no terminal record can be removed.
    const oversized = record(10, '界'.repeat(200_000), 'recovering');
    await expect(records.save(oversized)).rejects.toThrow(/metadata is unavailable/);
    expect(records.list(session.id)).toEqual(before);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('roundtrips dependency aliases and keeps missing legacy graph data unknown', async () => {
    const { records, directory, file } = await storage();
    const base = record(1, 'answer');
    const graph: HostMissionRun = {
      ...base,
      tasks: [
        { ...base.tasks[0]!, id: 'survey', dependsOn: [] },
        { ...base.tasks[1]!, id: 'review', dependsOn: ['survey'] },
      ],
    };
    await records.save(graph);
    const reopened = new MissionRecords(directory);
    await reopened.initialize([session]);
    expect(reopened.get(session.id, graph.id).tasks.map(task => [task.id, task.dependsOn])).toEqual([['survey', []], ['review', ['survey']]]);

    const legacy = { ...base, tasks: base.tasks.slice(0, 1).map(task => {
      const { dependsOn: _unknownGraph, ...withoutGraph } = task;
      return withoutGraph;
    }) };
    await writeFile(file, JSON.stringify({ schema: 'extalia.native-missions.v1', runs: [legacy] }));
    const legacyStore = new MissionRecords(directory);
    await legacyStore.initialize([session]);
    const legacyTask = legacyStore.get(session.id, legacy.id).tasks[0]!;
    expect(Object.hasOwn(legacyTask, 'dependsOn')).toBe(false);
  });

  it('recovers only in-flight tasks of an interrupted sidecar run and rewrites the sidecar once', async () => {
    const { directory, file } = await storage();
    const base = record(1, 'answer');
    const states = ['completed', 'assigned', 'running', 'waiting', 'awaiting_approval', 'verifying', 'queued', 'blocked', 'failed', 'cancelled'] as const;
    const interrupted: HostMissionRun = { ...base, state: 'running', tasks: states.map((state, n) => {
      const { answer: _answer, verification: _verification, ...task } = base.tasks[n]!;
      return { ...task, state, ...(state === 'completed' ? { answer: 'kept', verification: 'unverified' as const } : {}), ...(state === 'blocked' ? { reason: 'capacity-unknown' } : {}) };
    }) };
    await writeFile(file, JSON.stringify({ schema: 'extalia.native-missions.v1', runs: [interrupted] }));
    const recoveredStore = new MissionRecords(directory);
    await recoveredStore.initialize([session]);
    const recovered = recoveredStore.get(session.id, interrupted.id);
    expect(recovered.state).toBe('recovering');
    expect(recovered.tasks.map(task => task.state)).toEqual(['completed', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'queued', 'blocked', 'failed', 'cancelled']);
    expect(recovered.tasks.filter(task => task.state === 'unknown').every(task => task.reason === 'host-restarted' && task.usage?.unknown === true)).toBe(true);
    for (const n of [0, 6, 7, 8, 9]) expect(recovered.tasks[n]).toEqual(interrupted.tasks[n]);
    const bytes = await readFile(file, 'utf8');
    expect((JSON.parse(bytes) as { runs: HostMissionRun[] }).runs).toEqual([recovered]);
    // A recovering run is left as it is on the next start.
    const reopened = new MissionRecords(directory);
    await reopened.initialize([session]);
    expect(reopened.get(session.id, interrupted.id)).toEqual(recovered);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('rejects malformed dependency references, duplicate edges, self-edges and cycles', async () => {
    const { directory, file } = await storage();
    const base = record(1, 'answer');
    const tasks = [
      { ...base.tasks[0]!, id: 'survey' },
      { ...base.tasks[1]!, id: 'review' },
    ];
    const invalidRuns = [
      { ...base, tasks: [{ ...tasks[0]!, dependsOn: ['missing'] }, { ...tasks[1]!, dependsOn: [] }] },
      { ...base, tasks: [{ ...tasks[0]!, dependsOn: [] }, { ...tasks[1]!, dependsOn: ['survey', 'survey'] }] },
      { ...base, tasks: [{ ...tasks[0]!, dependsOn: ['survey'] }, { ...tasks[1]!, dependsOn: [] }] },
      { ...base, tasks: [{ ...tasks[0]!, dependsOn: ['review'] }, { ...tasks[1]!, dependsOn: ['survey'] }] },
    ];
    for (const invalid of invalidRuns) {
      await writeFile(file, JSON.stringify({ schema: 'extalia.native-missions.v1', runs: [invalid] }));
      await expect(new MissionRecords(directory).initialize([session])).rejects.toThrow(/metadata is unavailable/);
    }
  });
});
