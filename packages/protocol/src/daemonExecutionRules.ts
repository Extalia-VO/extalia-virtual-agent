import type { DaemonMissionExecutions } from './daemonExecutions.js';
import { array, boolean, digest, fail, literal, number, object, optional, positive, rule, timestamp, uuid } from './rules.js';

export const executionAdmission = object({
  missionId: uuid, workspaceId: uuid, taskId: uuid, leaseId: uuid, holderAgentId: uuid, supervisorId: uuid,
  attempt: positive, missionVersion: positive, taskDigest: digest, graphDigest: digest, admissionDigest: digest, admittedAt: timestamp,
});
const observationKind = literal('turn-promise-settled');
const localDrainKind = literal('local-operations-drained');
const coverage = literal('extalia-native-local-v1');
const providerOperations = number(0, true, 20), toolOperations = number(0, true, 80);
export const executionRecords = array(object({
  admission: executionAdmission,
  observation: optional(object({ observationId: uuid, kind: observationKind, recordedAt: timestamp })),
  localDrain: optional(object({ proofId: uuid, kind: localDrainKind, coverage, providerOperations, toolOperations, recordedAt: timestamp })),
}), false, 0, 64);
const executionsShape = object({ missionId: uuid, executions: executionRecords });
export const executions = rule((value, path, errors) => {
  const before = errors.length;
  executionsShape.check(value, path, errors);
  if (errors.length !== before) return;
  const result = value as DaemonMissionExecutions;
  const tasks = new Set<string>(), leases = new Set<string>(), observations = new Set<string>(), proofs = new Set<string>();
  for (const record of result.executions) {
    const admission = record.admission;
    if (admission.missionId !== result.missionId) fail(`${path}.executions`, 'admission belongs to another mission', errors);
    if (tasks.has(admission.taskId) || leases.has(admission.leaseId)) fail(`${path}.executions`, 'duplicate execution identity', errors);
    tasks.add(admission.taskId); leases.add(admission.leaseId);
    if (record.observation) {
      if (observations.has(record.observation.observationId)) fail(`${path}.executions`, 'duplicate observation ID', errors);
      observations.add(record.observation.observationId);
      if (Date.parse(record.observation.recordedAt) < Date.parse(admission.admittedAt)) fail(`${path}.executions`, 'observation precedes admission', errors);
    }
    if (record.localDrain) {
      if (!record.observation || Date.parse(record.localDrain.recordedAt) < Date.parse(record.observation.recordedAt)) fail(`${path}.executions`, 'local drain requires an earlier turn observation', errors);
      if (proofs.has(record.localDrain.proofId)) fail(`${path}.executions`, 'duplicate local drain proof ID', errors);
      proofs.add(record.localDrain.proofId);
    }
  }
}, executionsShape.schema);

export const EXECUTION_PARAMS = {
  'execution.recordLocalDrain': object({ missionId: uuid, taskId: uuid, leaseId: uuid, holderAgentId: uuid, supervisorId: uuid,
    attempt: positive, admissionDigest: digest, proofId: uuid, kind: localDrainKind, coverage, providerOperations, toolOperations }),
  'execution.observe': object({ missionId: uuid, taskId: uuid, leaseId: uuid, holderAgentId: uuid, supervisorId: uuid,
    attempt: positive, admissionDigest: digest, observationId: uuid, kind: observationKind }),
  'mission.executions': object({ missionId: uuid }),
  'mission.recoveryReview': object({ missionId: uuid }),
};
export const EXECUTION_RESULTS = {
  'execution.recordLocalDrain': object({ missionId: uuid, taskId: uuid, leaseId: uuid, proofId: uuid, recordedAt: timestamp, duplicate: boolean }),
  'execution.observe': object({ missionId: uuid, taskId: uuid, leaseId: uuid, observationId: uuid, recordedAt: timestamp, duplicate: boolean }),
  'mission.executions': executions,
};
