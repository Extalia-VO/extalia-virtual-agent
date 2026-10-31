/**
 * A native mission owned by the Rust core (audit PR 8, ADR 0019 single owner): created
 * with `mission.create`, its runtime events acknowledged by the daemon's journal and its
 * worker tool calls decided by `permission.check` (ADR 0026).
 *
 * Task state events become `task.transition` compare-and-set requests from the last
 * acknowledged state; every other control event is an `event.commit`. Each mission is
 * bound to the connection that created it: if that daemon process ends, later commits
 * reject and permission checks deny with `policy_unavailable`, even after a restart.
 */
import { ORCHESTRATION_SCHEMA_VERSION, type AgentEvent, type DaemonExecutionAdmission, type DaemonLeaseClaim, type OrchestrationPlan, type TaskState } from '@extalia/protocol';
import { randomUUID } from 'node:crypto';
import { POLICY_UNAVAILABLE, type NativeLocalOperationsDrained, type NativeTurnSettlement, type PermissionRequest, type PermissionVerdict } from '@extalia/runtime';
import { DaemonUnavailableError, type DaemonClient } from './client.js';

/** Independent of provider activity; well inside the daemon's ten-minute lease. */
export const MISSION_HEARTBEAT_MS = 30_000;
const leased = (state: TaskState) => ['running', 'waiting', 'awaiting_approval', 'verifying'].includes(state);

export interface DaemonMission {
  readonly supervisorId: string;
  /** Permanent authority loss, distinct from a user's cancellation request. */
  readonly authoritySignal: AbortSignal;
  /** Stop renewal and ignore already-pending renewal replies after invocation settlement. */
  dispose(): void;
  /** Commit one runtime event; resolves to the daemon's per-mission sequence. */
  commit(event: AgentEvent): Promise<number>;
  checkPermission(request: PermissionRequest): Promise<PermissionVerdict>;
  /** Weak observation on the original connection; never restores execution authority. */
  observeTurnSettlement(observation: NativeTurnSettlement): Promise<void>;
  recordLocalDrain(proof: NativeLocalOperationsDrained): Promise<void>;
  /** Best effort for a mission that never started: record it as cancelled by its lead. */
  cancelUnstarted(sessionId: string): Promise<void>;
}

