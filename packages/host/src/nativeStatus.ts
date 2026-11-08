import type { HostMissionRun, NativeActiveRun, NativeStatus, NativeStatusBlocker, NativeStatusMission, NativeStatusRecheck, NativeStatusWorker } from '@extalia/platform';

export const NATIVE_STATUS_LIMITS = { active: 64, workers: 128, missions: 64, blockers: 128 } as const;

/** Detached metadata with lazy task projection; retained answers are never part of this source. */
export interface NativeStatusMissionMetadata extends Omit<NativeStatusMission, 'tasks'> {
  taskCount: number;
  tasks: Iterable<NativeStatusMission['tasks'][number]>;
  recoveryReason?: NativeStatusBlocker['reason'];
}

/** Count relevant metadata while materializing only bounded output. Never spread full mission/task records. */
export function nativeStatusSnapshot(input: {
  backend: NativeStatus['backend'];
  daemon: NativeStatus['daemon'];
  active: NativeActiveRun[];
  workers: NativeStatusWorker[];
  missions: Iterable<NativeStatusMissionMetadata | HostMissionRun>;
  blockers: NativeStatusBlocker[];
  recheck?: NativeStatusRecheck;
}): NativeStatus {
  const active = input.active.slice(0, NATIVE_STATUS_LIMITS.active).map(run => ({ ...run }));
  const missions: NativeStatusMission[] = [];
  const workers = input.workers.slice(0, NATIVE_STATUS_LIMITS.workers).map(worker => ({ ...worker }));
  const blockers = input.blockers.slice(0, NATIVE_STATUS_LIMITS.blockers).map(blocker => ({ ...blocker }));
  const totals = { active: input.active.length, workers: input.workers.length, missions: 0, blockers: input.blockers.length };
  const activeSessions = new Set(input.active.map(run => run.sessionId));
  for (const run of input.missions) {
    if (run.state !== 'running' && run.state !== 'recovering') continue;
    const narrow = 'taskCount' in run;
    totals.missions++;
    totals.workers += narrow ? run.taskCount : run.tasks.length;
    if (run.state === 'recovering') {
      totals.blockers++;
      if (blockers.length < NATIVE_STATUS_LIMITS.blockers) blockers.push({
        id: `mission:${run.id}`, kind: 'mission-recovery', sessionId: run.sessionId, workspaceId: run.workspaceId,
        localActive: activeSessions.has(run.sessionId), missionId: run.id,
        reason: narrow ? run.recoveryReason ?? 'execution-uncertain' : !run.authority ? 'authority-unknown' : run.recovery?.source ?? 'execution-uncertain',
      });
    }
    const includeMission = missions.length < NATIVE_STATUS_LIMITS.missions;
    if (!includeMission && workers.length >= NATIVE_STATUS_LIMITS.workers) continue;
    const tasks: NativeStatusMission['tasks'] = [];
    for (const task of run.tasks) {
      if (includeMission) tasks.push({ id: task.id, taskId: task.taskId, title: task.title, state: task.state });
      if (workers.length < NATIVE_STATUS_LIMITS.workers) workers.push({
        id: `${run.id}:${task.taskId}`, sessionId: run.sessionId, workspaceId: run.workspaceId,
        kind: 'mission-task', state: task.state, active: false,
        evidence: 'recorded-task', label: task.title, missionId: run.id, taskId: task.taskId,
      });
      if (!includeMission && workers.length >= NATIVE_STATUS_LIMITS.workers) break;
    }
    if (includeMission) missions.push({
      id: run.id, sessionId: run.sessionId, workspaceId: run.workspaceId, title: run.title, state: run.state,
      backend: narrow ? run.backend : run.authority?.backend ?? 'unknown', tasks,
    });
  }
  return {
    schema: 'extalia.native-status.v1', sampledAt: new Date().toISOString(), backend: input.backend,
    providerLoop: 'typescript', daemon: { ...input.daemon }, active, workers, missions, blockers, totals,
    truncated: {
      active: totals.active > NATIVE_STATUS_LIMITS.active, workers: totals.workers > NATIVE_STATUS_LIMITS.workers,
      missions: totals.missions > NATIVE_STATUS_LIMITS.missions, blockers: totals.blockers > NATIVE_STATUS_LIMITS.blockers,
    },
    ...(input.recheck ? { recheck: { ...input.recheck } } : {}),
  };
}
