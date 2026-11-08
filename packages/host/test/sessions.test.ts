import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentTeam } from '@extalia/core';
import { MemorySessionStore, SessionStore, SessionTeamConflictError, newSessionId, type SessionStorage } from '../src/sessions.js';
import type { ExtaliaEvent } from '@extalia/protocol';

describe('SessionStore (Phase 3 persistence)', () => {
  it('manages atomic session records and events per workspace', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'extalia-sessions-test-'));
    try {
      const store = new SessionStore(dir);
      const testId = newSessionId();

      // 1. Create a session record linked to a project workspace
      const session = await store.create({
        id: testId,
        workspaceId: 'ws-project-alpha',
        connectionId: 'conn-openai',
        title: 'Feature Implementation',
        createdAt: '2026-10-08T12:00:00Z',
        lastActiveAt: '2026-10-08T12:00:00Z'
      });

      expect(session.id).toBe(testId);
      expect(session.workspaceId).toBe('ws-project-alpha');

      // 2. Append normalized Extalia Protocol events
      const event1: ExtaliaEvent = {
        v: 'extalia.v0',
        id: 'evt-1',
        at: '2026-10-08T12:01:00Z',
        sessionId: testId,
        source: { runtime: 'hermes', channel: 'stream' },
        body: {
          type: 'session.started',
          control: 'managed',
          model: 'ag/gemini-3.8-flash'
        }
      };

      const event2: ExtaliaEvent = {
        v: 'extalia.v0',
        id: 'evt-2',
        at: '2026-10-08T12:02:00Z',
        sessionId: testId,
        source: { runtime: 'hermes', channel: 'stream' },
        body: {
          type: 'turn.completed',
          usage: { inputTokens: 500, outputTokens: 80 }
        }
      };

      await store.appendEvent(session.id, event1);
      await store.appendEvent(session.id, event2);

      // 3. Read back verified event stream
      const events = await store.readEvents(session.id);
      expect(events).toHaveLength(2);
      expect(events[0]?.body.type).toBe('session.started');
      expect(events[1]?.body.type).toBe('turn.completed');

      // 4. Update session metadata atomically
      const updated = await store.update(session.id, {
        title: 'Feature Implementation (Completed)',
        lastActiveAt: '2026-10-08T12:02:00Z'
      });
      expect(updated.title).toBe('Feature Implementation (Completed)');

      // 5. Query session list
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0]?.id).toBe(testId);

      // 6. Delete session cleanly
      await store.remove(session.id);
      const afterRemoval = await store.list();
      expect(afterRemoval).toHaveLength(0);
      const remainingEvents = await store.readEvents(session.id);
      expect(remainingEvents).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.each(['saved', 'memory'] as const)('%s session team compare-and-swap', kind => {
  let store: SessionStorage;
  let directory: string | undefined;
  let id: string;
  const original: AgentTeam = {
    enabled: true,
    allowedModels: ['lead-model'],
    connections: [{ connectionId: 'worker-connection', allowedModels: ['worker-model'] }],
    members: [{ id: 'reviewer', name: 'Example Reviewer', role: 'Reviewer', models: ['worker-model'], connectionId: 'worker-connection' }],
  };
  const team = () => structuredClone(original);

  beforeEach(async () => {
    directory = kind === 'saved' ? await mkdtemp(path.join(tmpdir(), 'extalia-session-team-cas-')) : undefined;
    store = directory ? new SessionStore(directory) : new MemorySessionStore();
    id = newSessionId();
    await store.create({ id, workspaceId: 'workspace', connectionId: 'lead-connection', title: 'Example',
      createdAt: '2026-11-08T00:00:00Z', lastActiveAt: '2026-11-08T00:00:00Z', team: team() });
  });

  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it('rejects a stale model update queued after the user pauses the team', async () => {
    const snapshot = structuredClone((await store.get(id))!.team);
    const paused = { ...team(), enabled: false };
    // Issue both calls before either settles: the comparison must happen inside the saved index queue.
    const user = store.update(id, { team: paused });
    const model = store.update(id, { team: { ...team(), goal: 'Model change' } }, { expectedTeam: snapshot });
    const results = await Promise.allSettled([user, model]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: {
      name: 'SessionTeamConflictError', message: 'Team settings changed. Keep the newer user settings and retry after this turn.',
    } });
    expect((await store.get(id))!.team).toEqual(paused);
  });

  it('keeps a user pause queued after an admitted model update', async () => {
    const snapshot = structuredClone((await store.get(id))!.team);
    const changed = { ...team(), goal: 'Model change' };
    const paused = { ...team(), enabled: false, goal: 'User choice' };
    const model = store.update(id, { team: changed }, { expectedTeam: snapshot });
    const user = store.update(id, { team: paused });
    const [persisted] = await Promise.all([model, user]);
    expect(persisted.team).toEqual(changed);
    expect((await store.get(id))!.team).toEqual(paused);
  });

  it.each(['name', 'grant'] as const)('rejects a stale snapshot after a %s change', async field => {
    const snapshot = structuredClone((await store.get(id))!.team);
    const changed = team();
    if (field === 'name') changed.members[0]!.name = 'Another Reviewer';
    else changed.connections![0]!.allowedModels.push('another-worker-model');
    await store.update(id, { team: changed });
    await expect(store.update(id, { team: team() }, { expectedTeam: snapshot })).rejects.toBeInstanceOf(SessionTeamConflictError);
    expect((await store.get(id))!.team).toEqual(changed);
  });

  it('allows unrelated metadata changes and ordinary updates without an expectation', async () => {
    const snapshot = structuredClone((await store.get(id))!.team);
    await store.update(id, { title: 'Renamed', lastActiveAt: '2026-11-08T00:01:00Z' });
    const changed = { ...team(), goal: 'Model change' };
    const persisted = await store.update(id, { team: changed }, { expectedTeam: snapshot });
    expect(persisted).toMatchObject({ title: 'Renamed', lastActiveAt: '2026-11-08T00:01:00Z', team: changed });
    await store.update(id, { team: { ...team(), enabled: false } });
    expect((await store.get(id))!.team?.enabled).toBe(false);
  });

  it('compares an expected absent team when the options object is present', async () => {
    await store.update(id, { team: undefined });
    const created = await store.update(id, { team: team() }, {});
    expect(created.team).toEqual(original);
    await expect(store.update(id, { team: undefined }, {})).rejects.toBeInstanceOf(SessionTeamConflictError);
    expect((await store.get(id))!.team).toEqual(original);
  });

  it('accepts the returned team snapshot for a subsequent guarded update', async () => {
    const snapshot = structuredClone((await store.get(id))!.team);
    const first = await store.update(id, { team: { ...team(), goal: 'First' } }, { expectedTeam: snapshot });
    const second = await store.update(id, { team: { ...team(), goal: 'Second' } }, { expectedTeam: structuredClone(first.team) });
    expect(second.team?.goal).toBe('Second');
    expect((await store.get(id))!.team).toEqual(second.team);
  });
});
