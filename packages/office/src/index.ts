import type { ActivityKind, ExtaliaEvent } from '@extalia/protocol';

export type Vec3 = readonly [number, number, number];
export type RoomKind = string;

export const WELL_KNOWN_ROOMS = [
  'executive',
  'engineering',
  'qa',
  'source_control',
  'architecture',
  'review',
  'meeting',
  'library',
  'lobby',
  'rest',
  'mission_control'
] as const;

export type EventPattern = `${string}.${string}` | `${string}.*`;

export interface WorkstationDefinition {
  readonly id: string;
  readonly roomId: string;
  readonly accepts: readonly string[];
  readonly approachWaypointId: string;
  readonly seat: Vec3;
  readonly rotationY: number;
  readonly monitorId?: string;
}

export interface SeatDefinition {
  readonly id: string;
  readonly approachWaypointId: string;
  readonly seat: Vec3;
  readonly rotationY: number;
}

export interface RoomDefinition {
  readonly id: string;
  readonly kind: RoomKind;
  readonly labelKey: string;
  readonly floorId: string;
  readonly center: Vec3;
  readonly size: Vec3;
  readonly entryWaypointId: string;
  readonly capacity?: number;
  readonly subscriptions: readonly EventPattern[];
  readonly workstations: readonly WorkstationDefinition[];
  readonly seats?: readonly SeatDefinition[];
}

export type WaypointKind = 'spawn' | 'corridor' | 'door' | 'approach' | 'connector' | 'idle';

export interface Waypoint {
  readonly id: string;
  readonly floorId: string;
  readonly kind: WaypointKind;
  readonly position: Vec3;
}

export interface WaypointEdge {
  readonly from: string;
  readonly to: string;
  readonly cost?: number;
  readonly bidirectional?: boolean;
}

export interface FloorConnector {
  readonly id: string;
  readonly kind: 'stairs' | 'elevator';
  readonly waypoints: readonly string[];
  readonly traversalMs: number;
}

export interface FloorDefinition {
  readonly id: string;
  readonly level: number;
  readonly labelKey: string;
  readonly size: readonly [number, number];
  readonly origin: Vec3;
  readonly rooms: readonly RoomDefinition[];
  readonly waypoints: readonly Waypoint[];
  readonly edges: readonly WaypointEdge[];
}

export type IdleTarget =
  | { readonly kind: 'desk' }
  | { readonly kind: 'desk_rest' }
  | { readonly kind: 'room'; readonly roomId: string }
  | { readonly kind: 'hidden' };

export interface IdlePolicy {
  readonly default: IdleTarget;
  readonly afterMs?: readonly { readonly ms: number; readonly target: IdleTarget }[];
  readonly byRole?: Readonly<Record<string, IdleTarget>>;
}

export interface AssignmentPolicy {
  readonly byRole: Readonly<Record<string, string>>;
  readonly byAgent?: Readonly<Record<string, string>>;
  readonly subagent: 'near_parent' | 'by_role' | 'overflow';
  readonly overflowRoomId: string;
  readonly sticky: boolean;
}

export interface OfficeTemplate {
  readonly schema: 'extalia.office.v1';
  readonly id: string;
  readonly floors: readonly FloorDefinition[];
  readonly connectors: readonly FloorConnector[];
  readonly assignment: AssignmentPolicy;
  readonly idle: IdlePolicy;
  readonly spawn: { readonly waypointId: string; readonly staggerMs: number };
}

export type SlotState = 'AVAILABLE' | 'RESERVED' | 'OCCUPIED' | 'RELEASING' | 'DISABLED';

export interface SlotStatus {
  readonly slotId: string;
  readonly state: SlotState;
  readonly occupantAgentId?: string;
  readonly since: string;
}

export interface AgentIdentity {
  readonly agentId: string;
  readonly displayName: string;
  readonly role: string;
  readonly parentAgentId?: string;
  readonly kind: 'primary' | 'agent' | 'subagent';
}

export type PresenceIntent =
  | { readonly kind: 'at_desk'; readonly slotId: string; readonly activity: 'working' | 'thinking' | 'waiting' | 'resting' }
  | { readonly kind: 'in_meeting'; readonly meetingId: string; readonly roomId: string; readonly seatId: string }
  | { readonly kind: 'idle_at'; readonly target: IdleTarget }
  | { readonly kind: 'blocked'; readonly slotId?: string }
  | { readonly kind: 'off_duty' }
  | { readonly kind: 'queued_spawn'; readonly order: number };

