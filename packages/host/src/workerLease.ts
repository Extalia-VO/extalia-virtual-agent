import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { WorkerLeaseSettlement, WorkerLeaseStatus, WorkerLeaseView } from '@extalia/platform';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { ensurePrivateDirectory } from './paths.js';

export type WorkerLeaseErrorCode =
  | 'invalid'
  | 'not_found'
  | 'already_leased'
  | 'quarantined'
  | 'fenced'
  | 'not_quarantined';

/** Typed error thrown by {@link WorkerLeaseRegistry} on invalid input, lease conflicts, or fencing failures. */
export class WorkerLeaseError extends Error {
  override name = 'WorkerLeaseError';
  constructor(readonly code: WorkerLeaseErrorCode, message: string) {
    super(message);
  }
}

export interface WorkerLeaseRegistryOptions {
  registryFile: string;
  ownerId: string;
  defaultTtlMs?: number;
  now?: () => number;
}

export interface AcquireWorkerLeaseInput {
  taskId: string;
  sessionId?: string;
  missionId?: string;
  worktreeId?: string;
  ttlMs?: number;
}

export interface AttachWorkerProcessInput {
  pid: number;
  processGroupId?: number;
}

export interface ReapWorkerLeaseOptions {
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
  reaped?: Promise<boolean>;
}

interface StoredWorkerLeaseRegistry {
  schema?: unknown;
  nextFencingToken?: unknown;
  leases?: unknown;
}

const SCHEMA = 'extalia.worker-leases.v1';
const MAX_LEASES = 256;
const DEFAULT_TTL_MS = 5 * 60_000;
const LEASE_ID = /^wl-[0-9a-f]{12}$/;
const VALID_STATUSES = new Set<WorkerLeaseStatus>(['active', 'settled', 'quarantined']);
const VALID_SETTLEMENTS = new Set<WorkerLeaseSettlement>(['completed', 'failed', 'cancelled', 'timed_out', 'unknown']);

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function validLeaseRecord(raw: unknown): raw is WorkerLeaseView {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as WorkerLeaseView;
  return typeof record.leaseId === 'string'
    && LEASE_ID.test(record.leaseId)
    && typeof record.ownerId === 'string'
    && record.ownerId.length > 0
    && typeof record.taskId === 'string'
    && record.taskId.length > 0
    && isOptionalString(record.sessionId)
    && isOptionalString(record.missionId)
    && isOptionalString(record.worktreeId)
    && isPositiveInteger(record.fencingToken)
    && (record.pid === undefined || isPositiveInteger(record.pid))
    && (record.processGroupId === undefined || isPositiveInteger(record.processGroupId))
    && VALID_STATUSES.has(record.status)
    && (record.settlement === undefined || VALID_SETTLEMENTS.has(record.settlement))
    && isOptionalString(record.quarantineReason)
    && isValidIsoTimestamp(record.acquiredAt)
    && isValidIsoTimestamp(record.heartbeatAt)
    && isValidIsoTimestamp(record.leaseExpiresAt)
    && (record.settledAt === undefined || isValidIsoTimestamp(record.settledAt));
}

function defaultSignalGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group already exited.
  }
}

function projectLeaseView(record: WorkerLeaseView, timestamp: number): WorkerLeaseView {
  const cloned = structuredClone(record);
  if (cloned.status === 'active' && Date.parse(cloned.leaseExpiresAt) <= timestamp) {
    cloned.status = 'quarantined';
    cloned.settlement = 'unknown';
    cloned.quarantineReason = 'lease_expired_before_settlement';
  }
  return cloned;
}

/**
 * Durable host-owned registry of worker execution leases and monotonic fencing tokens.
 * Enforces crash-restart quarantine (AC-12: never blindly replays or signals prior-host PIDs)
 * and blocks re-acquisition until quarantined unknown settlements are explicitly acknowledged.
 */
