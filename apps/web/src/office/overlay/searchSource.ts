import type { Messages } from '../../i18n';
import type { OfficeActivity } from '../activityFeed';
import { semanticBubble } from '../semanticBubble';
import type { OfficeAgent } from '../presence';
import type { OfficeSearchSource } from './OfficeSearch';
import type { OverlayRoom } from './rooms';
import { agentStatusLabel, statusTone } from './status';

/** "Floor 2", or the outdoor campus label. */
export function roomMeta(t: Messages, room: Pick<OverlayRoom, 'floor' | 'outdoor'>): string {
  return room.outdoor ? t.officeOverlay.rooms.outdoor : t.officeOverlay.rooms.floor(room.floor);
}

/**
 * What the search matches against, in the app language. Offline characters are not in the office, so they are left
 * out, except agents listed under the board's "Earlier" group (v0.0.43), which stay findable there.
 */
export function buildSearchSource(t: Messages, input: {
  presences: readonly OfficeAgent[];
  projects: ReadonlyMap<string, string>;
  rooms: readonly OverlayRoom[];
  board: readonly OfficeActivity[];
  names: ReadonlyMap<string, string>;
}): OfficeSearchSource {
  return {
    agents: input.presences.filter(agent => agent.status !== 'offline' || agent.earlier).map(agent => ({
      id: agent.id, name: agent.displayName, tone: statusTone(agent), status: agent.earlier ? `${agentStatusLabel(t, agent)} · ${t.officeUx.composer.earlierTag}` : agentStatusLabel(t, agent),
      project: input.projects.get(agent.id),
      activity: agent.activity ? t.chat.activity[agent.activity] : undefined,
      // The coarse status ("Working…") stays searchable next to the precise label ("Editing").
      detail: [agent.summary, agent.target, agent.status in t.chat.status ? t.chat.status[agent.status as keyof typeof t.chat.status] : ''].filter(Boolean).join(' '),
    })),
    rooms: input.rooms.map(room => ({
      id: room.id, label: room.label, meta: roomMeta(t, room),
      aliases: [room.registryLabel, room.id.replace(/-/g, ' '), roomMeta(t, room), room.outdoor ? 'outdoor' : `floor ${room.floor} f${room.floor}`],
    })),
    activity: input.board.map(activity => ({
      id: activity.id, characterId: activity.characterId, name: input.names.get(activity.characterId) ?? '',
      kind: t.officeUx.toast[activity.kind], text: semanticBubble(activity, t) ?? '',
    })),
  };
}
