import {
  DAEMON_PLANNING_MAX_CONNECTIONS, PLANNING_SCOPE_ID_PATTERN, type DaemonPlanningInspection,
} from './daemonPlanning.js';
import { array, digest, fail, literal, object, optional, rule, timestamp, uuid, type Rule } from './rules.js';

// JavaScript's `$` also matches before a final line break; these IDs are exact strings.
const exactString = (field: Rule) => rule((value, path, errors) => {
  field.check(value, path, errors);
  if (typeof value === 'string' && /[\r\n\u2028\u2029]/.test(value)) fail(path, 'unexpected line break', errors);
}, { allOf: [field.schema], not: { pattern: '[\\r\\n\\u2028\\u2029]' } });
const planningUuid = exactString(uuid), planningDigest = exactString(digest), planningTimestamp = exactString(timestamp);

const scopeId = rule((value, path, errors) => {
  if (typeof value !== 'string' || !PLANNING_SCOPE_ID_PATTERN.test(value) || /[^A-Za-z0-9._:-]/.test(value)) fail(path, 'expected an opaque planning scope ID', errors);
}, { type: 'string', maxLength: 200, pattern: PLANNING_SCOPE_ID_PATTERN.source, not: { pattern: '[^A-Za-z0-9._:-]' } });
const connectionIdsShape = array(scopeId, true, 1, DAEMON_PLANNING_MAX_CONNECTIONS);
const connectionIds = rule((value, path, errors) => {
  const before = errors.length;
  connectionIdsShape.check(value, path, errors);
  if (errors.length !== before) return;
  const ids = value as string[];
  if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) fail(path, 'connection IDs must be sorted by ASCII order', errors);
}, connectionIdsShape.schema);
const beginFields = { invocationId: planningUuid, supervisorId: planningUuid, sessionId: scopeId, workspaceId: scopeId, connectionIds };
const observationFields = { invocationId: planningUuid, admissionDigest: planningDigest, kind: literal('local-pipeline-settled') };
export const planningAdmission = object({ ...beginFields, kind: literal('native-planning'), admittedAt: planningTimestamp, admissionDigest: planningDigest });
export const planningObservation = object({ ...observationFields, recordedAt: planningTimestamp });
const inspectionShape = object({ admission: planningAdmission, observation: optional(planningObservation) });
const inspection = rule((value, path, errors) => {
  const before = errors.length;
  inspectionShape.check(value, path, errors);
  if (errors.length !== before) return;
  const { admission, observation } = value as DaemonPlanningInspection;
  if (observation && (observation.invocationId !== admission.invocationId || observation.admissionDigest !== admission.admissionDigest)) fail(`${path}.observation`, 'observation must match the admission identity and digest', errors);
  if (observation && Date.parse(observation.recordedAt) < Date.parse(admission.admittedAt)) fail(`${path}.observation.recordedAt`, 'observation precedes admission', errors);
}, inspectionShape.schema);

export const PLANNING_PARAMS = {
  'planning.begin': object(beginFields),
  'planning.observe': object(observationFields),
  'planning.inspect': object({ invocationId: planningUuid }),
};
export const PLANNING_RESULTS = {
  'planning.begin': planningAdmission,
  'planning.observe': planningObservation,
  'planning.inspect': inspection,
};
