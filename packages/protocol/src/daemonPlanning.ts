/** Optional durable planning lifetime receipts; no lease or executable authority. */
export const DAEMON_PLANNING_OPS = ['planning.begin', 'planning.observe', 'planning.inspect'] as const;
export const DAEMON_PLANNING_MAX_CONNECTIONS = 16;
/** Canonically encoded planning frames fit this budget through bounded ASCII fields. */
export const DAEMON_PLANNING_MAX_FRAME_BYTES = 32 * 1024;
export const PLANNING_SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface DaemonPlanningBegin {
  invocationId: string;
  supervisorId: string;
  sessionId: string;
  workspaceId: string;
  /** Nonempty, unique and sorted by ASCII order. */
  connectionIds: string[];
}
export interface DaemonPlanningAdmission extends DaemonPlanningBegin {
  kind: 'native-planning';
  admittedAt: string;
  admissionDigest: string;
}
export interface DaemonPlanningObservation {
  invocationId: string;
  admissionDigest: string;
  /** Only the local planning pipeline promise settled; children/remote work are not certified. */
  kind: 'local-pipeline-settled';
}
export interface DaemonPlanningObservationRecord extends DaemonPlanningObservation {
  recordedAt: string;
}
export interface DaemonPlanningInspection {
  admission: DaemonPlanningAdmission;
  observation?: DaemonPlanningObservationRecord;
}
export interface DaemonPlanningOperations {
  'planning.begin': { params: DaemonPlanningBegin; result: DaemonPlanningAdmission };
  'planning.observe': { params: DaemonPlanningObservation; result: DaemonPlanningObservationRecord };
  'planning.inspect': { params: { invocationId: string }; result: DaemonPlanningInspection };
}
