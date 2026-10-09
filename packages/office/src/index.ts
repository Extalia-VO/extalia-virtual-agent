import type { ExtaliaEvent } from '@extalia/protocol';

export type Vec3 = readonly [number, number, number];

export interface RoomDefinition {
  readonly id: string;
  readonly label: string;
  readonly floor: number;
  readonly center: Vec3;
  readonly size: Vec3;
  readonly circulationEntry?: Vec3;
}

export interface FloorDefinition {
  readonly id: string;
  readonly level: number;
  readonly label: string;
  readonly size: readonly [number, number];
  readonly origin: Vec3;
  readonly rooms: readonly RoomDefinition[];
}

export type WorkspaceType =
  | 'leader'
  | 'engineering'
  | 'qa'
  | 'source_control'
  | 'architecture'
  | 'review'
  | 'mission_control'
  | 'creative'
  | 'knowledge'
  | 'general';

export type WorkspaceState = 'AVAILABLE' | 'RESERVED' | 'APPROACHING' | 'OCCUPIED' | 'RELEASING' | 'DISABLED';

export interface WorkstationSlot {
  readonly id: string;
  readonly roomId: string;
  readonly type: WorkspaceType;
  readonly position: Vec3;
  readonly rotationY: number;
  state: WorkspaceState;
  occupantAgentId?: string;
}

export interface OfficePresenceState {
  readonly agentId: string;
  readonly agentName: string;
  readonly role: string;
  status: 'idle' | 'walking' | 'seated' | 'working' | 'meeting' | 'break';
  assignedWorkstationId?: string;
  currentRoomId?: string;
  currentFloor: number;
  position: Vec3;
  targetPosition?: Vec3;
  lastActiveTimestamp: string;
}

/** Pure projection: maps Extalia Protocol events to 3D Office Presence state. */
export function reducePresence(
  current: readonly OfficePresenceState[],
  event: ExtaliaEvent
): readonly OfficePresenceState[] {
  const { body, at, agentId: envelopeAgentId } = event;

  switch (body.type) {
    case 'agent.created': {
      const agentId = envelopeAgentId ?? body.name.toLowerCase();
      const existing = current.find(p => p.agentId === agentId);
      if (existing) return current;

      const initial: OfficePresenceState = {
        agentId,
        agentName: body.name,
        role: body.role ?? 'general',
        status: 'idle',
        currentFloor: 1,
        position: [0, 0, 0],
        lastActiveTimestamp: at
      };
      return [...current, initial];
    }
    case 'agent.state': {
      const agentId = envelopeAgentId ?? 'primary';
      const existing = current.find(p => p.agentId === agentId);
      const officeStatus =
        body.state === 'working' || body.state === 'thinking'
          ? 'working'
          : body.state === 'waiting'
          ? 'seated'
          : 'idle';

      if (existing) {
        return current.map(p =>
          p.agentId === agentId
            ? {
                ...p,
                status: officeStatus,
                lastActiveTimestamp: at
              }
            : p
        );
      }

      const initial: OfficePresenceState = {
        agentId,
        agentName: agentId,
        role: 'general',
        status: officeStatus,
        currentFloor: 1,
        position: [0, 0, 0],
        lastActiveTimestamp: at
      };
      return [...current, initial];
    }
    case 'meeting.started': {
      return current.map(p =>
        body.participants.includes(p.agentId)
          ? { ...p, status: 'meeting', lastActiveTimestamp: at }
          : p
      );
    }
    case 'meeting.completed': {
      return current.map(p =>
        p.status === 'meeting'
          ? { ...p, status: 'idle', lastActiveTimestamp: at }
          : p
      );
    }
    default:
      return current;
  }
}
