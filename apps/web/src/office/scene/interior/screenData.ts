import type { ActivityKind } from '@extalia/protocol';
import type { OfficeAgent } from '../../presence';
import { resourceById } from './resourceRegistry';
import type { FurnishedFloorState } from './FurnishedFloorContext';
import { officeInteriorText } from '../../../i18n';

export interface SmartScreenData {
  title: string;
  subtitle?: string;
  status?: string;
  rows?: { label: string; value: string }[];
  progress?: number;
  resourceId?: string;
  activity?: { kind: ActivityKind; target?: string; label?: string };
  /** Only renderer data backed by a session can activate a display. */
  sessionBacked?: boolean;
}

export function resourceIdForLocation(locationPrefix: string): string | undefined {
  if (resourceById(locationPrefix)) return locationPrefix;
  const teamSeat = locationPrefix.match(/^floor-1\.team-workspace\.(pod-[a-d])\.(seat-[a-z]+)$/);
  if (teamSeat) return `engineering.${teamSeat[1]}.${teamSeat[2]}`;
  const touchdown = locationPrefix.match(/^floor-1\.team-workspace\.(touchdown-\d+)$/);
  if (touchdown) return `engineering.${touchdown[1]}`;

  const roomMatch = locationPrefix.match(/^floor-(?:1|2|3)\.(.*)$/);
  const location = roomMatch?.[1] ?? locationPrefix;
  if (location === "operations") return "operations.station-1";
  if (location === "source-control.commit") return "source-control.commit";
  if (location === "source-control.laptop") return "source-control.laptop";
  if (location === "library.laptop") return "library.laptop";
  if (location === "architecture.laptop") return "architecture.laptop";
  if (location === "knowledge.laptop") return "knowledge.laptop";
  if (location.startsWith("research.laptop-")) return location;
  if (location.startsWith("qa.station-")) return location;
  if (location.startsWith("mission-control.station-")) return location;
  if (location.startsWith("review-security.station-")) {
    return location.replace("review-security.", "review.");
  }
  if (location.startsWith("multi-engine.station-")) return location;
  if (location.startsWith("knowledge.terminal-")) {
    return location.replace("knowledge.", "sanctuary.");
  }
  if (location.startsWith("flex.station-")) return location;
  if (location.startsWith("research.station-")) {
    return location.replace("research.station-", "research.laptop-");
  }
  if (location === "executive-studio") return "executive-studio.ceo";
  return undefined;
}

function forAgent(state: FurnishedFloorState, agent?: OfficeAgent): SmartScreenData {
  const t = (text: string) => officeInteriorText(state.language, text);
  if (!agent) return { title: t('AVAILABLE'), status: t('STANDBY') };
  return { title: agent.displayName, subtitle: agent.summary, status: agent.status,
    sessionBacked: true,
    rows: [
      { label: t('SESSION'), value: agent.sessionId },
      { label: t('STATUS'), value: agent.status },
      ...(agent.activity ? [{ label: t('ACTIVITY'), value: agent.activity }] : []),
      ...(agent.target ? [{ label: t('TARGET'), value: agent.target }] : []),
    ],
    ...(agent.activity ? { activity: { kind: agent.activity, target: agent.target, label: agent.summary } } : {}),
  };
}
export function screenForLocation(state: FurnishedFloorState, location: string): SmartScreenData {
  const resourceId = resourceIdForLocation(location);
  const allocation = state.allocations.find(allocation => allocation.resourceId === resourceId);
  return { ...forAgent(state, state.agents.find(agent => agent.id === allocation?.agentId)), resourceId };
}
export function executiveScreens(state: FurnishedFloorState): [SmartScreenData, SmartScreenData, SmartScreenData] {
  const allocation = state.allocations.find(allocation => allocation.resourceId === 'executive.leader');
  const data = { ...forAgent(state, state.agents.find(agent => agent.id === allocation?.agentId)), resourceId: 'executive.leader' };
  return [data, data, data];
}
export function missionControlScreen(state: FurnishedFloorState): SmartScreenData {
  const t = (text: string) => officeInteriorText(state.language, text);
  const agents = state.agents.filter(agent => agent.status !== 'offline');
  return { title: t('SESSION OVERVIEW'), status: agents.length ? t('SESSIONS') : t('STANDBY'),
    sessionBacked: agents.length > 0,
    rows: agents.slice(0, 5).map(agent => ({ label: agent.displayName, value: agent.status })),
  };
}
export function meetingScreen(state: FurnishedFloorState, _roomId: string): SmartScreenData {
  // Room occupancy is not inferred from an agent's task or engine.
  return { title: officeInteriorText(state.language, 'STANDBY') };
}
