import type { SessionSummary } from '@extalia/platform';
import { sessionOrigin } from './agentOrigin';
import { isAdmitted, subagentLingerMs, type OfficeAgent, type PresenceMember, type PresenceTeams } from './presence';
import { lookIdentity } from './scene/avatars/appearance';

interface MemberShift {
  lastUsed: number;
  actual: boolean;
  until?: number;
}
interface TeamShift {
  members: Map<string, MemberShift>;
  lastUsed: number;
}
interface Projection {
  presences: readonly OfficeAgent[];
  sessions: readonly SessionSummary[];
  teams: PresenceTeams;
  now: number;
  /** Omitted only when the caller already has authoritative session history. */
  readySessionIds?: ReadonlySet<string>;
}
interface CurrentTeam {
  session: SessionSummary;
  members: readonly PresenceMember[];
  state: TeamShift;
  needed: number;
  candidates: string[];
}

const STANDBY_CAP = 5;
const timestamp = (value: string): number => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : 0;
};
const currentNativeSessions = (sessions: readonly SessionSummary[]): SessionSummary[] => {
  const current = new Map<string, SessionSummary>();
  const ranked = [...sessions].sort((a, b) => Number(b.running) - Number(a.running)
    || timestamp(b.lastActiveAt) - timestamp(a.lastActiveAt)
    || timestamp(b.createdAt) - timestamp(a.createdAt) || a.id.localeCompare(b.id));
  for (const session of ranked) {
    if (session.control !== 'managed' || current.has(session.workspaceId)) continue;
    current.set(session.workspaceId, session);
  }
  // Select the current managed conversation first: switching a workspace to an
  // external runtime must not revive its previous Native team's standby crew.
  return [...current.values()].filter(session => !session.runtime);
};

/** Current Native team histories needed before Office attendance can be projected. */
export function nativeStandbySessionIds(sessions: readonly SessionSummary[]): string[] {
  // Select before the enabled gate so a newer disabled session suppresses its predecessors.
  return currentNativeSessions(sessions).filter(session => session.team?.enabled).map(session => session.id);
}

const reusable = (agent: OfficeAgent): boolean => agent.status === 'offline'
  && !agent.phase && !agent.stalled && !agent.earlier && !agent.mission && !agent.meeting
  && !agent.pendingApprovalId && !agent.reason;
const inOffice = (agent: OfficeAgent): boolean => agent.status !== 'offline' && !agent.earlier && isAdmitted(agent);

/**
 * In-memory Office attendance only. A shift creates neither runtime work nor protocol events;
 * actual host presence always wins. Keep one instance for the current host/profile.
 */
export class NativeStandbyRotation {
  private readonly shifts = new Map<string, TeamShift>();
  private sequence = 0;
  private clock = Number.NEGATIVE_INFINITY;

  reset(): void {
    this.shifts.clear();
    this.sequence = 0;
    this.clock = Number.NEGATIVE_INFINITY;
  }

