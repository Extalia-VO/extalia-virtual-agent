import type { SkillRoutingInput, SkillRoutingReport } from './daemonSkillRouting.js';
/**
 * Secure skill registry operations of the daemon wire contract v1 (W3, ADRs 0023, 0025,
 * 0026; gap-map decision 10). Additive: new operations and two error codes within schema
 * version 1. A daemon advertises them in `hello` only when it serves a core store, and the
 * host sends only advertised operations, so an older peer never receives them.
 *
 * Rules beyond the field types:
 * - A daemon serves exactly one profile; the wire carries no profile id (ADR 0024).
 * - `skill.import` reads a package directory below the profile's import inbox
 *   (`<data>/profiles/<profile>/skill-imports/`); `path` is relative to it. The origin is
 *   one of the four import origins: `builtin` cannot be requested. Built-in skills are
 *   registered only inside the daemon and are listed with origin `builtin`.
 * - `skill.review` and `skill.approve` are decisions of the local user: `principal` must be
 *   `user:<id>`, so no model, agent, scanner or policy principal can be expressed, and the
 *   daemon checks it again. Both carry the digests the UI showed; a stale digest is
 *   refused with `conflict`. A review is recorded append-only and is never an approval.
 * - `skill.inspect` with a `workspaceId` also stores the matching W0 consent as review
 *   input; that never changes a state. Its `consent` lists the stored review inputs of the
 *   revision (each with the workspace it came from), newest last.
 * - Workspace ids are the host's (`SKILL_WORKSPACE_ID_PATTERN`): `w_…` ids, or the lowercase
 *   UUIDs the contract first required (still accepted, so the change is additive).
 * - `skill.scanner` reports the installed inspector (ADR 0023) without running it; it is
 *   advertised with the other skill operations by a daemon that implements it.
 * - `skill.read` returns a verified file of a package's active revision (or of a built-in
 *   skill) only, as UTF-8 text of at most `DAEMON_SKILL_READ_MAX_BYTES` bytes.
 * - Refusals use the error frame's optional `reason` (a stable snake/kebab-case code such
 *   as `scanner_unpinned`, `approval_expired`, `digest_mismatch`, `not_active`).
 */

export const SKILL_REVISION_STATES = [
  'discovered', 'quarantined', 'inspecting', 'inspected', 'review_required', 'blocked', 'validated', 'evaluating', 'evaluated',
  'awaiting_approval', 'auto_eligible', 'approved', 'active', 'superseded', 'deprecated', 'revoked',
] as const;
export type SkillRevisionState = (typeof SKILL_REVISION_STATES)[number];
/** Origins shown in listings; `builtin` packages ship with the app and skip the scanner gate. */
export const SKILL_ORIGINS = ['builtin', 'user', 'workspace', 'imported', 'generated'] as const;
export type SkillOrigin = (typeof SKILL_ORIGINS)[number];
/** Origins `skill.import` accepts: every one of them passes the scanner gate. */
export const SKILL_IMPORT_ORIGINS = ['user', 'workspace', 'imported', 'generated'] as const;
export type SkillImportOrigin = (typeof SKILL_IMPORT_ORIGINS)[number];
export const SKILL_RISK_CLASSES = ['declarative', 'tool_using', 'executable'] as const;
export type SkillRiskClass = (typeof SKILL_RISK_CLASSES)[number];
export const SKILL_CAPABILITIES = ['filesystem_read', 'filesystem_write', 'network', 'terminal', 'secrets'] as const;
export type SkillCapability = (typeof SKILL_CAPABILITIES)[number];
export const SKILL_INSPECTION_OUTCOMES = ['completed', 'scanner-unavailable', 'incomplete', 'timeout', 'error', 'invalid-output', 'integrity'] as const;
export type SkillInspectionOutcome = (typeof SKILL_INSPECTION_OUTCOMES)[number];
export const SKILL_COVERAGES = ['complete', 'partial', 'none'] as const;
export const SKILL_VERDICTS = ['none', 'low', 'medium', 'high', 'critical'] as const;
export const SKILL_REVIEW_DECISIONS = ['accept', 'reject'] as const;
export type SkillReviewDecision = (typeof SKILL_REVIEW_DECISIONS)[number];
/**
 * Installed inspector (`skill.scanner`), ADR 0023:
 * - `ready`: a scanner adapter with a verified pin is installed; imports are inspected.
 * - `unpinned`: an adapter is installed but its pin is not verified; it is never run and imports
 *   stay quarantined.
 * - `unavailable`: no scanner can run (none installed, the fail-closed default, or a pinned scanner
 *   whose worker is missing); imports stay quarantined with `scanner-unavailable`.
 */
export const SKILL_SCANNER_STATUSES = ['unpinned', 'ready', 'unavailable'] as const;
export type SkillScannerStatus = (typeof SKILL_SCANNER_STATUSES)[number];

