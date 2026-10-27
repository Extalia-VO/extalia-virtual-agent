/**
 * Daemon wire contract v1 (ADR 0020): messages between the host and the Rust sidecar
 * over stdio, one length-prefixed JSON frame each (`daemonFrame.ts`). The message layer
 * is transport-agnostic. Wire types are transport data: a valid `permission.check`
 * request grants nothing, and the daemon decides transition legality and ownership.
 *
 * Session rules: the host sends `hello` first; any other operation before a successful
 * `hello` fails with `handshake_required`. Each response or error echoes the request's
 * `requestId`. A frame of another `schemaVersion` is rejected fail closed with
 * `unsupported_schema_version` (the error frame's own version names the receiver's),
 * as is a frame larger than the negotiated maximum (`frame_too_large`); both end the
 * connection. Unknown fields are rejected everywhere, as in the orchestration contracts.
 */
import { DAEMON_KNOWLEDGE_OPS, type DaemonKnowledgeOperations } from './daemonKnowledge.js';
import { DAEMON_SKILL_OPS, type DaemonSkillOperations } from './daemonSkills.js';
import type { AgentEvent, Mission, Permission, TaskGraph, TaskState, MissionState } from './orchestration.js';

export const DAEMON_SCHEMA_VERSION = 1 as const;
/** Largest JSON payload of one frame in bytes, excluding the length prefix. */
export const DAEMON_MAX_FRAME_BYTES = 1024 * 1024;
/** Unsigned 32-bit big-endian payload length before every frame. */
export const DAEMON_FRAME_HEADER_BYTES = 4;
/** Upper bound of a request's relative deadline. */
export const DAEMON_MAX_DEADLINE_MS = 10 * 60_000;

/**
 * Contract v1 operations; the skill registry operations (`daemonSkills.ts`) and the knowledge
 * index operations (`daemonKnowledge.ts`) were added later, additively.
 */
export const DAEMON_OPS = ['hello', 'mission.create', 'mission.snapshot', 'task.transition', 'event.commit', 'permission.check', 'health', ...DAEMON_SKILL_OPS, ...DAEMON_KNOWLEDGE_OPS] as const;
export type DaemonOp = (typeof DAEMON_OPS)[number];

/**
 * Stable error codes. Messages are generic and sanitized: never raw storage errors,
 * paths, parameters or credentials.
 * - `invalid_frame`: unreadable frame, non-JSON payload, or invalid envelope/response.
 * - `frame_too_large`: declared length above the maximum; the connection ends.
 * - `unsupported_schema_version`: another `schemaVersion`; the connection ends.
 * - `handshake_required`: an operation before a successful `hello`.
 * - `unknown_op`: an operation this version does not define.
 * - `invalid_request`: request parameters failed validation.
 * - `not_found`, `conflict`: unknown reference; stale `from` state or conflicting reuse of an ID.
 * - `capacity_exceeded`: a retention or size cap is exhausted (ADR 0013/0014).
 * - `storage_failure`: a commit failed; the mission is latched (ADR 0014).
 * - `deadline_exceeded`, `shutting_down`, `internal`.
 * - `denied` (skill operations): a policy, principal or package rule refused the operation;
 *   the error's `reason` names which (for example `scanner_unpinned`, `approval_expired`,
 *   `not_active`, `symlink`, `manifest_invalid`).
 * - `integrity_failure` (skill operations): stored skill bytes no longer match their recorded
 *   hash; the revision was revoked (or the built-in skill unregistered).
 *
 * Skill operations also use `conflict` for a wrong lifecycle state or a stale digest
 * (`reason`: `wrong_state`, `digest_mismatch`, `permission_digest_mismatch`,
 * `approval_mismatch`, `version_reuse`) and `not_found` for an unknown package,
 * revision, approval or file of this profile.
 *
 * Knowledge operations (`daemonKnowledge.ts`) also carry a `reason`: `storage_failure` for an
 * index or vault that cannot be used (`index_locked`, `index_unavailable`, `index_newer_schema`,
 * `vault_unavailable`, `io_failure`), `integrity_failure` (`index_corrupt`), `capacity_exceeded`
 * (`vault_too_large`, `result_too_large`), `conflict` (`note_changed`) and `not_found`
 * (`node_not_found`). Note writes, history and rollback add `invalid_request` (`invalid_path`),
 * `capacity_exceeded` (`too_large`), `denied` (`not_utf8`, `unsafe_path`), `not_found`
 * (`note_not_found`, `unknown_version`) and `storage_failure` (`history_unavailable`).
 */
