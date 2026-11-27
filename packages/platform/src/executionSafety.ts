/**
 * Browser-safe types and input validators for execution safety inspection & recovery:
 * exact-action approval ledger review/revocation (`AC-27`, `COD-006`) and
 * durable worker process lease fencing/quarantine (`WP-07`, `AC-12`, `AC-30`).
 */

export type ExactApprovalState = 'pending' | 'granted' | 'rejected' | 'consumed' | 'revoked' | 'expired';
export type ExactApprovalAccess = 'read' | 'write' | 'execute';
export type ExactApprovalDecision = 'once' | 'session' | 'reject';

export interface ExactApprovalView {
  approvalId: string;
  sessionId: string;
  workspaceId: string | null;
  toolName: string;
  access: ExactApprovalAccess;
  target?: string;
  generation: number;
  actionDigest: string;
  state: ExactApprovalState;
  decision?: ExactApprovalDecision;
  issuedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  consumedAt?: number;
  revokedAt?: number;
  revokeReason?: string;
}

export type WorkerLeaseStatus = 'active' | 'settled' | 'quarantined';
export type WorkerLeaseSettlement = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
export type WorkerLeaseReconcileAction = 'acknowledge';

export interface WorkerLeaseView {
  leaseId: string;
  ownerId: string;
  taskId: string;
  sessionId?: string;
  missionId?: string;
  worktreeId?: string;
  fencingToken: number;
  pid?: number;
  processGroupId?: number;
  status: WorkerLeaseStatus;
  settlement?: WorkerLeaseSettlement;
  quarantineReason?: string;
  acquiredAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
  settledAt?: string;
}

const WORKER_LEASE_ID = /^wl-[0-9a-f]{12}$/;

export class ExecutionSafetyInputError extends Error {
  override name = 'ExecutionSafetyInputError';
}

function invalid(message: string): never {
  throw new ExecutionSafetyInputError(message);
}

/** Validate an optional session filter for `listApprovals`. */
export function normalizeApprovalSessionFilter(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') invalid('Invalid session filter.');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 160 || /\p{Cc}/u.test(trimmed)) {
    invalid('Invalid session filter.');
  }
  return trimmed;
}

/** Validate a durable worker lease identifier (`wl-<12 hex>`). */
export function normalizeWorkerLeaseId(raw: unknown): string {
  return typeof raw === 'string' && WORKER_LEASE_ID.test(raw)
    ? raw
    : invalid('Invalid worker lease id.');
}

/** Validate an explicit user reconciliation action on a quarantined worker lease. */
export function normalizeWorkerLeaseReconcileAction(raw: unknown): WorkerLeaseReconcileAction {
  if (raw !== 'acknowledge') {
    invalid('Unsupported worker lease reconciliation action.');
  }
  return raw;
}

export const EXECUTION_SAFETY_HOST_METHODS = [
  'listApprovals',
  'listWorkerLeases',
  'reconcileWorkerLease',
] as const;
