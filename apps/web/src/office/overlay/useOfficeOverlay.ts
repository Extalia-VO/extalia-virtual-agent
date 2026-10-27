import type { HostState } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import { useMemo } from 'react';
import type { Messages } from '../../i18n';
import type { OfficeActivity } from '../activityFeed';
import type { OfficeAgent } from '../presence';
import type { OfficeAgentAllocation } from '../scene/interior/seating';
import { buildOverlayModel } from './model';
import { overlayRooms } from './rooms';
import { buildSearchSource } from './searchSource';
import { useClock } from './useClock';

/** Everything the Office overlay shows, derived once per change from presences, seats, events and the host state. */
export function useOfficeOverlay({ t, presences, allocations, events, recent, state }: {
  t: Messages;
  presences: readonly OfficeAgent[];
  allocations: readonly OfficeAgentAllocation[];
  events: readonly ExtaliaEvent[];
  recent: readonly OfficeActivity[];
  state: HostState | null;
}) {
  const now = useClock();
  const model = useMemo(() => buildOverlayModel({ presences, allocations, events, recent, now }), [presences, allocations, events, recent, now]);
  const rooms = useMemo(() => overlayRooms(t.officeOverlay.rooms.names), [t]);
  const names = useMemo(() => new Map(presences.map(agent => [agent.id, agent.displayName])), [presences]);
  const projects = useMemo(() => {
    const workspaces = new Map((state?.workspaces ?? []).map(workspace => [workspace.id, workspace.name]));
    const bySession = new Map((state?.sessions ?? []).map(session => [session.id, workspaces.get(session.workspaceId)]));
    return new Map(presences.flatMap(agent => {
      const project = bySession.get(agent.sessionId);
      return project ? [[agent.id, project] as const] : [];
    }));
  }, [presences, state]);
  const source = useMemo(() => buildSearchSource(t, { presences, projects, rooms, board: model.board, names }), [t, presences, projects, rooms, model.board, names]);
  return { now, model, rooms, names, projects, source };
}