export const DAEMON_ERROR_CODES = [
  'invalid_frame', 'frame_too_large', 'unsupported_schema_version', 'handshake_required', 'unknown_op', 'invalid_request',
  'not_found', 'conflict', 'capacity_exceeded', 'storage_failure', 'deadline_exceeded', 'shutting_down', 'internal',
  'denied', 'integrity_failure',
] as const;
export type DaemonErrorCode = (typeof DAEMON_ERROR_CODES)[number];

/** Mirrors the runtime policy inputs (`decide(access, workspacePermissions, sessionGrants, mode)`). */
export type DaemonToolAccess = 'read' | 'write' | 'execute' | 'memory' | 'meta';
export const DAEMON_TOOL_ACCESS: readonly DaemonToolAccess[] = ['read', 'write', 'execute', 'memory', 'meta'];
export type DaemonPermissionMode = 'workspace' | 'ask' | 'accept-edits' | 'plan';
export const DAEMON_PERMISSION_MODES: readonly DaemonPermissionMode[] = ['workspace', 'ask', 'accept-edits', 'plan'];
export interface DaemonWorkspacePermissions { fileWrite: 'ask' | 'allow'; commands: 'ask' | 'allow' }

/** Profile-scoped authoritative state, read atomically without changing execution. */
export interface DaemonMissionSnapshot {
  missionId: string;
  workspaceId: string;
  version: number;
  state: MissionState;
  updatedAt: string;
  /** Latest committed journal sequence; distinct from the mission version. */
  sequence: number;
  tasks: { taskId: string; assignedAgentId?: string; state: TaskState; attempt: number }[];
  /** Recorded lease times; no inferred heartbeat or execution guarantee. */
  leases: { leaseId: string; taskId: string; holderAgentId: string; acquiredAt: string; expiresAt: string }[];
}

export interface DaemonOperations extends DaemonSkillOperations, DaemonKnowledgeOperations {
  /** Capabilities list operations, never authorization to invoke them. */
  hello: {
    params: { clientVersion: string; capabilities: DaemonOp[] };
    result: { daemonVersion: string; capabilities: DaemonOp[]; maxFrameBytes: number };
  };
  /** Creates a mission and its task graph in one transaction. */
  'mission.create': {
    params: { mission: Mission; graph: TaskGraph };
    result: { missionId: string; version: number };
  };
  /** Reads this daemon profile's canonical mission, tasks and leases in one transaction. */
  'mission.snapshot': { params: { missionId: string }; result: DaemonMissionSnapshot };
  /** Compare-and-set of one task state, journaled as a `task.state` event with `eventId` (idempotent). */
  'task.transition': {
    params: { missionId: string; taskId: string; eventId: string; from: TaskState; to: TaskState };
    result: { missionId: string; taskId: string; state: TaskState; sequence: number };
  };
  /** Commits one mission control event; the daemon assigns the per-mission sequence (ADR 0014). */
  'event.commit': {
    params: { event: AgentEvent };
    result: { eventId: string; missionId: string; sequence: number; duplicate: boolean };
  };
  'permission.check': {
    params: { access: DaemonToolAccess; mode: DaemonPermissionMode; workspacePermissions: DaemonWorkspacePermissions; sessionGrants: DaemonToolAccess[] };
    result: { decision: Permission['decision'] };
  };
  health: {
    params: Record<string, never>;
    result: { status: 'ok' | 'degraded'; uptimeMs: number };
  };
}

interface DaemonEnvelope { schemaVersion: typeof DAEMON_SCHEMA_VERSION; requestId: string }
export type DaemonRequest<O extends DaemonOp = DaemonOp> = {
  [K in O]: DaemonEnvelope & { kind: 'request'; op: K; /** Relative budget in milliseconds. */ deadlineMs?: number; params: DaemonOperations[K]['params'] };
}[O];
export type DaemonResponse<O extends DaemonOp = DaemonOp> = {
  [K in O]: DaemonEnvelope & { kind: 'response'; op: K; result: DaemonOperations[K]['result'] };
}[O];
export interface DaemonErrorFrame {
  schemaVersion: typeof DAEMON_SCHEMA_VERSION;
  kind: 'error';
  /** Absent only when the failing frame could not be correlated. */
  requestId?: string;
  /** `reason`: a stable refusal code (`SKILL_REASON_PATTERN`); sent by skill and knowledge operations only. */
  error: { code: DaemonErrorCode; message?: string; reason?: string };
}
export type DaemonFrame = DaemonRequest | DaemonResponse | DaemonErrorFrame;
export type DaemonFrameParseResult =
  | { ok: true; frame: DaemonFrame }
  | { ok: false; code: DaemonErrorCode; errors: string[]; requestId?: string };
