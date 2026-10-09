import type { ActivityKind, ExtaliaEvent } from '@extalia/protocol';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

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

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dist2 = (a: Vec2, b: Vec2): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

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

// ───────────────────────── NavGraph & A* Pathfinding (Opus/Sonnet Logic) ─────────────────────────

export interface NavNode {
  readonly id: string;
  readonly floorId: string;
  readonly pos: Vec2;
}

export interface NavEdge {
  readonly to: string;
  readonly cost: number;
}

export interface NavGraph {
  readonly nodes: ReadonlyMap<string, NavNode>;
  readonly edges: ReadonlyMap<string, readonly NavEdge[]>;
}

export interface Route {
  readonly nodeIds: readonly string[];
  readonly cost: number;
}

export function buildNavGraph(template: OfficeTemplate): NavGraph {
  const nodes = new Map<string, NavNode>();
  const adj = new Map<string, NavEdge[]>();

  for (const floor of template.floors) {
    for (const wp of floor.waypoints) {
      nodes.set(wp.id, {
        id: wp.id,
        floorId: wp.floorId,
        pos: { x: wp.position[0], y: wp.position[2] }
      });
      adj.set(wp.id, []);
    }
  }

  const addEdge = (from: string, to: string, cost: number) => {
    const list = adj.get(from);
    if (list && !list.some(e => e.to === to)) {
      list.push({ to, cost });
    }
  };

  for (const floor of template.floors) {
    for (const edge of floor.edges) {
      const fromNode = nodes.get(edge.from);
      const toNode = nodes.get(edge.to);
      if (fromNode && toNode) {
        const cost = edge.cost ?? Math.sqrt(dist2(fromNode.pos, toNode.pos));
        addEdge(edge.from, edge.to, cost);
        if (edge.bidirectional !== false) {
          addEdge(edge.to, edge.from, cost);
        }
      }
    }
  }

  const edges = new Map<string, readonly NavEdge[]>();
  for (const [id, list] of adj) {
    edges.set(id, [...list].sort((a, b) => cmp(a.to, b.to)));
  }

  return { nodes, edges };
}

export function findRoute(graph: NavGraph, from: string, to: string): Route | null {
  const start = graph.nodes.get(from);
  const goal = graph.nodes.get(to);
  if (!start || !goal) return null;
  if (from === to) return { nodeIds: [from], cost: 0 };

  const h = (n: NavNode): number => Math.sqrt(dist2(n.pos, goal.pos));
  const g = new Map<string, number>([[from, 0]]);
  const parent = new Map<string, string>();
  const closed = new Set<string>();

  interface PriorityQueueEntry { id: string; f: number; h: number }
  const open: PriorityQueueEntry[] = [{ id: from, f: h(start), h: h(start) }];

  while (open.length > 0) {
    open.sort((a, b) => a.f - b.f || a.h - b.h || cmp(a.id, b.id));
    const current = open.shift()!;
    if (closed.has(current.id)) continue;
    if (current.id === to) {
      const path: string[] = [to];
      let p = parent.get(to);
      while (p) {
        path.push(p);
        p = parent.get(p);
      }
      path.reverse();
      return { nodeIds: path, cost: g.get(to) ?? 0 };
    }

    closed.add(current.id);

    for (const edge of graph.edges.get(current.id) ?? []) {
      if (closed.has(edge.to)) continue;
      const targetNode = graph.nodes.get(edge.to);
      if (!targetNode) continue;

      const ng = (g.get(current.id) ?? 0) + edge.cost;
      if (ng < (g.get(edge.to) ?? Infinity)) {
        g.set(edge.to, ng);
        parent.set(edge.to, current.id);
        const nh = h(targetNode);
        open.push({ id: edge.to, f: ng + nh, h: nh });
      }
    }
  }

  return null;
}

// ───────────────────────── Deterministic Slot Allocation Logic ─────────────────────────

export type AllocationReason = 'byAgent' | 'sticky' | 'near_parent' | 'byRole' | 'overflow';

export interface AllocationOutput {
  readonly slotId: string;
  readonly reason: AllocationReason;
}