export class WorkerLeaseRegistry {
  private readonly registryFile: string;
  private readonly ownerId: string;
  private readonly defaultTtlMs: number;
  private readonly clock: () => number;
  private nextFencingToken: number;
  private leases: WorkerLeaseView[];
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    options: WorkerLeaseRegistryOptions,
    nextFencingToken: number,
    leases: WorkerLeaseView[],
  ) {
    this.registryFile = options.registryFile;
    this.ownerId = options.ownerId;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.clock = options.now ?? (() => Date.now());
    this.nextFencingToken = nextFencingToken;
    this.leases = leases;
  }

  /**
   * Open the durable worker lease registry. Any active leases persisted by a prior host
   * instance or past their expiry are immediately quarantined without blind replay or signalling.
   */
  static async open(options: WorkerLeaseRegistryOptions): Promise<WorkerLeaseRegistry> {
    if (typeof options.ownerId !== 'string' || !options.ownerId.trim()) {
      throw new WorkerLeaseError('invalid', 'Worker lease registry requires a non-empty ownerId.');
    }
    const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
      throw new WorkerLeaseError('invalid', 'Worker lease defaultTtlMs must be a positive number.');
    }

    let stored: StoredWorkerLeaseRegistry | undefined;
    try {
      stored = await readJson<StoredWorkerLeaseRegistry | undefined>(options.registryFile, undefined);
    } catch {
      throw new WorkerLeaseError('invalid', 'The worker lease registry is unreadable. It was left unchanged; nothing was deleted.');
    }

    let leases: WorkerLeaseView[] = [];
    let nextFencingToken = 1;

    if (stored !== undefined) {
      if (
        !stored
        || typeof stored !== 'object'
        || Array.isArray(stored)
        || stored.schema !== SCHEMA
        || typeof stored.nextFencingToken !== 'number'
        || !Number.isInteger(stored.nextFencingToken)
        || stored.nextFencingToken < 0
        || !Array.isArray(stored.leases)
        || stored.leases.length > MAX_LEASES
        || !stored.leases.every(validLeaseRecord)
      ) {
        throw new WorkerLeaseError('invalid', 'The worker lease registry has an invalid schema. It was left unchanged.');
      }
      const seenIds = new Set<string>();
      for (const lease of stored.leases) {
        if (seenIds.has(lease.leaseId)) {
          throw new WorkerLeaseError('invalid', 'The worker lease registry contains duplicate lease identifiers.');
        }
        seenIds.add(lease.leaseId);
      }
      leases = stored.leases.map(lease => structuredClone(lease));
      const maxToken = leases.reduce((max, lease) => Math.max(max, lease.fencingToken), 0);
      nextFencingToken = Math.max(1, stored.nextFencingToken, maxToken + 1);
    }

    const registry = new WorkerLeaseRegistry({ ...options, defaultTtlMs }, nextFencingToken, leases);
    const currentNow = registry.clock();
    let dirty = false;

    for (const record of registry.leases) {
      if (record.status !== 'active') continue;
      if (record.ownerId !== options.ownerId) {
        record.status = 'quarantined';
        record.settlement = 'unknown';
        record.quarantineReason = 'host_restarted_before_settlement';
        dirty = true;
      } else if (Date.parse(record.leaseExpiresAt) <= currentNow) {
        record.status = 'quarantined';
        record.settlement = 'unknown';
        record.quarantineReason = 'lease_expired_before_settlement';
        dirty = true;
      }
    }

    if (dirty) {
      await registry.persist();
    }
    return registry;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    await ensurePrivateDirectory(path.dirname(this.registryFile));
    await writeJsonAtomic(
      this.registryFile,
      {
        schema: SCHEMA,
        nextFencingToken: this.nextFencingToken,
        leases: this.leases,
      },
      { mode: 0o600 },
    );
  }

  private quarantineExpiredLocked(timestamp: number): number {
    let count = 0;
    for (const record of this.leases) {
      if (record.status === 'active' && Date.parse(record.leaseExpiresAt) <= timestamp) {
        record.status = 'quarantined';
        record.settlement = 'unknown';
        record.quarantineReason = 'lease_expired_before_settlement';
        count++;
      }
    }
    return count;
  }

  private evictSettledForCapacity(): void {
    while (this.leases.length >= MAX_LEASES) {
      let oldestIndex = -1;
      let oldestTime = Infinity;
      let oldestToken = Infinity;
      for (let index = 0; index < this.leases.length; index++) {
        const record = this.leases[index]!;
        if (record.status !== 'settled') continue;
        const acquiredMs = Date.parse(record.acquiredAt);
        if (acquiredMs < oldestTime || (acquiredMs === oldestTime && record.fencingToken < oldestToken)) {
          oldestIndex = index;
          oldestTime = acquiredMs;
          oldestToken = record.fencingToken;
        }
      }
      if (oldestIndex === -1) {
        throw new WorkerLeaseError('invalid', 'Too many unresolved worker leases. Reconcile quarantined leases first.');
      }
      this.leases.splice(oldestIndex, 1);
    }
  }

  /** Acquire a new fenced lease for a task/worktree, refusing duplicate active or unresolved quarantined leases. */
  acquire(input: AcquireWorkerLeaseInput): Promise<WorkerLeaseView> {
    if (typeof input?.taskId !== 'string' || !input.taskId.trim()) {
      return Promise.reject(new WorkerLeaseError('invalid', 'Worker lease requires a non-empty taskId.'));
    }
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return Promise.reject(new WorkerLeaseError('invalid', 'Worker lease ttlMs must be a positive number.'));
    }
    return this.serial(async () => {
      const timestamp = this.clock();
      if (this.quarantineExpiredLocked(timestamp) > 0) {
        await this.persist();
      }
      const matchesScope = (record: WorkerLeaseView) =>
        record.taskId === input.taskId
        || (input.worktreeId !== undefined && record.worktreeId === input.worktreeId);

      if (this.leases.some(record => record.status === 'quarantined' && matchesScope(record))) {
        throw new WorkerLeaseError(
          'quarantined',
          'A previous worker lease for this task or worktree ended with uncertain settlement. Acknowledge it before running again.',
        );
      }
      if (this.leases.some(record => record.status === 'active' && matchesScope(record))) {
        throw new WorkerLeaseError('already_leased', 'An active worker lease already exists for this task or worktree.');
      }

      this.evictSettledForCapacity();

      const leaseId = `wl-${randomBytes(6).toString('hex')}`;
      const fencingToken = Math.max(1, this.nextFencingToken);
      this.nextFencingToken = fencingToken + 1;
      const acquiredAt = new Date(timestamp).toISOString();
      const leaseExpiresAt = new Date(timestamp + ttlMs).toISOString();
      const record: WorkerLeaseView = {
        leaseId,
        ownerId: this.ownerId,
        taskId: input.taskId,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
        ...(input.worktreeId !== undefined ? { worktreeId: input.worktreeId } : {}),
        fencingToken,
        status: 'active',
        acquiredAt,
        heartbeatAt: acquiredAt,
        leaseExpiresAt,
      };
      this.leases.push(record);
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Record a live worker child PID / process group onto an active fenced lease. */
  attachProcess(leaseId: string, fencingToken: number, info: AttachWorkerProcessInput): Promise<WorkerLeaseView> {
    if (!isPositiveInteger(info?.pid) || (info.processGroupId !== undefined && !isPositiveInteger(info.processGroupId))) {
      return Promise.reject(new WorkerLeaseError('invalid', 'Attached process requires a valid positive PID.'));
    }
    return this.serial(async () => {
      const timestamp = this.clock();
      if (this.quarantineExpiredLocked(timestamp) > 0) {
        await this.persist();
      }
      const record = this.leases.find(item => item.leaseId === leaseId);
      if (
        !record
        || record.status !== 'active'
        || record.ownerId !== this.ownerId
        || record.fencingToken !== fencingToken
        || Date.parse(record.leaseExpiresAt) <= timestamp
      ) {
        throw new WorkerLeaseError('fenced', 'Worker lease is stale, expired, or no longer owned by this host.');
      }
      record.pid = info.pid;
      if (info.processGroupId !== undefined) {
        record.processGroupId = info.processGroupId;
      }
      record.heartbeatAt = new Date(timestamp).toISOString();
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Extend the expiry of an active fenced lease owned by this host. */
  heartbeat(leaseId: string, fencingToken: number, ttlMs?: number): Promise<WorkerLeaseView> {
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(effectiveTtl) || effectiveTtl <= 0) {
      return Promise.reject(new WorkerLeaseError('invalid', 'Worker lease ttlMs must be a positive number.'));
    }
    return this.serial(async () => {
      const timestamp = this.clock();
      if (this.quarantineExpiredLocked(timestamp) > 0) {
        await this.persist();
      }
      const record = this.leases.find(item => item.leaseId === leaseId);
      if (
        !record
        || record.status !== 'active'
        || record.ownerId !== this.ownerId
        || record.fencingToken !== fencingToken
        || Date.parse(record.leaseExpiresAt) <= timestamp
      ) {
        throw new WorkerLeaseError('fenced', 'Worker lease is stale, expired, or no longer owned by this host.');
      }
      record.heartbeatAt = new Date(timestamp).toISOString();
      record.leaseExpiresAt = new Date(timestamp + effectiveTtl).toISOString();
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Synchronously assert that `leaseId` + `fencingToken` still hold live active ownership on this host. */
  assertFenced(leaseId: string, fencingToken: number): WorkerLeaseView {
    const timestamp = this.clock();
    const record = this.leases.find(item => item.leaseId === leaseId);
    if (
      !record
      || record.status !== 'active'
      || record.ownerId !== this.ownerId
      || record.fencingToken !== fencingToken
      || Date.parse(record.leaseExpiresAt) <= timestamp
    ) {
      throw new WorkerLeaseError('fenced', 'Worker lease is stale, expired, or no longer owned by this host.');
    }
    return structuredClone(record);
  }

  /** Settle an active fenced lease, or quarantine it when `outcome === 'unknown'`. */
  settle(
    leaseId: string,
    fencingToken: number,
    outcome: WorkerLeaseSettlement,
    reason?: string,
  ): Promise<WorkerLeaseView> {
    return this.serial(async () => {
      const timestamp = this.clock();
      const record = this.leases.find(item => item.leaseId === leaseId);
      if (
        !record
        || record.status !== 'active'
        || record.ownerId !== this.ownerId
        || record.fencingToken !== fencingToken
      ) {
        throw new WorkerLeaseError('fenced', 'Worker lease is stale, already settled, or no longer owned by this host.');
      }
      if (outcome === 'unknown') {
        record.status = 'quarantined';
        record.settlement = 'unknown';
        record.quarantineReason = reason ?? 'uncertain_effect_settlement';
      } else {
        record.status = 'settled';
        record.settlement = outcome;
        record.settledAt = new Date(timestamp).toISOString();
      }
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Transition any expired active leases to `quarantined` with `settlement: 'unknown'`. */
  quarantineExpired(): Promise<number> {
    return this.serial(async () => {
      const count = this.quarantineExpiredLocked(this.clock());
      if (count > 0) {
        await this.persist();
      }
      return count;
    });
  }

  /**
   * Signal and wait to reap a live process owned by this host, settling as `cancelled` when
   * reaped cleanly or quarantining as `unknown` (`process_reap_failed`) if reaping fails.
   */
  async reapAndSettleLive(
    leaseId: string,
    fencingToken: number,
    options?: ReapWorkerLeaseOptions,
  ): Promise<WorkerLeaseView> {
    const record = this.assertFenced(leaseId, fencingToken);
    const targetId = record.processGroupId ?? record.pid;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    if (targetId !== undefined && record.ownerId === this.ownerId) {
      const signal = options?.signalGroup ?? defaultSignalGroup;
      try {
        signal(targetId, 'SIGTERM');
      } catch {
        // The process group already exited.
      }
      const graceMs = options?.graceMs ?? 2_000;
      if (Number.isFinite(graceMs) && graceMs > 0) {
        killTimer = setTimeout(() => {
          try {
            signal(targetId, 'SIGKILL');
          } catch {
            // The process group already exited.
          }
        }, graceMs);
        killTimer.unref();
      }
    }

    let reaped: boolean;
    try {
      reaped = await (options?.reaped ?? Promise.resolve(true));
    } catch {
      reaped = false;
    } finally {
      if (killTimer) clearTimeout(killTimer);
    }

    return reaped
      ? this.settle(leaseId, fencingToken, 'cancelled')
      : this.settle(leaseId, fencingToken, 'unknown', 'process_reap_failed');
  }

  /** Explicitly acknowledge a quarantined lease after user inspection, preserving `settlement: 'unknown'`. */
  acknowledgeQuarantine(leaseId: string): Promise<WorkerLeaseView> {
    return this.serial(async () => {
      const record = this.leases.find(item => item.leaseId === leaseId);
      if (!record) {
        throw new WorkerLeaseError('not_found', 'This worker lease does not exist.');
      }
      if (record.status !== 'quarantined') {
        throw new WorkerLeaseError('not_quarantined', 'Only quarantined worker leases can be acknowledged.');
      }
      record.status = 'settled';
      record.settledAt = new Date(this.clock()).toISOString();
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Return all worker leases ordered newest-first (`acquiredAt` descending, then `fencingToken` descending). */
  list(): WorkerLeaseView[] {
    const timestamp = this.clock();
    return this.leases
      .map(record => projectLeaseView(record, timestamp))
      .sort((a, b) => Date.parse(b.acquiredAt) - Date.parse(a.acquiredAt) || b.fencingToken - a.fencingToken);
  }

  /** Return a single worker lease view if present. */
  get(leaseId: string): WorkerLeaseView | undefined {
    const record = this.leases.find(item => item.leaseId === leaseId);
    return record ? projectLeaseView(record, this.clock()) : undefined;
  }
}