export async function createDaemonMission(client: DaemonClient, plan: Pick<OrchestrationPlan, 'mission' | 'graph'>): Promise<DaemonMission> {
  if (!['mission.heartbeat', 'execution.observe', 'execution.recordLocalDrain', 'mission.executions'].every(op => client.capabilities.some(capability => capability === op))) throw new DaemonUnavailableError('missing_capability');
  const missionId = plan.mission.id;
  const supervisorId = randomUUID();
  const created = await client.request('mission.create', { mission: plan.mission, graph: plan.graph });
  if (created.missionId !== missionId) throw new Error('The native core acknowledged another mission.');
  const states = new Map<string, TaskState>(plan.graph.tasks.map(task => [task.id, task.state]));
  const assignees = new Map(plan.graph.tasks.map(task => [task.id, task.assignedAgentId]));
  const claims = new Map<string, DaemonLeaseClaim>();
  const acquired = new Map<string, string>();
  const admissions = new Map<string, DaemonExecutionAdmission>();
  const expires = new Map<string, number>();
  const authority = new AbortController();
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = chain.then(operation);
    chain = next.catch(() => undefined);
    return next;
  };
  const stopTimer = () => { clearTimeout(timer); timer = undefined; };
  const fail = () => { stopTimer(); authority.abort(); };
  const checkAuthority = () => { if (disposed || authority.signal.aborted) throw new Error('Native mission execution authority is unavailable.'); };
  const checkLeaseTime = () => {
    if (!claims.size || [...claims.values()].some(claim => (expires.get(claim.leaseId) ?? 0) <= Date.now())) {
      fail(); checkAuthority();
    }
  };
  /** Also used immediately before a tool decision: a suspended host cannot outrun its timer. */
  const renew = async () => {
    checkAuthority();
    const leases = [...claims.values()].map(claim => ({ ...claim }));
    if (!leases.length) throw new Error('Native mission has no active lease.');
    const ack = await client.request('mission.heartbeat', { missionId, leases });
    if (disposed) return;
    if (ack.missionId !== missionId || ack.leases.length !== leases.length) throw new Error('Mismatched heartbeat acknowledgement.');
    const seen = new Set<string>();
    for (const lease of ack.leases) {
      const expected = claims.get(lease.taskId);
      if (!expected || seen.has(lease.taskId) || expected.leaseId !== lease.leaseId || expected.holderAgentId !== lease.holderAgentId
        || Date.parse(lease.expiresAt) <= Date.now() || (acquired.has(lease.leaseId) && acquired.get(lease.leaseId) !== lease.acquiredAt)) throw new Error('Mismatched heartbeat lease.');
      seen.add(lease.taskId);
    }
    for (const lease of ack.leases) {
      acquired.set(lease.leaseId, lease.acquiredAt);
      expires.set(lease.leaseId, Date.parse(lease.expiresAt));
    }
  };
  const schedule = () => {
    if (disposed || authority.signal.aborted || !claims.size || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void serialize(async () => {
        if (disposed || authority.signal.aborted || !claims.size) return;
        try {
          await renew();
        } catch { if (!disposed) fail(); }
      }).finally(schedule);
    }, MISSION_HEARTBEAT_MS);
    timer.unref();
  };
  return {
    supervisorId,
    authoritySignal: authority.signal,
    dispose() { disposed = true; stopTimer(); },
    commit: event => serialize(async () => {
      checkAuthority();
      if (event.missionId !== missionId) throw new Error('Event of another mission.');
      const body = event.body;
      const from = event.taskId ? states.get(event.taskId) : undefined;
      if (body.type === 'task.state' && event.taskId && from && from !== body.state) {
        const starts = body.state === 'running' && ['queued', 'assigned'].includes(from);
        const ack = await client.request('task.transition', { missionId, taskId: event.taskId, eventId: event.id, from, to: body.state, ...(starts ? { supervisorId } : {}) });
        if (ack.missionId !== missionId || ack.taskId !== event.taskId || ack.state !== body.state) throw new Error('Mismatched acknowledgement.');
        if (starts) {
          const admission = ack.admission;
          if (!admission || admission.missionId !== missionId || admission.workspaceId !== plan.mission.workspaceId || admission.taskId !== event.taskId
            || admission.leaseId !== event.id || admission.supervisorId !== supervisorId || admission.holderAgentId !== assignees.get(event.taskId)
            || admission.attempt !== 1) { fail(); throw new Error('Mismatched execution admission.'); }
          admissions.set(event.taskId, { ...admission });
        }
        states.set(event.taskId, body.state);
        if (leased(body.state)) {
          if (!claims.has(event.taskId)) {
            const holderAgentId = assignees.get(event.taskId);
            if (!holderAgentId || body.state !== 'running') { fail(); throw new Error('Task has no admitted lease holder.'); }
            claims.set(event.taskId, { taskId: event.taskId, leaseId: event.id, holderAgentId });
          }
        } else {
          const claim = claims.get(event.taskId);
          if (claim) { acquired.delete(claim.leaseId); expires.delete(claim.leaseId); }
          claims.delete(event.taskId);
          if (!claims.size) stopTimer();
        }
        schedule();
        return ack.sequence;
      }
      const ack = await client.request('event.commit', { event });
      if (ack.missionId !== missionId || ack.eventId !== event.id) throw new Error('Mismatched acknowledgement.');
      return ack.sequence;
    }),
    checkPermission: request => serialize(async () => {
      try {
        checkAuthority();
        await renew();
        checkAuthority(); checkLeaseTime();
        const { decision } = await client.request('permission.check', {
          access: request.access, mode: request.mode, workspacePermissions: { ...request.permissions }, sessionGrants: [...new Set(request.sessionGrants)],
        });
        checkAuthority(); checkLeaseTime();
        return { decision };
      } catch {
        if (!disposed) fail();
        // Unavailable, refused or malformed: deny, never decide locally (ADR 0026).
        return POLICY_UNAVAILABLE;
      }
    }),
    async observeTurnSettlement(observation) {
      const admission = admissions.get(observation.taskId);
      if (!admission || observation.missionId !== missionId || observation.agentId !== admission.holderAgentId
        || observation.attempt !== admission.attempt || observation.kind !== 'turn-promise-settled') throw new Error('Execution observation has no matching admission.');
      const observationId = randomUUID();
      const ack = await client.request('execution.observe', {
        missionId, taskId: admission.taskId, leaseId: admission.leaseId, holderAgentId: admission.holderAgentId,
        supervisorId, attempt: admission.attempt, admissionDigest: admission.admissionDigest, observationId, kind: 'turn-promise-settled',
      });
      if (ack.missionId !== missionId || ack.taskId !== admission.taskId || ack.leaseId !== admission.leaseId || ack.observationId !== observationId) throw new Error('Mismatched execution observation acknowledgement.');
    },
    async recordLocalDrain(proof) {
      const admission = admissions.get(proof.taskId);
      if (!admission || proof.missionId !== missionId || proof.agentId !== admission.holderAgentId || proof.attempt !== admission.attempt
        || proof.kind !== 'local-operations-drained' || proof.coverage !== 'extalia-native-local-v1') throw new Error('Local drain has no matching execution admission.');
      const proofId = randomUUID();
      const ack = await client.request('execution.recordLocalDrain', {
        missionId, taskId: admission.taskId, leaseId: admission.leaseId, holderAgentId: admission.holderAgentId,
        supervisorId, attempt: admission.attempt, admissionDigest: admission.admissionDigest, proofId,
        kind: 'local-operations-drained', coverage: proof.coverage, providerOperations: proof.providerOperations, toolOperations: proof.toolOperations,
      });
      if (ack.missionId !== missionId || ack.taskId !== admission.taskId || ack.leaseId !== admission.leaseId || ack.proofId !== proofId) throw new Error('Mismatched local drain acknowledgement.');
    },
    async cancelUnstarted(sessionId) {
      disposed = true; stopTimer();
      const event: AgentEvent = {
        schemaVersion: ORCHESTRATION_SCHEMA_VERSION, id: randomUUID(), workspaceId: plan.mission.workspaceId, sessionId, missionId, agentId: plan.mission.leadAgentId,
        source: { runtime: 'extalia-native', channel: 'system' }, observedAt: new Date().toISOString(), sequence: 0, confidence: 'reported', body: { type: 'mission.state', state: 'cancelled' },
      };
      await client.request('event.commit', { event }).catch(() => undefined);
    },
  };
}
