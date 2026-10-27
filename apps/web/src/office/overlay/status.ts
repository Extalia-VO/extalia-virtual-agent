import type { Messages } from '../../i18n';
import type { OfficeAgent } from '../presence';

type StatusAgent = Pick<OfficeAgent, 'status'> & Partial<Pick<OfficeAgent, 'phase' | 'activity' | 'toolName' | 'pendingApprovalId' | 'reason' | 'stalled' | 'lastActivityAt' | 'mission'>>;

/**
 * v0.0.47 (ADR 0016): the label a mission worker's task state sets, or undefined when its own reports say more
 * (running: reading, searching, thinking; ended well: Ready). Queued, never started, failed (with its short
 * reason) and unknown are explicit: unknown is never shown as Ready.
 */
export function missionStatusLabel(t: Messages, agent: Pick<OfficeAgent, 'status'> & Partial<Pick<OfficeAgent, 'mission'>>): string | undefined {
  const mission = agent.mission;
  if (!mission || agent.status === 'offline') return undefined;
  const m = t.officeMissions;
  switch (mission.state) {
    case 'queued': return m.queued;
    case 'unknown': return m.unknown;
    case 'failed': { const reason = mission.reason ? m.reasons[mission.reason] : undefined; return reason ? m.error(reason) : m.errorPlain; }
    case 'blocked': return m.notStarted;
    case 'cancelled': return mission.admitted ? undefined : m.notStarted;
    default: return undefined;
  }
}

const timeFormats = new Map<string, Intl.DateTimeFormat>();
/** The clock time of an ISO instant ("14:05", "2:05 PM"), in `locale` (the runtime's when absent). */
export function clockTime(iso: string | undefined, locale?: string): string | undefined {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return undefined;
  const key = locale ?? '';
  let format = timeFormats.get(key);
  if (!format) { format = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }); timeFormats.set(key, format); }
  return format.format(at);
}

/**
 * The text for a presence's reported status; observed characters are described, never called running.
 * v0.0.38: the label is as precise as the source allows — the stated phase (planning, waiting for approval or
 * for you, compacting, interrupted, error, ended), else the activity kind (reading, editing, running a command
 * or tests, searching, browsing, using a named MCP tool, delegating), else the bare status. Only fixed catalog
 * words and MCP server/tool names are shown: never a command, path or reply text.
 */
export function agentStatusLabel(t: Messages, agent: StatusAgent, locale?: string): string {
  if (agent.status === 'observing') return t.office.observing;
  if (agent.status === 'paused') return t.observer.paused;
  if (agent.status === 'unavailable') return t.observer.unavailable;
  const mission = missionStatusLabel(t, agent);
  if (mission) return mission;
  const detail = t.chat.detail;
  if (agent.pendingApprovalId) return detail.phase.approval;
  // v0.0.43: silent past its state's allowance: no response since it was last heard (see `stallAfterMs`).
  if (agent.stalled && agent.status !== 'offline') {
    const since = clockTime(agent.lastActivityAt, locale);
    return since ? detail.noResponseSince(since) : detail.noResponse;
  }
  if (agent.status === 'offline') return agent.phase === 'ended' ? detail.phase.ended : t.chat.status.offline;
  // v0.0.43: a failed turn says why when the source did (out of tokens or quota, rate limited, signed out, …).
  if (agent.phase === 'error' && agent.reason && agent.reason !== 'interrupted') return detail.reason[agent.reason];
  if (agent.phase) return detail.phase[agent.phase];
  switch (agent.status) {
    case 'working': case 'thinking': case 'delegating':
      if (agent.activity === 'tool' && agent.toolName) return detail.usingTool(agent.toolName);
      if (agent.activity) return detail.activity[agent.activity];
      return detail[agent.status];
    default: return t.chat.status[agent.status];
  }
}

/** Coarse color group for status dots and chips (the CSS maps each tone to a color); `warn`: not responding (v0.0.43). */
export type StatusTone = 'work' | 'wait' | 'observe' | 'warn' | 'error' | 'idle';

export function statusTone(agent: Pick<OfficeAgent, 'status' | 'pendingApprovalId'> & Partial<Pick<OfficeAgent, 'phase' | 'stalled' | 'mission'>>): StatusTone {
  if (agent.pendingApprovalId) return 'wait';
  // v0.0.47: a mission task whose outcome is unknown needs a look, like an agent that stopped responding.
  if (agent.mission?.state === 'unknown' && agent.status !== 'offline') return 'warn';
  if (agent.stalled && agent.status !== 'offline') return 'warn';
  if (agent.phase === 'error') return 'error';
  switch (agent.status) {
    case 'working': case 'thinking': case 'delegating': return 'work';
    case 'waiting': case 'stopping': return 'wait';
    case 'observing': case 'paused': return 'observe';
    case 'blocked': case 'unavailable': return 'error';
    default: return 'idle';
  }
}
