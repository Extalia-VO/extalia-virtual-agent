/**
 * Skill Security Center (W3, ADRs 0023, 0025, 0026): the host API over the Rust core's skill
 * registry. Types reuse the daemon contract (`@extalia/protocol` `daemonSkills.ts`); the
 * validators below bound every value a client sends before the host acts on it. Pure functions
 * only: the host, the Bridge, Desktop and the Web client all use this module.
 *
 * The registry exists only when the host runs the Rust native core (`nativeCore: 'rust'`).
 * Otherwise the report says `mode: 'legacy'` and W0 project-skill consent keeps deciding.
 */
import {
  DAEMON_SKILL_APPROVAL_DEFAULT_TTL_MS, DAEMON_SKILL_LIMITS, SKILL_PACKAGE_ID_PATTERN, SKILL_REVIEW_DECISIONS, SKILL_REVISION_ID_PATTERN,
  type SkillActivationResult, type SkillApprovalRecord, type SkillConsentInput as SkillConsentRecord, type SkillFileEntry, type SkillInspectionRecord,
  type SkillReviewDecision, type SkillRevisionState, type SkillRevisionSummary, type SkillScannerReport, type SkillScannerStatus, type SkillStateEvent,
} from '@extalia/protocol';
import { SKILL_NAME_PATTERN } from './skills.js';

export type {
  SkillActivationResult, SkillApprovalRecord, SkillConsentRecord, SkillFileEntry, SkillInspectionRecord, SkillReviewDecision, SkillRevisionState,
  SkillRevisionSummary, SkillScannerReport, SkillScannerStatus, SkillStateEvent,
};
export type { SkillRoutingInput, SkillRoutingReport, SkillRoutingCandidate, SkillRoutingExclusion, SkillRoutingInputIssue, SkillRoutingScore } from '@extalia/protocol';
import type { SkillRoutingInput, SkillRoutingReport } from '@extalia/protocol';
export type { SkillPreflightInput, SkillPreflightReport, SkillPreflightIssue } from '@extalia/protocol';
import { parseDaemonFrame, type SkillPreflightInput, type SkillPreflightReport } from '@extalia/protocol';

/** The local user: the only principal that reviews or approves (ADR 0026 decision 5). */
export const SKILL_USER_PRINCIPAL = 'user:local';
/** Approval expiry the host requests (ADR 0026 `once` default, ADR 0025 note 2026-10-23). */
export const SKILL_APPROVAL_TTL_MS = DAEMON_SKILL_APPROVAL_DEFAULT_TTL_MS;
export const SKILL_HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
/** Longest folder path an import may name. */
export const MAX_SKILL_IMPORT_PATH = 4096;
export const MAX_SKILL_REVIEW_NOTE = DAEMON_SKILL_LIMITS.note;

/**
 * `legacy`: the native core flag is off; W0 consent decides and the Security Center is hidden.
 * `registry`: the Rust core owns user and project skills; only its active revisions reach agents.
 */
export type SkillRegistryMode = 'legacy' | 'registry';

export interface SkillRegistryReport {
  mode: SkillRegistryMode;
  /**
   * `ready`: the daemon answered. `unavailable`: registry mode, but the daemon cannot answer (or
   * does not serve skills); user and project skills are not offered to agents until it can.
   * `off`: legacy mode.
   */
  status: 'ready' | 'unavailable' | 'off';
  /** Stable code when `unavailable`: a daemon failure code, or `not-served` (no skill operations advertised). */
  unavailableReason?: string;
  /**
   * `pinned` exactly when the daemon reports a `ready` scanner (`skill.scanner`). Otherwise
   * `unpinned`: no verified scanner can run (ADR 0023), so every imported revision stays
   * quarantined. A daemon without `skill.scanner` counts as `unpinned` (fail closed).
   */
  scanner: 'unpinned' | 'pinned';
  /** The installed inspector as the daemon reports it; absent when the daemon does not serve `skill.scanner` or is unavailable. */
  inspector?: SkillScannerReport;
  /** The daemon serves `skill.review` (recording a human review needs core migration 0004). */
  review: boolean;
  /** Optional additive capability; older hosts/daemons omit it. */
  preflight?: boolean;
  /** Optional read-only routing diagnostics; true only when advertised by the daemon. */
  routingPreview?: boolean;
  /** Expiry of a new approval in milliseconds. */
  approvalTtlMs: number;
  /** Every revision of the profile (built-in skills excluded), by package id then revision id. */
  revisions: SkillRevisionSummary[];
  /** More revisions exist than one report carries. */
  truncated: boolean;
  indexGeneration?: number;
}

