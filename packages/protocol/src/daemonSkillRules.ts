/**
 * Validator rules of the skill registry operations (`daemonSkills.ts`). Internal to the
 * package: `daemonValidate.ts` merges them into the daemon frame rules and `$defs`.
 */
import {
  DAEMON_SKILL_LIMITS, DAEMON_SKILL_LIST_MAX_LIMIT, DAEMON_SKILL_READ_MAX_BYTES, SKILL_CAPABILITIES, SKILL_COVERAGES,
  SKILL_IMPORT_ORIGINS, SKILL_INSPECTION_OUTCOMES, SKILL_LIST_CURSOR_PATTERN, SKILL_ORIGINS, SKILL_PACKAGE_ID_PATTERN,
  SKILL_PATH_MAX_LENGTH, SKILL_PATH_PATTERN, SKILL_REASON_PATTERN, SKILL_REVIEW_DECISIONS, SKILL_REVISION_ID_PATTERN,
  SKILL_REVISION_STATES, SKILL_RISK_CLASSES, SKILL_SCANNER_STATUSES, SKILL_USER_PRINCIPAL_PATTERN, SKILL_VERDICTS, SKILL_WORKSPACE_ID_MAX_LENGTH,
  SKILL_WORKSPACE_ID_PATTERN, type DaemonSkillOp,
} from './daemonSkills.js';
import { NONBLANK_PATTERN, schemaRef, type JsonSchema } from './jsonSchema.js';
import {
  array, boolean, count, digest, enumeration, fail, literal, number, object, optional, positive, rule, text, timestamp, withSchema,
  type Rule,
} from './rules.js';

const matching = (pattern: RegExp, message: string, maxLength?: number) => rule((value, path, errors) => {
  if (typeof value !== 'string' || (maxLength !== undefined && value.length > maxLength) || !pattern.test(value)) fail(path, message, errors);
}, { type: 'string', ...(maxLength !== undefined ? { maxLength } : {}), pattern: pattern.source });
/** Text that may span lines: tab, line feed and carriage return are the only control characters allowed. */
const MULTILINE_PATTERN = '^[^\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]*$';
const isMultiline = (value: string) => Array.from(value).every(character => {
  const code = character.charCodeAt(0);
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
});
export const multiline = (max: number, nonblank: boolean) => rule((value, path, errors) => {
  if (typeof value !== 'string' || value.length > max || (nonblank && !value.trim()) || !isMultiline(value)) {
    fail(path, `expected ${nonblank ? 'nonblank ' : ''}text of at most ${max} characters without control characters other than tab and line breaks`, errors);
  }
}, { type: 'string', maxLength: max, pattern: MULTILINE_PATTERN, ...(nonblank ? { allOf: [{ pattern: NONBLANK_PATTERN }] } : {}) });

const def = (name: string, field: Rule) => ({ name, field, ref: withSchema(field, schemaRef(name)) });
const packageId = def('SkillPackageId', matching(SKILL_PACKAGE_ID_PATTERN, 'expected a skill package id'));
const revisionId = def('SkillRevisionId', matching(SKILL_REVISION_ID_PATTERN, 'expected a skill revision id (skr_ and a SHA-256)'));
const skillPath = def('SkillPath', matching(SKILL_PATH_PATTERN, `expected a package-relative path of at most ${SKILL_PATH_MAX_LENGTH} characters`, SKILL_PATH_MAX_LENGTH));
const workspaceId = def('SkillWorkspaceId', matching(SKILL_WORKSPACE_ID_PATTERN, 'expected a workspace id (w_… or a lowercase UUID)', SKILL_WORKSPACE_ID_MAX_LENGTH));
const principal = def('SkillUserPrincipal', matching(SKILL_USER_PRINCIPAL_PATTERN, 'expected the local user principal user:<id>'));
export const skillReason = def('SkillReason', matching(SKILL_REASON_PATTERN, 'expected a reason code'));
const state = def('SkillRevisionState', enumeration(SKILL_REVISION_STATES));
const origin = def('SkillOrigin', enumeration(SKILL_ORIGINS));
const riskClass = def('SkillRiskClass', enumeration(SKILL_RISK_CLASSES));
const permission = def('SkillPermissionEntry', object({ capability: enumeration(SKILL_CAPABILITIES), scope: text(256) }));
const summary = def('SkillRevisionSummary', object({
  packageId: packageId.ref, revisionId: revisionId.ref, origin: origin.ref, version: text(128), treeSha256: digest, skillMdSha256: digest,
  state: state.ref, stateReason: optional(skillReason.ref), riskClass: riskClass.ref, manifestInferred: boolean, permissionDigest: digest,
  permissions: array(permission.ref, false, 0, DAEMON_SKILL_LIMITS.permissions), active: boolean, createdAt: timestamp, updatedAt: timestamp,
}));
const file = def('SkillFileEntry', object({ path: skillPath.ref, size: count, sha256: digest, executable: boolean }));
const inspection = def('SkillInspectionRecord', object({
  inspectionId: positive, scannerId: text(128), scannerPin: optional(text(256)), scannerVersion: optional(text(128)), policyVersion: text(128),
  outcome: enumeration(SKILL_INSPECTION_OUTCOMES), coverage: enumeration(SKILL_COVERAGES), verdict: optional(enumeration(SKILL_VERDICTS)),
  startedAt: timestamp, finishedAt: timestamp,
}));
const approval = def('SkillApprovalRecord', object({
  approvalId: positive, kind: enumeration(['user', 'auto']), approver: text(128), status: enumeration(['granted', 'revoked']),
  workspaceId: optional(workspaceId.ref), permissionDigest: digest, createdAt: timestamp, expiresAt: timestamp, revokedAt: optional(timestamp),
}));
const event = def('SkillStateEvent', object({ seq: positive, fromState: optional(state.ref), toState: state.ref, reason: optional(skillReason.ref), at: timestamp }));
const consent = def('SkillConsentInput', object({ path: literal('SKILL.md'), sha256: digest, allowedAt: optional(timestamp), workspaceId: optional(workspaceId.ref) }));
const scanner = def('SkillScannerReport', object({
  scannerId: text(128), pinned: boolean, pin: optional(text(256)), version: optional(text(128)), normalizerVersion: optional(text(128)), policyVersion: text(128),
  status: enumeration(SKILL_SCANNER_STATUSES),
}));
const activation = def('SkillActivationResult', object({ packageId: packageId.ref, revisionId: revisionId.ref, approvalId: positive, activatedAt: timestamp, indexGeneration: count }));
const decision = enumeration(SKILL_REVIEW_DECISIONS);

