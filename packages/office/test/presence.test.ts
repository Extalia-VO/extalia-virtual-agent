import { describe, expect, it } from 'vitest';
import { reducePresence, type OfficePresenceState } from '../src/index.js';
import type { ExtaliaEvent } from '@extalia/protocol';

describe('office presence reducer', () => {
  it('updates agent presence on agent.state event without runtime coupling', () => {
    const initialState: readonly OfficePresenceState[] = [];
    const event: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-1',
      at: '2026-10-08T12:00:00Z',
      sessionId: 'sess-1',
      agentId: 'marcus',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'agent.state',
        state: 'working'
      }
    };

    const next = reducePresence(initialState, event);
    expect(next).toHaveLength(1);
    expect(next[0].agentId).toBe('marcus');
    expect(next[0].status).toBe('working');
  });

  it('updates existing agent status seamlessly', () => {
    const current: readonly OfficePresenceState[] = [
      {
        agentId: 'marcus',
        agentName: 'Marcus Vance',
        role: 'architect',
        status: 'working',
        currentFloor: 1,
        position: [0, 0, 0],
        lastActiveTimestamp: '2026-10-08T12:00:00Z'
      }
    ];

    const idleEvent: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-2',
      at: '2026-10-08T12:05:00Z',
      sessionId: 'sess-1',
      agentId: 'marcus',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'agent.state',
        state: 'idle'
      }
    };

    const next = reducePresence(current, idleEvent);
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe('idle');
    expect(next[0].lastActiveTimestamp).toBe('2026-10-08T12:05:00Z');
  });

  it('transitions agents to meeting room on meeting.started and returns on meeting.completed', () => {
    const attendees: readonly OfficePresenceState[] = [
      {
        agentId: 'marcus',
        agentName: 'Marcus Vance',
        role: 'architect',
        status: 'working',
        currentFloor: 1,
        position: [0, 0, 0],
        lastActiveTimestamp: '2026-10-08T12:00:00Z'
      },
      {
        agentId: 'elena',
        agentName: 'Elena Rostova',
        role: 'backend',
        status: 'idle',
        currentFloor: 1,
        position: [0, 0, 0],
        lastActiveTimestamp: '2026-10-08T12:00:00Z'
      }
    ];

    const meetingStart: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-3',
      at: '2026-10-08T12:10:00Z',
      sessionId: 'sess-1',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'meeting.started',
        meetingId: 'meet-1',
        participants: ['marcus', 'elena']
      }
    };

    const inMeeting = reducePresence(attendees, meetingStart);
    expect(inMeeting[0].status).toBe('meeting');
    expect(inMeeting[1].status).toBe('meeting');

    const meetingDone: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-4',
      at: '2026-10-08T12:30:00Z',
      sessionId: 'sess-1',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'meeting.completed',
        meetingId: 'meet-1'
      }
    };

    const afterMeeting = reducePresence(inMeeting, meetingDone);
    expect(afterMeeting[0].status).toBe('idle');
    expect(afterMeeting[1].status).toBe('idle');
  });

  it('handles subagent spawn and status updates', () => {
    const list: readonly OfficePresenceState[] = [];
    const spawnEvent: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-spawn',
      at: '2026-10-08T12:00:00Z',
      sessionId: 'sess-1',
      agentId: 'primary',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'subagent.spawned',
        subagentId: 'worker-1',
        label: 'Research Subagent',
        role: 'researcher'
      }
    };

    const afterSpawn = reducePresence(list, spawnEvent);
    expect(afterSpawn).toHaveLength(1);
    expect(afterSpawn[0]?.agentId).toBe('worker-1');
    expect(afterSpawn[0]?.agentName).toBe('Research Subagent');
    expect(afterSpawn[0]?.status).toBe('working');

    const updateEvent: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-state',
      at: '2026-10-08T12:05:00Z',
      sessionId: 'sess-1',
      agentId: 'primary',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'subagent.state',
        subagentId: 'worker-1',
        state: 'waiting'
      }
    };

    const afterState = reducePresence(afterSpawn, updateEvent);
    expect(afterState[0]?.status).toBe('seated');
  });
});