export interface SkillRevisionDetails {
  revision: SkillRevisionSummary;
  /** Canonical `extalia-skill.json` (or the inferred manifest) as JSON text. Package text: show it as plain text. */
  manifest: string;
  files: SkillFileEntry[];
  inspections: SkillInspectionRecord[];
  approvals: SkillApprovalRecord[];
  history: SkillStateEvent[];
  /**
   * W0 consent matching this revision's SKILL.md, stored as review input (never an approval), each with
   * the workspace it came from when the daemon reports it.
   */
  consent: SkillConsentRecord[];
}

/** Where an import comes from: a folder the user chose, or a skill of a workspace's `.extalia/skills`. */
export type SkillImportSource =
  | { kind: 'folder'; path: string }
  | { kind: 'workspace'; workspaceId: string; name: string };

/** The digests the UI showed; the daemon refuses a stale one (`digest_mismatch`). */
export interface SkillApprovalInput { revisionId: string; treeSha256: string; permissionDigest: string }
export interface SkillReviewInput { revisionId: string; treeSha256: string; decision: SkillReviewDecision; note?: string }

/** The outcome of one Security Center action, with the fresh report. */
export interface SkillActionResult {
  report: SkillRegistryReport;
  revisionId?: string;
  packageId?: string;
  state?: SkillRevisionState;
  stateReason?: string;
  /** `skill.import`: false when the same bytes were already imported. */
  created?: boolean;
  approvalId?: number;
  expiresAt?: string;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** Exact user-selected pins only. Never fill from active/latest revisions. */
export function normalizeSkillPreflight(value: unknown): SkillPreflightInput {
  const input = record(value);
  if (Object.keys(input).some(key => key !== 'rootRevisionId' && key !== 'pins')) throw new Error('Invalid dependency check.');
  const rootRevisionId = normalizeSkillRevisionId(input.rootRevisionId);
  if (!input.pins || typeof input.pins !== 'object' || Array.isArray(input.pins) || Object.keys(input.pins).length > 128) throw new Error('Choose at most 128 exact dependency revisions.');
  const pins: Record<string, string> = {};
  for (const [packageId, revision] of Object.entries(input.pins)) pins[normalizeSkillPackageId(packageId)] = normalizeSkillRevisionId(revision);
  return { rootRevisionId, pins };
}

/** Validate the wire-shaped result even for remote/mocked hosts. No success can admit dispatch. */
export function normalizeSkillPreflightReport(value: unknown, rootRevisionId: string): SkillPreflightReport {
  const parsed = parseDaemonFrame({ schemaVersion: 1, kind: 'response', requestId: '00000000-0000-4000-8000-000000000000', op: 'skill.preflight', result: value });
  if (!parsed.ok || record(value).rootRevisionId !== rootRevisionId) throw new Error('Invalid dependency check result.');
  return value as SkillPreflightReport;
}

/** Validate a revision id (`skr_` + SHA-256). Throws a message safe to show. */
export function normalizeSkillRevisionId(value: unknown): string {
  if (typeof value !== 'string' || !SKILL_REVISION_ID_PATTERN.test(value)) throw new Error('Invalid skill revision.');
  return value;
}

export function normalizeSkillPackageId(value: unknown): string {
  if (typeof value !== 'string' || !SKILL_PACKAGE_ID_PATTERN.test(value)) throw new Error('Invalid skill package.');
  return value;
}

export function normalizeSkillApprovalId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid skill approval.');
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SKILL_HEX_DIGEST_PATTERN.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

/** Validate an import source. A folder must be an absolute path; the host checks the folder itself. */
export function normalizeSkillImportSource(value: unknown): SkillImportSource {
  const input = record(value);
  if (input.kind === 'folder') {
    const folder = input.path;
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('Choose a skill folder.');
    if (folder.length > MAX_SKILL_IMPORT_PATH || /\p{Cc}/u.test(folder)) throw new Error('Invalid folder path.');
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(folder)) throw new Error('Enter the full path of the skill folder.');
    return { kind: 'folder', path: folder };
  }
  if (input.kind === 'workspace') {
    if (typeof input.workspaceId !== 'string' || !input.workspaceId || input.workspaceId.length > 200 || /\p{Cc}/u.test(input.workspaceId)) throw new Error('Choose a workspace.');
    if (typeof input.name !== 'string' || !SKILL_NAME_PATTERN.test(input.name)) throw new Error('Invalid skill name.');
    return { kind: 'workspace', workspaceId: input.workspaceId, name: input.name };
  }
  throw new Error('Choose where to import the skill from.');
}

