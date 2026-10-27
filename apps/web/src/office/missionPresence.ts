import type { HostMissionRun } from '@extalia/platform';
import type { ExtaliaEvent, TaskState } from '@extalia/protocol';

/**
 * v0.0.47 (ADR 0016): native mission workers in the Office. The host projects each mission into the session's
 * v0 event log (`correlationId` = mission id): the lead announces every worker (`subagent.spawned`, then the
 * task's `task.created`), workers report `task.assigned`, `agent.state` and read/search `tool.*`, and each task
 * ends with `task.completed` (plus an `agent.state` that says how a failure ended). The retained mission record
 * (`listNativeMissions`) adds the mission title, each worker's connection and the exact failure reason, and is
 * authoritative for terminal and unknown task states. Nothing here invents work: a worker that never started
 * stays queued (not admitted into the 3D office), and work whose end was never confirmed is `unknown`, never idle.
 */
export type MissionWorkerState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked' | 'unknown';

export interface OfficeMissionWork {
  missionId: string;
  /** The mission's title (retained record, else the lead's "Native mission: …" prompt). */
  missionTitle?: string;
  taskId?: string;
  /** The task title (the worker's task line). Never instructions or answers. */
  taskTitle?: string;
  state: MissionWorkerState;
  /** The worker started (assigned or reported work); a queued or never-started worker is not admitted into the 3D office. */
  admitted: boolean;
  /** Retained reason code of a failed, blocked, cancelled or unknown task (`provider-failed`, `timeout`, …). */
  reason?: string;
  /** Display name of the saved connection the task runs on. */
  provider?: string;
  /** The exact model of the task. */
  model?: string;
  /** When its task ended (epoch ms), for the Ready linger before it leaves. */
  endedAt?: number;
}

/** What the Office reads from a retained mission record, per worker agent id. */
export interface OfficeMissionTaskInfo { taskId: string; title: string; state: TaskState; reason?: string; provider?: string; model: string }
export interface OfficeMissionInfo { id: string; title: string; state: HostMissionRun['state']; updatedAt: number; tasks: ReadonlyMap<string, OfficeMissionTaskInfo> }
/** Retained mission records by mission id. */
export type OfficeMissions = ReadonlyMap<string, OfficeMissionInfo>;

/** The Office view of one retained mission record; `connectionName` resolves a saved connection's display name. */
export function missionInfo(run: HostMissionRun, connectionName: (id: string) => string | undefined = () => undefined): OfficeMissionInfo {
  const updatedAt = Date.parse(run.updatedAt);
  return {
    id: run.id, title: run.title, state: run.state, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    tasks: new Map(run.tasks.map(task => {
      const provider = connectionName(task.connectionId);
      return [task.agentId, { taskId: task.taskId, title: task.title, state: task.state, model: task.model, ...(task.reason ? { reason: task.reason } : {}), ...(provider ? { provider } : {}) }];
    })),
  };
}

const MISSION_PROMPT = 'Native mission: ';
const TERMINAL: ReadonlySet<MissionWorkerState> = new Set(['completed', 'failed', 'cancelled', 'blocked', 'unknown']);
const AT_WORK: ReadonlySet<string> = new Set(['working', 'thinking', 'delegating']);

/** A retained task state in the Office's worker states; states between queued and done count as running. */
function workerState(state: TaskState): MissionWorkerState {
  switch (state) {
    case 'queued': return 'queued';
    case 'completed': case 'failed': case 'cancelled': case 'blocked': case 'unknown': return state;
    default: return 'running';
  }
}

export const isMissionTerminal = (state: MissionWorkerState): boolean => TERMINAL.has(state);

/**
 * Mission workers of one session, keyed by worker agent id, from its events (sorted oldest first) and, when known,
 * the retained mission records. `running` is the host's word that the session's turn is still in progress: a
 * worker not finished when its mission ended (or its session stopped) is `unknown` (needs reconciliation).
 */
