import { createHash } from 'node:crypto';
import type { ApprovalOutcome, ToolAccess } from '@extalia/runtime';

export interface ActionDigestInput {
  sessionId: string;
  workspaceId: string | null;
  toolName: string;
  access: ToolAccess;
  target?: string;
  argumentsJson: string;
  generation: number;
}

export type ExactApprovalState = 'pending' | 'granted' | 'rejected' | 'consumed' | 'revoked' | 'expired';

export interface ExactApprovalRecord {
  approvalId: string;
  sessionId: string;
  workspaceId: string | null;
  toolName: string;
  access: ToolAccess;
  target?: string;
  argumentsJson: string;
  generation: number;
  actionDigest: string;
  state: ExactApprovalState;
  decision?: ApprovalOutcome;
  issuedAt: number;
  expiresAt: number;
  resolvedAt?: number;
  consumedAt?: number;
  revokedAt?: number;
  revokeReason?: string;
}

export interface IssueApprovalInput extends ActionDigestInput {
  approvalId: string;
  ttlMs?: number;
}

export interface VerifyApprovalEffectInput {
  sessionId: string;
  workspaceId: string | null;
  actionDigest: string;
  generation: number;
}

export type ResolveApprovalResult =
  | { ok: true; record: ExactApprovalRecord }
  | { ok: false; code: 'not_found' | 'already_settled' | 'revoked' | 'expired'; message: string };

export type VerifyApprovalEffectResult =
  | { ok: true; record: ExactApprovalRecord }
  | { ok: false; code: 'not_found' | 'not_granted' | 'consumed' | 'revoked' | 'expired' | 'mismatch'; message: string };

