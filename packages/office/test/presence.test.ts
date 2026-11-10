import { describe, expect, it } from 'vitest';
import {
  initialOfficeState,
  reduceOffice,
  type OfficeTemplate
} from '../src/index.js';
import type { ExtaliaEvent } from '@extalia/protocol';

const sampleTemplate: OfficeTemplate = {
  schema: 'extalia.office.v1',
  id: 'template-default',
  floors: [
    {
      id: 'floor-1',
      level: 1,
      labelKey: 'floor1',
      size: [40, 30],
      origin: [0, 0, 0],
      waypoints: [],
      edges: [],
      rooms: [
        {
          id: 'room-exec',
          kind: 'executive',
          labelKey: 'exec',
          floorId: 'floor-1',
          center: [0, 0, 0],
          size: [10, 10, 3],
          entryWaypointId: 'wp-exec-entry',
          subscriptions: [],
          workstations: [
            {
              id: 'ws-1',
              roomId: 'room-exec',
              accepts: ['*'],
              approachWaypointId: 'wp-ws-1',
              seat: [0, 0, 0],
              rotationY: 0
            }
          ]
        },
        {
          id: 'room-meeting',
          kind: 'meeting',
          labelKey: 'meeting',
          floorId: 'floor-1',
          center: [15, 0, 0],
          size: [10, 10, 3],
          entryWaypointId: 'wp-meet-entry',
          subscriptions: [],
          workstations: [],
          seats: [
            { id: 'seat-1', approachWaypointId: 'wp-s1', seat: [15, 0, 0], rotationY: 0 },
            { id: 'seat-2', approachWaypointId: 'wp-s2', seat: [16, 0, 0], rotationY: 0 }
          ]
        },
        {
          id: 'room-source',
          kind: 'source_control',
          labelKey: 'sc',
          floorId: 'floor-1',
          center: [0, 0, 15],
          size: [8, 8, 3],
          entryWaypointId: 'wp-sc-entry',
          subscriptions: ['git.*'],
          workstations: []
        }
      ]
    }
  ],
  connectors: [],
  assignment: {
    byRole: { primary: 'room-exec' },
    subagent: 'near_parent',
    overflowRoomId: 'room-exec',
    sticky: true
  },
  idle: {
    default: { kind: 'desk' }
  },
  spawn: {
    waypointId: 'wp-spawn',
    staggerMs: 500
  }
};

