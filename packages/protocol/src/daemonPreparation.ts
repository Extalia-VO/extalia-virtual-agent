/** Optional durable mission-start preparation receipts; no lease or executable authority. */
export const DAEMON_PREPARATION_OPS = ['preparation.begin', 'preparation.observe', 'preparation.inspect'] as const;
export const DAEMON_PREPARATION_MAX_CONNECTIONS = 16;
/** Canonically encoded preparation frames fit this budget through bounded ASCII fields. */
export const DAEMON_PREPARATION_MAX_FRAME_BYTES = 32 * 1024;
export const PREPARATION_SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export interface DaemonPreparationBegin {
  invocationId: string;
  /** Preallocated identity of the future mission. */
  missionId: string;
  /** Actual daemon supervisor identity. */
  supervisorId: string;
  /** Canonical workspace identity, distinct from the opaque host workspace ID. */
  canonicalWorkspaceId: string;
  sessionId: string;
  workspaceId: string;
  /** Nonempty, unique and sorted by ASCII order. */
  connectionIds: string[];
}
export interface DaemonPreparationAdmission extends DaemonPreparationBegin {
  kind: 'native-mission-preparation';
  admittedAt: string;
  admissionDigest: string;
}
export interface DaemonPreparationObservation {
  invocationId: string;
  admissionDigest: string;
  /** Only the local mission preparation promise settled; children/remote work are not certified. */
  kind: 'local-preparation-settled';
}
export interface DaemonPreparationObservationRecord extends DaemonPreparationObservation {
  recordedAt: string;
}
export interface DaemonPreparationInspection {
  admission: DaemonPreparationAdmission;
  observation?: DaemonPreparationObservationRecord;
}
export interface DaemonPreparationOperations {
  'preparation.begin': { params: DaemonPreparationBegin; result: DaemonPreparationAdmission };
  'preparation.observe': { params: DaemonPreparationObservation; result: DaemonPreparationObservationRecord };
  'preparation.inspect': { params: { invocationId: string }; result: DaemonPreparationInspection };
}