export interface ExactApprovalLedgerOptions {
  /** Default time-to-live for issued approvals in milliseconds. Defaults to 5 minutes. */
  ttlMs?: number;
  /** Clock function for deterministic testing. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 512;

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry !== undefined) sorted[key] = canonicalValue(entry);
  }
  return sorted;
}

/** Stable JSON serialization for tool arguments so equivalent objects share one digest. */
export function canonicalArgumentsJson(input: unknown): string {
  if (input === undefined) return 'null';
  return JSON.stringify(canonicalValue(input)) ?? 'null';
}

/**
 * Computes a deterministic `sha256:` digest binding an approval to the exact
 * session, workspace, tool, access level, target, arguments, and workspace generation.
 */
export function computeActionDigest(input: ActionDigestInput): string {
  const canonical = JSON.stringify({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    toolName: input.toolName,
    access: input.access,
    target: input.target ?? null,
    argumentsJson: input.argumentsJson,
    generation: input.generation,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function isSettled(state: ExactApprovalState): boolean {
  return state !== 'pending' && state !== 'granted';
}

/**
 * In-memory exact-action approval ledger enforcing single-use consumption,
 * TTL expiry, revocation on cancel/workspace-change, and effect-time verification.
 */
export class ExactApprovalLedger {
  private readonly entries = new Map<string, ExactApprovalRecord>();
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;

  constructor(options: ExactApprovalLedgerOptions = {}) {
    this.defaultTtlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = options.now ?? (() => Date.now());
  }

  private refreshExpiry(record: ExactApprovalRecord, timestamp: number): void {
    if ((record.state === 'pending' || record.state === 'granted') && timestamp > record.expiresAt) {
      record.state = 'expired';
    }
  }

  private evictIfNeeded(timestamp: number): void {
    if (this.entries.size < MAX_ENTRIES) return;
    for (const record of this.entries.values()) {
      this.refreshExpiry(record, timestamp);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      let evictKey: string | undefined;
      for (const [key, record] of this.entries) {
        if (isSettled(record.state)) {
          evictKey = key;
          break;
        }
      }
      if (!evictKey) {
        evictKey = this.entries.keys().next().value;
      }
      if (!evictKey) break;
      this.entries.delete(evictKey);
    }
  }

  issue(input: IssueApprovalInput): ExactApprovalRecord {
    const timestamp = this.clock();
    this.evictIfNeeded(timestamp);
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const record: ExactApprovalRecord = {
      approvalId: input.approvalId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      toolName: input.toolName,
      access: input.access,
      ...(input.target !== undefined ? { target: input.target } : {}),
      argumentsJson: input.argumentsJson,
      generation: input.generation,
      actionDigest: computeActionDigest(input),
      state: 'pending',
      issuedAt: timestamp,
      expiresAt: timestamp + ttlMs,
    };
    this.entries.set(record.approvalId, record);
    return structuredClone(record);
  }

  resolve(approvalId: string, decision: ApprovalOutcome): ResolveApprovalResult {
    const record = this.entries.get(approvalId);
    if (!record) {
      return { ok: false, code: 'not_found', message: 'This approval request does not exist.' };
    }
    const timestamp = this.clock();
    this.refreshExpiry(record, timestamp);
    if (record.state === 'revoked') {
      return { ok: false, code: 'revoked', message: 'This approval request was revoked before it could be resolved.' };
    }
    if (record.state === 'expired') {
      return { ok: false, code: 'expired', message: 'This approval request has expired.' };
    }
    if (record.state !== 'pending') {
      return { ok: false, code: 'already_settled', message: 'This approval request has already been resolved.' };
    }
    record.decision = decision;
    record.resolvedAt = timestamp;
    record.state = decision === 'reject' ? 'rejected' : 'granted';
    return { ok: true, record: structuredClone(record) };
  }

  revoke(approvalId: string, reason?: string): ExactApprovalRecord | undefined {
    const record = this.entries.get(approvalId);
    if (!record) return undefined;
    const timestamp = this.clock();
    this.refreshExpiry(record, timestamp);
    if (record.state === 'pending' || record.state === 'granted') {
      record.state = 'revoked';
      record.revokedAt = timestamp;
      if (reason) record.revokeReason = reason;
    }
    return structuredClone(record);
  }

  revokeSession(sessionId: string, reason?: string): number {
    const timestamp = this.clock();
    let count = 0;
    for (const record of this.entries.values()) {
      if (record.sessionId !== sessionId) continue;
      this.refreshExpiry(record, timestamp);
      if (record.state === 'pending' || record.state === 'granted') {
        record.state = 'revoked';
        record.revokedAt = timestamp;
        if (reason) record.revokeReason = reason;
        count++;
      }
    }
    return count;
  }

  revokeAll(reason?: string): number {
    const timestamp = this.clock();
    let count = 0;
    for (const record of this.entries.values()) {
      this.refreshExpiry(record, timestamp);
      if (record.state === 'pending' || record.state === 'granted') {
        record.state = 'revoked';
        record.revokedAt = timestamp;
        if (reason) record.revokeReason = reason;
        count++;
      }
    }
    return count;
  }

  verifyForEffect(approvalId: string, expected: VerifyApprovalEffectInput): VerifyApprovalEffectResult {
    const record = this.entries.get(approvalId);
    if (!record) {
      return { ok: false, code: 'not_found', message: 'Approval record was not found for this action.' };
    }
    const timestamp = this.clock();
    this.refreshExpiry(record, timestamp);
    if (record.state === 'revoked') {
      return {
        ok: false,
        code: 'revoked',
        message: record.revokeReason
          ? `Approval was revoked before execution (${record.revokeReason}).`
          : 'Approval was revoked before execution.',
      };
    }
    if (record.state === 'consumed') {
      return { ok: false, code: 'consumed', message: 'This single-use approval has already been consumed.' };
    }
    if (record.state === 'expired') {
      return { ok: false, code: 'expired', message: 'Approval expired before execution. Request approval again.' };
    }
    if (record.state !== 'granted') {
      return { ok: false, code: 'not_granted', message: 'Action does not have a granted approval.' };
    }
    if (
      record.sessionId !== expected.sessionId
      || record.workspaceId !== expected.workspaceId
      || record.actionDigest !== expected.actionDigest
      || record.generation !== expected.generation
    ) {
      return {
        ok: false,
        code: 'mismatch',
        message: 'Approval no longer matches the exact action or workspace state. Request approval again.',
      };
    }
    if (record.decision === 'once') {
      record.state = 'consumed';
      record.consumedAt = timestamp;
    }
    return { ok: true, record: structuredClone(record) };
  }

  get(approvalId: string): ExactApprovalRecord | undefined {
    const record = this.entries.get(approvalId);
    if (!record) return undefined;
    this.refreshExpiry(record, this.clock());
    return structuredClone(record);
  }

  list(sessionId?: string): ExactApprovalRecord[] {
    const timestamp = this.clock();
    const results: ExactApprovalRecord[] = [];
    for (const record of this.entries.values()) {
      if (sessionId !== undefined && record.sessionId !== sessionId) continue;
      this.refreshExpiry(record, timestamp);
      results.push(structuredClone(record));
    }
    return results;
  }
}