export function foldMissionWorkers(events: readonly ExtaliaEvent[], running: boolean, missions: OfficeMissions = new Map()): Map<string, OfficeMissionWork> {
  const titles = new Map<string, string>();
  const ended = new Map<string, number>();
  const workers = new Map<string, OfficeMissionWork & { failing?: boolean }>();
  let announced: string | undefined;
  for (const event of events) {
    const missionId = event.correlationId;
    if (!missionId || event.source.channel === 'import') continue;
    const at = Date.parse(event.at);
    const body = event.body;
    const agentId = event.agentId ?? 'primary';
    if (agentId === 'primary') {
      if (body.type === 'prompt.submitted' && body.text.startsWith(MISSION_PROMPT)) titles.set(missionId, body.text.slice(MISSION_PROMPT.length).trim());
      else if (body.type === 'subagent.spawned') {
        workers.set(body.subagentId, { missionId, state: 'queued', admitted: false, ...(body.label ? { taskTitle: body.label } : {}), ...(body.model?.trim() ? { model: body.model.trim() } : {}) });
        announced = body.subagentId;
      } else if (body.type === 'task.created' && event.taskId && announced) {
        // The host announces each worker and then its task: the task right after a spawn is that worker's.
        const worker = workers.get(announced);
        if (worker?.missionId === missionId && !worker.taskId) worker.taskId = event.taskId;
        announced = undefined;
      } else if (body.type === 'turn.completed' || body.type === 'turn.failed' || (body.type === 'agent.state' && body.state === 'blocked')) {
        // The mission ended (a blocked lead: it needs reconciliation).
        if (!ended.has(missionId)) ended.set(missionId, Number.isFinite(at) ? at : 0);
      }
      continue;
    }
    const worker = workers.get(agentId);
    if (!worker || worker.missionId !== missionId) continue;
    if (event.taskId && !worker.taskId) worker.taskId = event.taskId;
    const end = () => { if (Number.isFinite(at)) worker.endedAt = at; };
    switch (body.type) {
      case 'task.assigned': case 'tool.started': case 'tool.completed':
        if (!isMissionTerminal(worker.state)) { worker.state = 'running'; worker.admitted = true; }
        break;
      case 'agent.state':
        if (worker.failing) {
          // How an unsuccessful task ended: a stop, an error, or blocked (never started) / unknown (it had started).
          delete worker.failing;
          worker.state = body.phase === 'interrupted' ? 'cancelled' : body.state === 'blocked' ? (worker.admitted ? 'unknown' : 'blocked') : 'failed';
        } else if (!isMissionTerminal(worker.state) && AT_WORK.has(body.state)) { worker.state = 'running'; worker.admitted = true; }
        break;
      case 'task.completed':
        if (isMissionTerminal(worker.state)) break;
        worker.state = body.ok ? 'completed' : 'failed';
        if (!body.ok) worker.failing = true;
        end();
        break;
      default: break;
    }
  }
  const result = new Map<string, OfficeMissionWork>();
  for (const [agentId, folded] of workers) {
    const { failing: _failing, ...work } = folded;
    const info = missions.get(work.missionId);
    const title = info?.title ?? titles.get(work.missionId);
    if (title) work.missionTitle = title;
    const task = info?.tasks.get(agentId);
    if (task) {
      work.taskId = task.taskId; work.taskTitle = task.title; work.model = task.model;
      if (task.provider) work.provider = task.provider;
      const retained = workerState(task.state);
      // A retained terminal state is authoritative (it names unknown and blocked exactly); events may be ahead of it otherwise.
      if (isMissionTerminal(retained)) {
        if (work.state !== retained) work.endedAt = work.endedAt ?? info!.updatedAt;
        work.state = retained;
        if (task.reason) work.reason = task.reason;
      } else if (info!.state === 'recovering' && !isMissionTerminal(work.state)) {
        // A recovering run is never replayed: started work has an unknown outcome; a task its checkpoint shows queued never started.
        work.state = retained === 'queued' && !work.admitted ? 'blocked' : 'unknown';
        if (work.state === 'blocked') work.endedAt = info!.updatedAt;
      }
    }
    // Not finished although its mission ended or its session stopped: the outcome was never confirmed.
    if (!isMissionTerminal(work.state) && (ended.has(work.missionId) || !running)) work.state = 'unknown';
    // Unknown work may have started: it keeps a desk (no work animation) until reconciled, and never lingers out.
    if (work.state === 'unknown') { delete work.endedAt; work.admitted = true; }
    result.set(agentId, work);
  }
  return result;
}