export function normalizeSkillApproval(value: unknown): SkillApprovalInput {
  const input = record(value);
  return {
    revisionId: normalizeSkillRevisionId(input.revisionId),
    treeSha256: digest(input.treeSha256, 'package hash'),
    permissionDigest: digest(input.permissionDigest, 'permission digest'),
  };
}

/** Text with tab and line breaks as the only control characters (the daemon's rule for review notes). */
// eslint-disable-next-line no-control-regex -- Intentionally reject control characters in untrusted review notes.
const MULTILINE = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;

export function normalizeSkillReview(value: unknown): SkillReviewInput {
  const input = record(value);
  const decision = input.decision;
  if (typeof decision !== 'string' || !(SKILL_REVIEW_DECISIONS as readonly string[]).includes(decision)) throw new Error('Choose accept or reject.');
  const result: SkillReviewInput = { revisionId: normalizeSkillRevisionId(input.revisionId), treeSha256: digest(input.treeSha256, 'package hash'), decision: decision as SkillReviewDecision };
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string' || input.note.length > MAX_SKILL_REVIEW_NOTE || !MULTILINE.test(input.note)) {
      throw new Error(`The review note must be plain text of at most ${MAX_SKILL_REVIEW_NOTE} characters.`);
    }
    if (input.note.trim()) result.note = input.note;
  }
  return result;
}

/** Explicit selectors and exact revisions; callers cannot provide runtime facts or grants. */
export function normalizeSkillRouting(value: unknown): SkillRoutingInput {
  const parsed = parseDaemonFrame({ schemaVersion: 1, kind: 'request', requestId: '00000000-0000-4000-8000-000000000000', op: 'skill.routingPreview', params: value });
  if (!parsed.ok) throw new Error('Invalid skill routing preview.');
  return JSON.parse(JSON.stringify(value)) as SkillRoutingInput;
}

/** Bind the response to the exact preview request, including workspace applicability. */
export function normalizeSkillRoutingReport(value: unknown, input: SkillRoutingInput): SkillRoutingReport {
  const parsed = parseDaemonFrame({ schemaVersion: 1, kind: 'response', requestId: '00000000-0000-4000-8000-000000000000', op: 'skill.routingPreview', result: value });
  if (!parsed.ok) throw new Error('Invalid skill routing preview result.');
  const report = value as SkillRoutingReport, actual = report.input;
  const sameSet = (a: readonly string[], b: readonly string[]) => {
    const left = [...a].sort(), right = [...b].sort();
    return left.length === right.length && left.every((item, i) => item === right[i]);
  };
  if (actual.workspaceId !== input.workspaceId || actual.maxResults !== input.maxResults
    || !sameSet(actual.categories, input.categories) || !sameSet(actual.intents, input.intents) || !sameSet(actual.candidateRevisionIds, input.candidateRevisionIds)
    || !sameSet(Object.keys(actual.pins), Object.keys(input.pins)) || Object.keys(input.pins).some(key => input.pins[key] !== actual.pins[key])) throw new Error('Invalid skill routing preview result.');
  return report;
}
