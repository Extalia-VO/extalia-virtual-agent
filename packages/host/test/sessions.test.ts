import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, newSessionId } from '../src/sessions.js';
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