describe('reduceOffice (Opus 5.5 Specification)', () => {
  it('passes Phase 1 acceptance: spawn primary, spawn subagent, working, meeting, git reactive, release', () => {
    let state = initialOfficeState(sampleTemplate);

    // 1. Spawn primary agent
    const e1: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-1',
      at: '2026-10-08T12:00:00Z',
      sessionId: 'sess-1',
      agentId: 'primary',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'agent.created',
        name: 'Lead Agent',
        role: 'primary'
      }
    };
    state = reduceOffice(sampleTemplate, state, e1);
    expect(state.presences).toHaveLength(1);
    expect(state.presences[0]?.identity.agentId).toBe('primary');
    expect(state.slots[0]?.occupantAgentId).toBe('primary');

    // 2. Spawn subagent
    const e2: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-2',
      at: '2026-10-08T12:01:00Z',
      sessionId: 'sess-1',
      agentId: 'primary',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'subagent.spawned',
        subagentId: 'worker-1',
        label: 'QA Worker',
        role: 'qa'
      }
    };
    state = reduceOffice(sampleTemplate, state, e2);
    expect(state.presences).toHaveLength(2);

    // 3. Meeting started with both participants
    const e3: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-3',
      at: '2026-10-08T12:10:00Z',
      sessionId: 'sess-1',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'meeting.started',
        meetingId: 'meet-sync',
        participants: ['primary', 'worker-1']
      }
    };
    state = reduceOffice(sampleTemplate, state, e3);
    expect(state.meetings).toHaveLength(1);
    expect(state.presences[0]?.intent.kind).toBe('in_meeting');
    expect(state.presences[1]?.intent.kind).toBe('in_meeting');

    // 4. Git event updates Source Control room counters
    const e4: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-4',
      at: '2026-10-08T12:15:00Z',
      sessionId: 'sess-1',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'git.commit',
        sha: 'abc1234',
        message: 'fix: tests'
      }
    };
    state = reduceOffice(sampleTemplate, state, e4);
    const scRoom = state.rooms.find(r => r.roomId === 'room-source');
    expect(scRoom?.level).toBe('active');
    expect(scRoom?.counters['git.commit']).toBe(1);

    // 5. Meeting completed returns participants to idle
    const e5: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-5',
      at: '2026-10-08T12:20:00Z',
      sessionId: 'sess-1',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'meeting.completed',
        meetingId: 'meet-sync'
      }
    };
    state = reduceOffice(sampleTemplate, state, e5);
    expect(state.meetings).toHaveLength(0);
    expect(state.presences[0]?.intent).toMatchObject({ kind: 'at_desk', slotId: 'ws-1' });
    expect(state.presences[1]?.intent.kind).toBe('idle_at');

    // 6. Agent stopped releases workstation slot
    const e6: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-6',
      at: '2026-10-08T12:30:00Z',
      sessionId: 'sess-1',
      agentId: 'primary',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'agent.stopped'
      }
    };
    state = reduceOffice(sampleTemplate, state, e6);
    expect(state.presences[0]?.intent.kind).toBe('off_duty');
    expect(state.slots[0]?.occupantAgentId).toBeUndefined();
    expect(state.slots[0]?.state).toBe('AVAILABLE');
  });

  it('preserves Invariant I4: replaying identical events yields deep-equal state', () => {
    let stateA = initialOfficeState(sampleTemplate);
    let stateB = initialOfficeState(sampleTemplate);

    const event: ExtaliaEvent = {
      v: 'extalia.v0',
      id: 'evt-replay',
      at: '2026-10-08T12:00:00Z',
      sessionId: 'sess-1',
      agentId: 'primary',
      source: { runtime: 'hermes', channel: 'stream' },
      body: {
        type: 'agent.created',
        name: 'Lead Agent'
      }
    };

    stateA = reduceOffice(sampleTemplate, stateA, event);
    stateB = reduceOffice(sampleTemplate, stateB, event);

    expect(stateA).toEqual(stateB);
  });

  it('calculates deterministic A* path using buildNavGraph and findRoute', async () => {
    const templateWithNav: OfficeTemplate = {
      ...sampleTemplate,
      floors: [
        {
          ...sampleTemplate.floors[0]!,
          waypoints: [
            { id: 'wp-start', floorId: 'floor-1', kind: 'corridor', position: [0, 0, 0] },
            { id: 'wp-mid', floorId: 'floor-1', kind: 'corridor', position: [5, 0, 0] },
            { id: 'wp-end', floorId: 'floor-1', kind: 'door', position: [10, 0, 0] }
          ],
          edges: [
            { from: 'wp-start', to: 'wp-mid', cost: 5 },
            { from: 'wp-mid', to: 'wp-end', cost: 5 }
          ]
        }
      ]
    };

    const graph = (await import('../src/index.js')).buildNavGraph(templateWithNav);
    const route = (await import('../src/index.js')).findRoute(graph, 'wp-start', 'wp-end');

    expect(route).not.toBeNull();
    expect(route?.nodeIds).toEqual(['wp-start', 'wp-mid', 'wp-end']);
    expect(route?.cost).toBe(10);
  });
});

