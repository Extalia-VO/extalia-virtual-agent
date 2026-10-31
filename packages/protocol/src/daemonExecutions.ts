import type { DaemonMissionSnapshot } from './daemon.js';
/** Supervisor observations are data, never physical-settlement or execution authority. */
export const DAEMON_EXECUTION_OPS = ['execution.observe', 'execution.recordLocalDrain', 'mission.executions', 'mission.recoveryReview'] as const;

export interface DaemonExecutionAdmission {
  missionId: string;
  workspaceId: string;
  taskId: string;
  leaseId: string;
  holderAgentId: string;
  supervisorId: string;
  attempt: number;
  missionVersion: number;
  taskDigest: string;
  graphDigest: string;
  admissionDigest: string;
  admittedAt: string;
}
export interface DaemonExecutionObservation {
  missionId: string;
  taskId: string;
  leaseId: string;
  holderAgentId: string;
  supervisorId: string;
  attempt: number;
  admissionDigest: string;
  observationId: string;
  kind: 'turn-promise-settled';
}
export interface DaemonMissionExecutions {
  missionId: string;
  executions: {
    admission: DaemonExecutionAdmission;
    /** The turn promise settled; parallel tools, children and remote work are not certified. */
    observation?: { observationId: string; kind: 'turn-promise-settled'; recordedAt: string };
    /** Instrumented local adapters/known owned children; never remote cancellation or terminal authority. */
    localDrain?: { proofId: string; kind: 'local-operations-drained'; coverage: 'extalia-native-local-v1'; providerOperations: number; toolOperations: number; recordedAt: string };
  }[];
}
/** One pinned canonical read view. Digests are opaque profile-bound review identifiers, not approvals. */
export interface DaemonMissionRecoveryReview {
  kind: 'extalia-recovery-review-v1';
  snapshot: DaemonMissionSnapshot;
  executions: DaemonMissionExecutions['executions'];
  missionDigest: string;
  graphDigest: string;
  reviewDigest: string;
  /** Includes never-started tasks; no historical admission is inferred. */
  missingAdmissionTaskIds: string[];
  worktreeOwnership: 'unverified';
}
export interface DaemonExecutionOperations {
  'mission.recoveryReview': { params: { missionId: string }; result: DaemonMissionRecoveryReview };
  'execution.recordLocalDrain': {
    params: Omit<DaemonExecutionObservation, 'observationId' | 'kind'> & { proofId: string; kind: 'local-operations-drained'; coverage: 'extalia-native-local-v1'; providerOperations: number; toolOperations: number };
    result: { missionId: string; taskId: string; leaseId: string; proofId: string; recordedAt: string; duplicate: boolean };
  };
  'execution.observe': {
    params: DaemonExecutionObservation;
    result: { missionId: string; taskId: string; leaseId: string; observationId: string; recordedAt: string; duplicate: boolean };
  };
  'mission.executions': { params: { missionId: string }; result: DaemonMissionExecutions };
}
