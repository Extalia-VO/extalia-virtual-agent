import { SKILL_PACKAGE_ID_PATTERN, SKILL_PREFLIGHT_CODES, SKILL_REVISION_ID_PATTERN } from './daemonSkills.js';
import { array, boolean, digest, enumeration, fail, literal, object, optional, rule, text } from './rules.js';

const id = (pattern: RegExp) => rule((value, path, errors) => {
  if (typeof value !== 'string' || !pattern.test(value)) fail(path, 'invalid skill identity', errors);
}, { type: 'string', pattern: pattern.source });
const packageId = id(SKILL_PACKAGE_ID_PATTERN);
const revisionId = id(SKILL_REVISION_ID_PATTERN);
const pins = rule((value, path, errors) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 128) {
    fail(path, 'expected at most 128 exact package pins', errors); return;
  }
  for (const [key, revision] of Object.entries(value)) {
    packageId.check(key, `${path}.packageId`, errors);
    revisionId.check(revision, `${path}.revisionId`, errors);
  }
}, { type: 'object', maxProperties: 128, propertyNames: packageId.schema, additionalProperties: revisionId.schema });

export const skillPreflightParams = object({ rootRevisionId: revisionId, pins });
const issue = object({ code: enumeration(SKILL_PREFLIGHT_CODES), packageId: optional(packageId), relatedPackageId: optional(packageId) });
const planned = object({ packageId, version: text(128), revisionId, treeSha256: digest, permissionDigest: digest });
const common = { rootRevisionId: revisionId, dispatchEligible: literal(false) };
const blocked = object({ ...common, status: literal('blocked'), issues: array(issue, false, 1, 256), truncated: boolean });
const consistent = object({ ...common, status: literal('consistent'), issues: array(issue, false, 0, 0), truncated: literal(false), plan: array(planned, false, 1, 128) });
export const skillPreflightResult = rule((value, path, errors) => {
  const status = value && typeof value === 'object' && 'status' in value ? value.status : undefined;
  (status === 'consistent' ? consistent : blocked).check(value, path, errors);
}, { oneOf: [blocked.schema, consistent.schema] });