export interface OfficePresence {
  readonly identity: AgentIdentity;
  readonly intent: PresenceIntent;
  readonly floorId: string;
  readonly destinationWaypointId?: string;
  readonly activityKind?: ActivityKind;
  readonly lastEventId: string;
  readonly lastActiveAt: string;
}

export type OfficePresenceState = OfficePresence;

export interface RoomActivity {
  readonly roomId: string;
  readonly level: 'quiet' | 'active' | 'alert';
  readonly lastEvent?: { readonly type: string; readonly at: string; readonly summary?: string };
  readonly counters: Readonly<Record<string, number>>;
}

export interface OfficeState {
  readonly templateId: string;
  readonly presences: readonly OfficePresence[];
  readonly slots: readonly SlotStatus[];
  readonly meetings: readonly { readonly meetingId: string; readonly roomId: string; readonly participants: readonly string[] }[];
  readonly rooms: readonly RoomActivity[];
  readonly spawnQueue: readonly string[];
}

export function matchesPattern(pattern: EventPattern, type: string): boolean {
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2);
    return type === prefix || type.startsWith(`${prefix}.`);
  }
  return pattern === type;
}

export function initialOfficeState(template: OfficeTemplate): OfficeState {
  const slots: SlotStatus[] = [];
  for (const floor of template.floors) {
    for (const room of floor.rooms) {
      for (const ws of room.workstations) {
        slots.push({
          slotId: ws.id,
          state: 'AVAILABLE',
          since: new Date(0).toISOString()
        });
      }
    }
  }

  const rooms: RoomActivity[] = [];
  for (const floor of template.floors) {
    for (const room of floor.rooms) {
      rooms.push({
        roomId: room.id,
        level: 'quiet',
        counters: {}
      });
    }
  }

  return {
    templateId: template.id,
    presences: [],
    slots,
    meetings: [],
    rooms,
    spawnQueue: []
  };
}