export const SKILL_PARAMS: Record<DaemonSkillOp, Rule> = {
  'skill.import': object({ origin: enumeration(SKILL_IMPORT_ORIGINS), path: skillPath.ref, sourceRef: optional(text(DAEMON_SKILL_LIMITS.sourceRef)) }),
  'skill.list': object({
    cursor: optional(matching(SKILL_LIST_CURSOR_PATTERN, 'expected a cursor from a previous page')),
    limit: optional(number(1, true, DAEMON_SKILL_LIST_MAX_LIMIT)), packageId: optional(packageId.ref),
  }),
  'skill.inspect': object({ revisionId: revisionId.ref, workspaceId: optional(workspaceId.ref) }),
  'skill.review': object({ revisionId: revisionId.ref, treeSha256: digest, principal: principal.ref, decision, note: optional(multiline(DAEMON_SKILL_LIMITS.note, true)) }),
  'skill.approve': object({
    revisionId: revisionId.ref, treeSha256: digest, permissionDigest: digest, principal: principal.ref, workspaceId: optional(workspaceId.ref), expiresAt: optional(timestamp),
  }),
  'skill.activate': object({ revisionId: revisionId.ref, approvalId: positive }),
  'skill.deactivate': object({ packageId: packageId.ref }),
  'skill.rollback': object({ packageId: packageId.ref, revisionId: revisionId.ref }),
  'skill.revoke': object({ revisionId: revisionId.ref }),
  'skill.read': object({ revisionId: revisionId.ref, path: skillPath.ref }),
  'skill.scanner': object({}),
};
export const SKILL_RESULTS: Record<DaemonSkillOp, Rule> = {
  'skill.import': object({
    packageId: packageId.ref, revisionId: revisionId.ref, treeSha256: digest, version: text(128), state: state.ref, stateReason: optional(skillReason.ref), created: boolean,
  }),
  'skill.list': object({
    revisions: array(summary.ref, false, 0, DAEMON_SKILL_LIST_MAX_LIMIT),
    nextCursor: optional(matching(SKILL_LIST_CURSOR_PATTERN, 'expected a cursor')), indexGeneration: count,
  }),
  'skill.inspect': object({
    revision: summary.ref, manifest: text(DAEMON_SKILL_LIMITS.manifest), files: array(file.ref, false, 0, DAEMON_SKILL_LIMITS.files),
    inspections: array(inspection.ref, false, 0, DAEMON_SKILL_LIMITS.inspections), approvals: array(approval.ref, false, 0, DAEMON_SKILL_LIMITS.approvals),
    history: array(event.ref, false, 0, DAEMON_SKILL_LIMITS.history), consent: array(consent.ref, false, 0, DAEMON_SKILL_LIMITS.consent),
  }),
  'skill.review': object({ revisionId: revisionId.ref, decision, state: state.ref, stateReason: optional(skillReason.ref), reviewId: optional(positive) }),
  'skill.approve': object({ approvalId: positive, revisionId: revisionId.ref, state: state.ref, expiresAt: timestamp }),
  'skill.activate': activation.ref,
  'skill.deactivate': object({ packageId: packageId.ref, revisionId: revisionId.ref, state: state.ref, indexGeneration: count }),
  'skill.rollback': activation.ref,
  'skill.revoke': object({ revisionId: revisionId.ref, state: state.ref, indexGeneration: count }),
  'skill.read': object({
    revisionId: revisionId.ref, packageId: packageId.ref, path: skillPath.ref, size: number(0, true, DAEMON_SKILL_READ_MAX_BYTES), sha256: digest,
    content: multiline(DAEMON_SKILL_READ_MAX_BYTES, false),
  }),
  'skill.scanner': scanner.ref,
};

/** Named `$defs` of the skill rules. */
export function skillJsonSchemaDefs(): Record<string, JsonSchema> {
  const named = [
    packageId, revisionId, skillPath, workspaceId, principal, skillReason, state, origin, riskClass, permission, summary, file, inspection, approval, event, consent,
    activation, scanner,
  ];
  return Object.fromEntries(named.map(({ name, field }) => [name, field.schema]));
}
