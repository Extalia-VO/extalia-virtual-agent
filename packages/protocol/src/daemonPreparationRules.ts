import {
  DAEMON_PREPARATION_MAX_CONNECTIONS, PREPARATION_SCOPE_ID_PATTERN, type DaemonPreparationInspection,
} from './daemonPreparation.js';
import { array, digest, fail, literal, object, optional, rule, timestamp, uuid, type Rule } from './rules.js';

// JavaScript's `$` also matches before a final line break; these IDs are exact strings.
const exactString = (field: Rule) => rule((value, path, errors) => {
  field.check(value, path, errors);
  if (typeof value === 'string' && /[\r\n\u2028\u2029]/.test(value)) fail(path, 'unexpected line break', errors);
}, { allOf: [field.schema], not: { pattern: '[\\r\\n\\u2028\\u2029]' } });
const preparationUuid = exactString(uuid), preparationDigest = exactString(digest), preparationTimestamp = exactString(timestamp);

const scopeId = rule((value, path, errors) => {
  if (typeof value !== 'string' || !PREPARATION_SCOPE_ID_PATTERN.test(value) || /[^A-Za-z0-9._:-]/.test(value)) fail(path, 'expected an opaque preparation scope ID', errors);
}, { type: 'string', maxLength: 200, pattern: PREPARATION_SCOPE_ID_PATTERN.source, not: { pattern: '[^A-Za-z0-9._:-]' } });
const connectionIdsShape = array(scopeId, true, 1, DAEMON_PREPARATION_MAX_CONNECTIONS);
const connectionIds = rule((value, path, errors) => {
  const before = errors.length;
  connectionIdsShape.check(value, path, errors);
  if (errors.length !== before) return;
  const ids = value as string[];
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) fail(path, 'connection IDs must be sorted by ASCII order', errors);
}, connectionIdsShape.schema);
const beginFields = { invocationId: preparationUuid, missionId: preparationUuid, supervisorId: preparationUuid, canonicalWorkspaceId: preparationUuid, sessionId: scopeId, workspaceId: scopeId, connectionIds };
const observationFields = { invocationId: preparationUuid, admissionDigest: preparationDigest, kind: literal('local-preparation-settled') };
export const preparationAdmission = object({ ...beginFields, kind: literal('native-mission-preparation'), admittedAt: preparationTimestamp, admissionDigest: preparationDigest });
export const preparationObservation = object({ ...observationFields, recordedAt: preparationTimestamp });
const inspectionShape = object({ admission: preparationAdmission, observation: optional(preparationObservation) });
const inspection = rule((value, path, errors) => {
  const before = errors.length;
  inspectionShape.check(value, path, errors);
  if (errors.length !== before) return;
  const { admission, observation } = value as DaemonPreparationInspection;
  if (observation && (observation.invocationId !== admission.invocationId || observation.admissionDigest !== admission.admissionDigest)) fail(`${path}.observation`, 'observation must match the admission identity and digest', errors);
  if (observation && Date.parse(observation.recordedAt) < Date.parse(admission.admittedAt)) fail(`${path}.observation.recordedAt`, 'observation precedes admission', errors);
}, inspectionShape.schema);

export const PREPARATION_PARAMS = {
  'preparation.begin': object(beginFields),
  'preparation.observe': object(observationFields),
  'preparation.inspect': object({ invocationId: preparationUuid }),
};
export const PREPARATION_RESULTS = {
  'preparation.begin': preparationAdmission,
  'preparation.observe': preparationObservation,
  'preparation.inspect': inspection,
};