  project({ presences, sessions, teams, now, readySessionIds }: Projection): OfficeAgent[] {
    // A backwards wall clock must not renew or prematurely rotate attendance.
    this.clock = Math.max(this.clock, Number.isFinite(now) ? now : 0);
    const at = this.clock;
    const rows = new Map(presences.filter(agent => !agent.nativeStandby).map(agent => [agent.id, agent]));
    // Choose the current conversation before checking eligibility: an ended or
    // disabled current team must not bring an older conversation's crew back.
    const current = currentNativeSessions(sessions).filter(session => session.team?.enabled);
    const ready = (id: string) => readySessionIds === undefined || readySessionIds.has(id);
    const eligible = (session: SessionSummary): boolean => {
      const lead = rows.get(`${session.id}:primary`);
      return Boolean(lead && lead.status !== 'offline' && !lead.earlier && lead.phase !== 'ended');
    };
    // Unknown history cannot admit members or retire an existing attendance cycle.
    const selected = new Set(current.filter(session => !ready(session.id) || eligible(session)).map(session => session.id));
    for (const id of this.shifts.keys()) if (!selected.has(id)) this.shifts.delete(id);

    const activeTeams: CurrentTeam[] = [];
    for (const session of current) {
      if (!ready(session.id) || !eligible(session)) continue;
      const unique = new Map((teams.get(session.id) ?? [])
        .filter(member => member.id && member.id !== 'primary' && member.name.trim())
        .map(member => [member.id, member]));
      const state = this.shifts.get(session.id) ?? { members: new Map<string, MemberShift>(), lastUsed: 0 };
      this.shifts.set(session.id, state);
      for (const id of state.members.keys()) if (!unique.has(id)) state.members.delete(id);
      let coverage = 0;
      const candidates: string[] = [];
      for (const member of unique.values()) {
        const id = `${session.id}:${member.id}`;
        const raw = rows.get(id);
        const actual = raw !== undefined && inOffice(raw);
        const shift = state.members.get(member.id) ?? { lastUsed: 0, actual: false };
        state.members.set(member.id, shift);
        // Remember both ends of a real attendance cycle so a worker whose linger just
        // finished yields to members who have not attended as recently.
        if (actual !== shift.actual) {
          shift.lastUsed = ++this.sequence;
          shift.actual = actual;
        }
        if (actual) coverage++;
        if (actual || (raw && !reusable(raw))) {
          delete shift.until;
          continue;
        }
        if (shift.until !== undefined && at >= shift.until) {
          delete shift.until;
          shift.lastUsed = ++this.sequence;
        }
        candidates.push(member.id);
      }
      const floor = Math.min(unique.size, STANDBY_CAP, 1 + Math.ceil(unique.size / 8));
      const needed = Math.max(0, floor - coverage);
      // Actual activity may fill the floor while a shift is underway. Only synthetic
      // attendance yields; an active, waiting, failed or mission row is never rewritten.
      const leased = candidates.filter(id => state.members.get(id)?.until !== undefined);
      for (const id of leased.slice(needed)) {
        const shift = state.members.get(id)!;
        delete shift.until;
        shift.lastUsed = ++this.sequence;
      }
      activeTeams.push({ session, members: [...unique.values()], state, needed, candidates });
    }

    // Other ready teams may have filled slots during a hydration gap. When the
    // retained team returns, reconcile synthetic leases against the shared cap.
    let retained = 0;
    for (const team of [...activeTeams].sort((a, b) => a.state.lastUsed - b.state.lastUsed || a.session.id.localeCompare(b.session.id))) {
      for (const id of team.candidates) {
        const shift = team.state.members.get(id)!;
        if (shift.until === undefined) continue;
        if (retained++ < STANDBY_CAP) continue;
        delete shift.until;
        shift.lastUsed = ++this.sequence;
      }
    }

    let used = activeTeams.reduce((sum, team) => sum + team.candidates.filter(id => team.state.members.get(id)?.until !== undefined).length, 0);
    // Fill teams a slot at a time, with least recently served teams first. Existing
    // leases stay stable between renders, including session-list reordering.
    while (used < STANDBY_CAP) {
      const available = activeTeams.filter(team => team.candidates.some(id => team.state.members.get(id)?.until === undefined)
        && team.candidates.filter(id => team.state.members.get(id)?.until !== undefined).length < team.needed)
        .sort((a, b) => a.state.lastUsed - b.state.lastUsed || a.session.id.localeCompare(b.session.id));
      const team = available[0];
      if (!team) break;
      const candidate = team.candidates.filter(id => team.state.members.get(id)?.until === undefined)
        .sort((a, b) => team.state.members.get(a)!.lastUsed - team.state.members.get(b)!.lastUsed)[0]!;
      const shift = team.state.members.get(candidate)!;
      shift.until = at + subagentLingerMs(`${team.session.id}:${candidate}`);
      shift.lastUsed = ++this.sequence;
      team.state.lastUsed = this.sequence;
      used++;
    }

    for (const { session, members, state } of activeTeams) {
      for (const member of members) {
        const id = `${session.id}:${member.id}`;
        const raw = rows.get(id);
        if (raw && !reusable(raw)) continue;
        const onShift = state.members.get(member.id)?.until !== undefined;
        rows.set(id, {
          id, sessionId: session.id, agentId: member.id, displayName: member.name.trim(), control: 'managed',
          status: onShift ? 'idle' : 'offline', running: false, parentId: `${session.id}:primary`,
          nativeStandby: onShift ? 'on-shift' : 'off-shift', origin: sessionOrigin(session),
          look: lookIdentity(member.name, member.gender), ...(member.model ? { model: member.model } : {}),
        });
      }
    }
    return [...rows.values()];
  }
}