export function allocateSlot(
  template: OfficeTemplate,
  slots: readonly SlotStatus[],
  agent: AgentIdentity,
  previousSlotId?: string
): AllocationOutput | null {
  const freeSlots = slots.filter(s => s.state === 'AVAILABLE').map(s => s.slotId).sort(cmp);
  if (!freeSlots.length) return null;

  // 1. byAgent pin
  if (template.assignment.byAgent && template.assignment.byAgent[agent.agentId]) {
    const pinned = template.assignment.byAgent[agent.agentId]!;
    if (freeSlots.includes(pinned)) {
      return { slotId: pinned, reason: 'byAgent' };
    }
  }

  // 2. sticky desk
  if (template.assignment.sticky && previousSlotId && freeSlots.includes(previousSlotId)) {
    return { slotId: previousSlotId, reason: 'sticky' };
  }

  // 3. near_parent (for subagents)
  if (agent.kind === 'subagent' && agent.parentAgentId && template.assignment.subagent === 'near_parent') {
    const parentOccupied = slots.find(s => s.occupantAgentId === agent.parentAgentId);
    if (parentOccupied) {
      const parentRoom = template.floors.flatMap(f => f.rooms).find(r => r.workstations.some(w => w.id === parentOccupied.slotId));
      if (parentRoom) {
        const roomFree = parentRoom.workstations.map(w => w.id).filter(id => freeSlots.includes(id)).sort(cmp);
        if (roomFree[0]) {
          return { slotId: roomFree[0], reason: 'near_parent' };
        }
      }
    }
  }

  // 4. byRole
  const targetRoomIdOrKind = template.assignment.byRole[agent.role];
  if (targetRoomIdOrKind) {
    const matchingRooms = template.floors.flatMap(f => f.rooms).filter(r => r.id === targetRoomIdOrKind || r.kind === targetRoomIdOrKind);
    const candidateWorkstations = matchingRooms.flatMap(r => r.workstations).map(w => w.id).filter(id => freeSlots.includes(id)).sort(cmp);
    if (candidateWorkstations[0]) {
      return { slotId: candidateWorkstations[0], reason: 'byRole' };
    }
  }

  // 5. overflow
  const overflowRoom = template.floors.flatMap(f => f.rooms).find(r => r.id === template.assignment.overflowRoomId);
  if (overflowRoom) {
    const overflowWorkstations = overflowRoom.workstations.map(w => w.id).filter(id => freeSlots.includes(id)).sort(cmp);
    if (overflowWorkstations[0]) {
      return { slotId: overflowWorkstations[0], reason: 'overflow' };
    }
  }

  // Fallback to lowest free slot ID (deterministic)
  return { slotId: freeSlots[0]!, reason: 'overflow' };
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
    slots: slots.sort((a, b) => cmp(a.slotId, b.slotId)),
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

      const identity: AgentIdentity = {
        agentId,
        displayName: body.name,
        role: body.role ?? 'primary',
        parentAgentId: body.parentAgentId,
        kind: 'primary'
      };

      const allocation = allocateSlot(template, state.slots, identity);
      const slotId = allocation ? allocation.slotId : 'overflow';

      const presence: OfficePresence = {
        identity,
        intent: { kind: 'at_desk', slotId, activity: 'waiting' },
        floorId: template.floors[0]?.id ?? 'floor-1',
        lastEventId: eventId,
        lastActiveAt: at
      };

      const slots = allocation
        ? state.slots.map(s => s.slotId === slotId ? { ...s, state: 'OCCUPIED' as SlotState, occupantAgentId: agentId, since: at } : s)
        : state.slots;

      return {
        ...state,
        rooms,
        presences: [...state.presences, presence].sort((a, b) => cmp(a.identity.agentId, b.identity.agentId)),
        slots
      };
    }

    case 'subagent.spawned': {
      const { subagentId, role, label } = body;
      if (state.presences.some(p => p.identity.agentId === subagentId)) return { ...state, rooms };

      const identity: AgentIdentity = {
        agentId: subagentId,
        displayName: label ?? subagentId,
        role: role ?? 'subagent',
        parentAgentId: envelopeAgentId,
        kind: 'subagent'
      };

      const allocation = allocateSlot(template, state.slots, identity);
      const slotId = allocation ? allocation.slotId : 'overflow';

      const presence: OfficePresence = {
        identity,
        intent: { kind: 'at_desk', slotId, activity: 'working' },
        floorId: template.floors[0]?.id ?? 'floor-1',
        lastEventId: eventId,
        lastActiveAt: at
      };

      const slots = allocation
        ? state.slots.map(s => s.slotId === slotId ? { ...s, state: 'OCCUPIED' as SlotState, occupantAgentId: subagentId, since: at } : s)
        : state.slots;

      return {
        ...state,
        rooms,
        presences: [...state.presences, presence].sort((a, b) => cmp(a.identity.agentId, b.identity.agentId)),
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
