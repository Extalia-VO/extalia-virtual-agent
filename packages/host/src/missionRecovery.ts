/** Read-only canonical inspection and narrowly scoped host-restart projection repair (ADR 0030). */
import type { HostMissionRecoveryReason, HostMissionRecoveryResult, HostMissionRun } from '@extalia/platform';
import type { DaemonMissionSnapshot } from '@extalia/protocol';
import type { MissionRecords } from './mission.js';

const terminal = (state: string) => ['completed', 'failed', 'cancelled'].includes(state);

export class MissionRecovery {
  private readonly pending = new Map<string, Promise<HostMissionRecoveryResult>>();
  constructor(private readonly options: {
    records: MissionRecords;
    profileId: string;
    /** Includes preparation reservations and current-process physical execution guards. */
    active(sessionId: string): boolean;
    snapshot(missionId: string): Promise<DaemonMissionSnapshot | undefined>;
  }) {}

  refresh(sessionId: string, missionId: string): Promise<HostMissionRecoveryResult> {
    const key = JSON.stringify([sessionId, missionId]);
    const previous = this.pending.get(key);
    if (previous) return previous.then(value => structuredClone(value));
    const work = this.inspect(sessionId, missionId).finally(() => { this.pending.delete(key); });
    this.pending.set(key, work);
    return work.then(value => structuredClone(value));
  }

  private async inspect(sessionId: string, missionId: string): Promise<HostMissionRecoveryResult> {
    const { records } = this.options;
    let run = records.get(sessionId, missionId);
    const refused = (reason: HostMissionRecoveryReason, snapshot?: DaemonMissionSnapshot, status: 'quarantined' | 'unavailable' = 'quarantined'): HostMissionRecoveryResult => ({
      run: records.get(sessionId, missionId), status, reason, ...(snapshot ? { snapshot } : {}),
    });
    const active = () => this.options.active(sessionId) || records.isReserved(sessionId);
    if (active()) return refused('local-active');
    if (!run.authority) return refused('authority-unknown');
    if (run.authority.backend !== 'rust') return refused('authority-typescript');
    if (run.authority.profileId !== this.options.profileId) return refused('profile-mismatch');
    let snapshot: DaemonMissionSnapshot | undefined;
    try { snapshot = await this.options.snapshot(missionId); }
    catch { return refused('core-unavailable', undefined, 'unavailable'); }
    if (!snapshot) return refused('snapshot-unsupported', undefined, 'unavailable');
    // Awaiting the daemon is a scheduling boundary: all local guards and saved identities must be re-read.
    if (active()) return refused('local-active');
    run = records.get(sessionId, missionId);
    if (run.authority?.backend !== 'rust' || run.authority.profileId !== this.options.profileId
      || snapshot.missionId !== run.id || snapshot.workspaceId !== run.authority.workspaceId
      || snapshot.tasks.length !== run.tasks.length || new Set(snapshot.tasks.map(task => task.taskId)).size !== run.tasks.length
      || run.tasks.some(task => !snapshot!.tasks.some(canonical => canonical.taskId === task.taskId && canonical.assignedAgentId === task.agentId))) return refused('identity-mismatch');
    // Current-process unknown/persistence failures cannot establish physical settlement. Only a
    // persisted marker written during startup under the profile lock proves the prior host ended.
    if (run.state === 'recovering' && run.recovery?.source !== 'host-restart') return refused('execution-uncertain', snapshot);
    if (!terminal(snapshot.state)) return refused('canonical-nonterminal', snapshot);
    if (!snapshot.tasks.every(task => terminal(task.state))) return refused('tasks-nonterminal', snapshot);
    if (snapshot.leases.length) return refused('leases-present', snapshot);
    if (run.state === 'running') return refused('local-active', snapshot);
    if (run.state !== 'recovering') return { run, status: 'refreshed', snapshot };
    const next: HostMissionRun = {
      ...run, state: snapshot.state as 'completed' | 'failed' | 'cancelled', updatedAt: snapshot.updatedAt,
      tasks: run.tasks.map(task => {
        const canonical = snapshot!.tasks.find(item => item.taskId === task.taskId)!;
        const { answer, verification, reason, ...retained } = task;
        const keepAnswer = canonical.state === 'completed' && task.state === 'completed' && answer !== undefined;
        return { ...retained, state: canonical.state,
          ...(keepAnswer ? { answer, ...(verification ? { verification } : {}) } : {}),
          ...(reason && reason !== 'host-restarted' && task.state === canonical.state ? { reason } : {}),
        };
      }),
    };
    try { await records.save(next); }
    catch { return refused('checkpoint-unavailable', snapshot, 'unavailable'); }
    return { run: records.get(sessionId, missionId), status: 'refreshed', snapshot };
  }
}