/** Pure deterministic reducer per Invariant I4. Replaying identical events yields deep-equal state. */
export function reduceOffice(
  template: OfficeTemplate,
  state: OfficeState,
  event: ExtaliaEvent
): OfficeState {
  const { body, at, id: eventId, agentId: envelopeAgentId } = event;

  // 1. Room subscription reaction (§23.3)
  let rooms = state.rooms;
  const matchingRooms = template.floors
    .flatMap(f => f.rooms)
    .filter(r => r.subscriptions.some(p => matchesPattern(p, body.type)));

  if (matchingRooms.length > 0) {
    rooms = rooms.map(room => {
      if (!matchingRooms.some(r => r.id === room.roomId)) return room;
      const count = (room.counters[body.type] ?? 0) + 1;
      return {
        ...room,
        level: 'active',
        lastEvent: { type: body.type, at },
        counters: { ...room.counters, [body.type]: count }
      };
    });
  }

  // 2. Lifecycle & Agent Intent Processing
  switch (body.type) {
    case 'agent.created': {
      const agentId = envelopeAgentId ?? body.name;
      if (state.presences.some(p => p.identity.agentId === agentId)) return { ...state, rooms };

      const availableSlot = state.slots.find(s => s.state === 'AVAILABLE');
      const slotId = availableSlot ? availableSlot.slotId : 'overflow';

      const identity: AgentIdentity = {
        agentId,
        displayName: body.name,
        role: body.role ?? 'general',
        parentAgentId: body.parentAgentId,
        kind: 'agent'
      };

      const presence: OfficePresence = {
        identity,
        intent: { kind: 'at_desk', slotId, activity: 'waiting' },
        floorId: template.floors[0]?.id ?? 'floor-1',
        lastEventId: eventId,
        lastActiveAt: at
      };

      const slots = availableSlot
        ? state.slots.map(s => s.slotId === slotId ? { ...s, state: 'OCCUPIED' as SlotState, occupantAgentId: agentId, since: at } : s)
        : state.slots;

      return {
        ...state,
        rooms,
        presences: [...state.presences, presence],
        slots
      };
    }

    case 'subagent.spawned': {
      const { subagentId, role, label } = body;
      if (state.presences.some(p => p.identity.agentId === subagentId)) return { ...state, rooms };

      const availableSlot = state.slots.find(s => s.state === 'AVAILABLE');
      const slotId = availableSlot ? availableSlot.slotId : 'overflow';

      const identity: AgentIdentity = {
        agentId: subagentId,
        displayName: label ?? subagentId,
        role: role ?? 'subagent',
        parentAgentId: envelopeAgentId,
        kind: 'subagent'
      };

      const presence: OfficePresence = {
        identity,
        intent: { kind: 'at_desk', slotId, activity: 'working' },
        floorId: template.floors[0]?.id ?? 'floor-1',
        lastEventId: eventId,
        lastActiveAt: at
      };

      const slots = availableSlot
        ? state.slots.map(s => s.slotId === slotId ? { ...s, state: 'OCCUPIED' as SlotState, occupantAgentId: subagentId, since: at } : s)
        : state.slots;

      return {
        ...state,
        rooms,
        presences: [...state.presences, presence],
        slots
      };
    }

    case 'agent.state': {
      const agentId = envelopeAgentId ?? 'primary';
      const existing = state.presences.find(p => p.identity.agentId === agentId);
      if (!existing) return { ...state, rooms };

      let nextIntent: PresenceIntent = existing.intent;
      if (body.state === 'working' || body.state === 'thinking') {
        const slotId = existing.intent.kind === 'at_desk' ? existing.intent.slotId : 'overflow';
        nextIntent = { kind: 'at_desk', slotId, activity: body.state };
      } else if (body.state === 'waiting') {
        const slotId = existing.intent.kind === 'at_desk' ? existing.intent.slotId : 'overflow';
        nextIntent = { kind: 'at_desk', slotId, activity: 'waiting' };
      } else if (body.state === 'blocked') {
        nextIntent = { kind: 'blocked' };
      } else if (body.state === 'offline') {
        nextIntent = { kind: 'off_duty' };
      } else if (body.state === 'idle') {
        nextIntent = { kind: 'idle_at', target: template.idle.default };
      }

      return {
        ...state,
        rooms,
        presences: state.presences.map(p =>
          p.identity.agentId === agentId
            ? { ...p, intent: nextIntent, activityKind: body.activity, lastEventId: eventId, lastActiveAt: at }
            : p
        )
      };
    }

    case 'agent.stopped': {
      const agentId = envelopeAgentId ?? 'primary';
      const slots = state.slots.map(s =>
        s.occupantAgentId === agentId ? { ...s, state: 'AVAILABLE' as SlotState, occupantAgentId: undefined, since: at } : s
      );

      return {
        ...state,
        rooms,
        presences: state.presences.map(p =>
          p.identity.agentId === agentId
            ? { ...p, intent: { kind: 'off_duty' }, lastEventId: eventId, lastActiveAt: at }
            : p
        ),
        slots
      };
    }

    case 'meeting.started': {
      const { meetingId, participants } = body;
      const meetingRoom = template.floors.flatMap(f => f.rooms).find(r => r.kind === 'meeting');
      const roomId = meetingRoom ? meetingRoom.id : 'room-meeting';

      const meetings = [...state.meetings, { meetingId, roomId, participants }];
      const presences = state.presences.map(p => {
        if (!participants.includes(p.identity.agentId)) return p;
        return {
          ...p,
          intent: { kind: 'in_meeting' as const, meetingId, roomId, seatId: 'seat-1' },
          lastEventId: eventId,
          lastActiveAt: at
        };
      });

      return { ...state, rooms, meetings, presences };
    }

    case 'meeting.completed': {
      const { meetingId } = body;
      const targetMeeting = state.meetings.find(m => m.meetingId === meetingId);
      if (!targetMeeting) return { ...state, rooms };

      const meetings = state.meetings.filter(m => m.meetingId !== meetingId);
      const presences = state.presences.map(p => {
        if (!targetMeeting.participants.includes(p.identity.agentId)) return p;
        return {
          ...p,
          intent: { kind: 'idle_at' as const, target: template.idle.default },
          lastEventId: eventId,
          lastActiveAt: at
        };
      });

      return { ...state, rooms, meetings, presences };
    }

    default:
      return { ...state, rooms };
  }
}
