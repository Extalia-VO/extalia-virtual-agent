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
import { ORCHESTRATION_SCHEMA_VERSION, type AgentEvent, type OrchestrationPlan, type TaskState } from '@extalia/protocol';
import { randomUUID } from 'node:crypto';
import { POLICY_UNAVAILABLE, type PermissionRequest, type PermissionVerdict } from '@extalia/runtime';
import type { DaemonClient } from './client.js';

export interface DaemonMission {
  /** Commit one runtime event; resolves to the daemon's per-mission sequence. */
  commit(event: AgentEvent): Promise<number>;
  checkPermission(request: PermissionRequest): Promise<PermissionVerdict>;
  /** Best effort for a mission that never started: record it as cancelled by its lead. */
  cancelUnstarted(sessionId: string): Promise<void>;
}

export async function createDaemonMission(client: DaemonClient, plan: Pick<OrchestrationPlan, 'mission' | 'graph'>): Promise<DaemonMission> {
  const missionId = plan.mission.id;
  const created = await client.request('mission.create', { mission: plan.mission, graph: plan.graph });
  if (created.missionId !== missionId) throw new Error('The native core acknowledged another mission.');
  const states = new Map<string, TaskState>(plan.graph.tasks.map(task => [task.id, task.state]));
  return {
    async commit(event) {
      if (event.missionId !== missionId) throw new Error('Event of another mission.');
      const body = event.body;
      const from = event.taskId ? states.get(event.taskId) : undefined;
      if (body.type === 'task.state' && event.taskId && from && from !== body.state) {
        const ack = await client.request('task.transition', { missionId, taskId: event.taskId, eventId: event.id, from, to: body.state });
        if (ack.missionId !== missionId || ack.taskId !== event.taskId || ack.state !== body.state) throw new Error('Mismatched acknowledgement.');
        states.set(event.taskId, body.state);
        return ack.sequence;
      }
      const ack = await client.request('event.commit', { event });
      if (ack.missionId !== missionId || ack.eventId !== event.id) throw new Error('Mismatched acknowledgement.');
      return ack.sequence;
    },
    async checkPermission(request) {
      try {
        const { decision } = await client.request('permission.check', {
          access: request.access, mode: request.mode, workspacePermissions: { ...request.permissions }, sessionGrants: [...new Set(request.sessionGrants)],
        });
        return { decision };
      } catch {
        // Unavailable, refused or malformed: deny, never decide locally (ADR 0026).
        return POLICY_UNAVAILABLE;
      }
    },
    async cancelUnstarted(sessionId) {
      const event: AgentEvent = {
        schemaVersion: ORCHESTRATION_SCHEMA_VERSION, id: randomUUID(), workspaceId: plan.mission.workspaceId, sessionId, missionId, agentId: plan.mission.leadAgentId,
        source: { runtime: 'extalia-native', channel: 'system' }, observedAt: new Date().toISOString(), sequence: 0, confidence: 'reported', body: { type: 'mission.state', state: 'cancelled' },
      };
      await client.request('event.commit', { event }).catch(() => undefined);
    },
  };
}