describe('meeting resource lifecycle', () => {
  const event = (sessionId: string, id: string, body: ExtaliaEvent['body'], agentId = 'primary'): ExtaliaEvent => ({
    v: 'extalia.v0', sessionId, id, body, agentId, at: '2026-10-08T12:00:00Z', source: { runtime: 'fixture', channel: 'stream' },
  });
  const meeting = event('s', 'meeting', { type: 'meeting.started', meetingId: 'sync', participants: ['primary', 'member'] });
  const setup = () => [event('s', 'lead', { type: 'agent.created', name: 'Lead' }),
    event('s', 'member', { type: 'subagent.spawned', subagentId: 'member' })]
    .reduce((state, e) => reduceOffice(sampleTemplate, state, e), initialOfficeState(sampleTemplate));

  it('uses distinct authored seats, keeps a workstation across round stops, and returns to the same desk', () => {
    let state = reduceOffice(sampleTemplate, setup(), meeting);
    expect(state.presences.map(p => p.intent)).toEqual([
      { kind: 'in_meeting', meetingId: 'sync', roomId: 'room-meeting', seatId: 'seat-1' },
      { kind: 'in_meeting', meetingId: 'sync', roomId: 'room-meeting', seatId: 'seat-2' },
    ]);
    state = reduceOffice(sampleTemplate, state, event('s', 'stopped', { type: 'agent.stopped' }, 'member'));
    state = reduceOffice(sampleTemplate, state, event('s', 'working', { type: 'agent.state', state: 'working' }));
    expect(state.presences.every(p => p.intent.kind === 'in_meeting')).toBe(true);
    expect(state.slots[0]?.occupantAgentId).toBe('primary');
    state = reduceOffice(sampleTemplate, state, event('s', 'done', { type: 'meeting.completed', meetingId: 'sync' }));
    expect(state.presences.find(p => p.identity.agentId === 'primary')?.intent).toMatchObject({ kind: 'at_desk', slotId: 'ws-1' });
    expect(state.presences.find(p => p.identity.agentId === 'primary')?.destinationWaypointId).toBe('wp-ws-1');
    expect(reduceOffice(sampleTemplate, state, meeting).meetings).toHaveLength(0);
  });

  it('rejects unknown, duplicate, and over-capacity membership without changing ordinary work', () => {
    const state = setup();
    for (const participants of [['primary', 'unknown'], ['primary', 'primary'], ['primary', 'member', 'third']]) {
      expect(reduceOffice(sampleTemplate, state, event('s', 'bad', { type: 'meeting.started', meetingId: 'bad', participants })).presences).toEqual(state.presences);
    }
  });

  it('does not seat or release a same-id agent from a foreign session', () => {
    let state = setup();
    state = reduceOffice(sampleTemplate, state, event('foreign', 'foreign', { type: 'agent.created', name: 'Other' }));
    state = reduceOffice(sampleTemplate, state, meeting);
    expect(state.presences.find(p => p.sessionId === 'foreign')?.intent.kind).toBe('at_desk');
    state = reduceOffice(sampleTemplate, state, event('foreign', 'foreign-done', { type: 'meeting.completed', meetingId: 'sync' }));
    expect(state.meetings).toHaveLength(1);
    state = reduceOffice(sampleTemplate, state, event('s', 'end', { type: 'session.ended' }));
    expect(state.meetings).toHaveLength(0);
    expect(state.presences.filter(p => p.sessionId === 's').every(p => p.intent.kind === 'off_duty')).toBe(true);
    expect(state.presences.find(p => p.sessionId === 'foreign')?.intent.kind).toBe('at_desk');
    expect(state.slots[0]?.state).toBe('AVAILABLE');
  });

  it('releases rooms on failure and cancellation and replays deterministically', () => {
    for (const terminal of [{ type: 'turn.failed', error: 'Failed' }, { type: 'user.intervention', action: 'cancel' }] as ExtaliaEvent['body'][]) {
      const events = [meeting, event('s', 'terminal', terminal)];
      const replay = () => events.reduce((state, e) => reduceOffice(sampleTemplate, state, e), setup());
      expect(replay().meetings).toHaveLength(0);
      expect(replay()).toEqual(replay());
    }
  });
});