/** `SKILL_NAME_PATTERN` of `@extalia/platform`: package (and profile) ids. */
export const SKILL_PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * Workspace id the host generates (`newId('w')` in `packages/host/src/service.ts`): `w_`, the
 * creation time in milliseconds as base 36 (`Date.now().toString(36)`, 1 to 11 characters up to
 * `Number.MAX_SAFE_INTEGER`), then 4 random bytes as 8 lowercase hex characters. At most 21
 * characters, safe as one path segment.
 */
export const HOST_WORKSPACE_ID_PATTERN = /^w_[0-9a-z]{1,11}[0-9a-f]{8}$/;
/**
 * Workspace ids of the skill operations and records: a host workspace id, or a lowercase UUID
 * (`UUID_PATTERN`, versions 1-8), which the contract required first and still accepts.
 */
export const SKILL_WORKSPACE_ID_PATTERN = /^(?:w_[0-9a-z]{1,11}[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
/** Longest `SKILL_WORKSPACE_ID_PATTERN` match (a UUID). */
export const SKILL_WORKSPACE_ID_MAX_LENGTH = 36;
/** Content-addressed revision id: `skr_` + the canonical tree SHA-256. */
export const SKILL_REVISION_ID_PATTERN = /^skr_[a-f0-9]{64}$/;
/** Package-relative path with `/` separators (at most 512 characters, ADR 0025 amendment). */
export const SKILL_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9_][A-Za-z0-9._-]{0,127})*$/;
export const SKILL_PATH_MAX_LENGTH = 512;
/** The local user principal; nothing else can review or approve. */
export const SKILL_USER_PRINCIPAL_PATTERN = /^user:[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
/** Stable reason codes (revision state reasons and error frame reasons). */
export const SKILL_REASON_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
/** `skill.list` cursor: the last `<packageId>/<revisionId>` of the previous page. */
export const SKILL_LIST_CURSOR_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\/skr_[a-f0-9]{64}$/;

export const DAEMON_SKILL_LIST_DEFAULT_LIMIT = 50;
export const DAEMON_SKILL_LIST_MAX_LIMIT = 100;
/** Largest file `skill.read` returns; the frame stays below 1 MiB even fully escaped. */
export const DAEMON_SKILL_READ_MAX_BYTES = 256 * 1024;
/** Approval expiry when `skill.approve` names none (ADR 0026 `once` default), and the maximum. */
export const DAEMON_SKILL_APPROVAL_DEFAULT_TTL_MS = 10 * 60_000;
export const DAEMON_SKILL_APPROVAL_MAX_TTL_MS = 24 * 60 * 60_000;
export const DAEMON_SKILL_LIMITS = {
  /** Four scoped capabilities of at most 64 scopes each, plus `terminal`. */
  permissions: 4 * 64 + 1,
  files: 256,
  inspections: 20,
  approvals: 20,
  history: 50,
  consent: 8,
  sourceRef: 512,
  manifest: 64 * 1024,
  note: 2_000,
} as const;

export interface SkillPermissionEntry { capability: SkillCapability; scope: string }
export interface SkillRevisionSummary {
  packageId: string;
  revisionId: string;
  origin: SkillOrigin;
  version: string;
  treeSha256: string;
  skillMdSha256: string;
  state: SkillRevisionState;
  stateReason?: string;
  riskClass: SkillRiskClass;
  manifestInferred: boolean;
  /** Declared permissions: a request and a ceiling, never a grant (ADR 0026). */
  permissionDigest: string;
  permissions: SkillPermissionEntry[];
  /** The package's activation pointer names this revision (always true for `builtin`). */
  active: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SkillFileEntry { path: string; size: number; sha256: string; executable: boolean }
export interface SkillInspectionRecord {
  inspectionId: number;
  scannerId: string;
  scannerPin?: string;
  scannerVersion?: string;
  policyVersion: string;
  outcome: SkillInspectionOutcome;
  coverage: (typeof SKILL_COVERAGES)[number];
  verdict?: (typeof SKILL_VERDICTS)[number];
  startedAt: string;
  finishedAt: string;
}
export interface SkillApprovalRecord {
  approvalId: number;
  kind: 'user' | 'auto';
  approver: string;
  status: 'granted' | 'revoked';
  workspaceId?: string;
  permissionDigest: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
}
export interface SkillStateEvent { seq: number; fromState?: SkillRevisionState; toState: SkillRevisionState; reason?: string; at: string }
/**
 * A W0 consent matching this revision's `SKILL.md`: review input only, never an approval.
 * `workspaceId` names the workspace whose consent it was (sent by daemons that store inputs).
 */
export interface SkillConsentInput { path: 'SKILL.md'; sha256: string; allowedAt?: string; workspaceId?: string }
/**
 * The installed inspector. `pinned` is true exactly when `pin` (upstream commit plus installed
 * artifact hash) is set; `status` `ready` implies `pinned`. Nothing here is an attestation.
 */
export interface SkillScannerReport {
  scannerId: string;
  pinned: boolean;
  pin?: string;
  /** The scanner's self-reported version. */
  version?: string;
  /** Version of the Extalia-owned report normalizer. */
  normalizerVersion?: string;
  /** Policy version every attestation must match. */
  policyVersion: string;
  status: SkillScannerStatus;
}
export interface SkillActivationResult { packageId: string; revisionId: string; approvalId: number; activatedAt: string; indexGeneration: number }

/** Diagnostic projection only: no raw paths, scopes, parser errors or authority. */
export const SKILL_PREFLIGHT_CODES = [
  'bad_pin', 'missing_pin', 'dependency_unavailable', 'dependency_inactive', 'root_unavailable', 'range_mismatch',
  'unsupported_range', 'compatibility_unknown', 'compatibility_mismatch', 'conflict', 'cycle', 'permission_outside_ceiling', 'bound_exceeded',
] as const;
export type SkillPreflightCode = typeof SKILL_PREFLIGHT_CODES[number];
export interface SkillPreflightInput { rootRevisionId: string; pins: Record<string, string> }
export interface SkillPreflightIssue { code: SkillPreflightCode; packageId?: string; relatedPackageId?: string }
export interface SkillPreflightPackage { packageId: string; version: string; revisionId: string; treeSha256: string; permissionDigest: string }
/** Empty facts/ceiling are daemon-owned defaults. Consistency never grants execution. */
export type SkillPreflightReport = {
  rootRevisionId: string; dispatchEligible: false;
} & (
  | { status: 'blocked'; issues: SkillPreflightIssue[]; truncated: boolean }
  | { status: 'consistent'; issues: []; truncated: false; plan: SkillPreflightPackage[] }
);

export interface DaemonSkillOperations {
  'skill.routingPreview': { params: SkillRoutingInput; result: SkillRoutingReport };
  'skill.preflight': { params: SkillPreflightInput; result: SkillPreflightReport };
  /** Stage a package from the import inbox into quarantine and run the installed inspector. */
  'skill.import': {
    params: { origin: SkillImportOrigin; path: string; sourceRef?: string };
    result: { packageId: string; revisionId: string; treeSha256: string; version: string; state: SkillRevisionState; stateReason?: string; created: boolean };
  };
  /** Revisions (and built-in skills) ordered by package id, then revision id. */
  'skill.list': {
    params: { cursor?: string; limit?: number; packageId?: string };
    result: { revisions: SkillRevisionSummary[]; nextCursor?: string; indexGeneration: number };
  };
  /** One revision with its files, latest inspections, approvals and state history. */
  'skill.inspect': {
    params: { revisionId: string; /** Adds matching W0 consent of this workspace as review input. */ workspaceId?: string };
    result: {
      revision: SkillRevisionSummary; manifest: string; files: SkillFileEntry[]; inspections: SkillInspectionRecord[];
      approvals: SkillApprovalRecord[]; history: SkillStateEvent[]; consent: SkillConsentInput[];
    };
  };
  /**
   * A human review of a `review_required` revision: accept → `validated` (`review-accepted`),
   * reject → `quarantined` (`review-rejected`; only a new inspection leads on).
   */
  'skill.review': {
    params: { revisionId: string; treeSha256: string; principal: string; decision: SkillReviewDecision; note?: string };
    result: { revisionId: string; decision: SkillReviewDecision; state: SkillRevisionState; stateReason?: string; /** The stored review row. */ reviewId?: number };
  };
  /** The user's approval of the digests shown, with an expiry (default 10 minutes). */
  'skill.approve': {
    params: { revisionId: string; treeSha256: string; permissionDigest: string; principal: string; workspaceId?: string; expiresAt?: string };
    result: { approvalId: number; revisionId: string; state: SkillRevisionState; expiresAt: string };
  };
  'skill.activate': { params: { revisionId: string; approvalId: number }; result: SkillActivationResult };
  'skill.deactivate': {
    params: { packageId: string };
    result: { packageId: string; revisionId: string; state: SkillRevisionState; indexGeneration: number };
  };
  /** Re-point the package to a revision it activated before (AC-28). */
  'skill.rollback': { params: { packageId: string; revisionId: string }; result: SkillActivationResult };
  'skill.revoke': {
    params: { revisionId: string };
    result: { revisionId: string; state: SkillRevisionState; indexGeneration: number };
  };
  /** A verified file of an active (or built-in) revision. */
  'skill.read': {
    params: { revisionId: string; path: string };
    result: { revisionId: string; packageId: string; path: string; size: number; sha256: string; content: string };
  };
  /** The installed inspector and policy version; read-only, never runs the scanner. */
  'skill.scanner': { params: Record<string, never>; result: SkillScannerReport };
}
export type DaemonSkillOp = keyof DaemonSkillOperations;
export const DAEMON_SKILL_OPS = [
  'skill.import', 'skill.list', 'skill.inspect', 'skill.review', 'skill.approve', 'skill.activate', 'skill.deactivate', 'skill.rollback',
  'skill.revoke', 'skill.read', 'skill.scanner', 'skill.preflight', 'skill.routingPreview',
] as const satisfies readonly DaemonSkillOp[];
