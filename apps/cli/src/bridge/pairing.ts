import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  BridgePairingInputError,
  normalizeBridgeClientId,
  normalizeBridgeClientName,
  normalizeBridgeClientScopes,
  type BridgeClientGrantState,
  type BridgeClientGrantView,
  type BridgeClientScope,
  type BridgePairingChallengeView,
} from '@extalia/platform';

export type BridgePairingErrorCode =
  | 'invalid'
  | 'not_found'
  | 'expired'
  | 'consumed'
  | 'invalid_code'
  | 'locked'
  | 'corrupt';

export class BridgePairingError extends Error {
  override name = 'BridgePairingError';

  constructor(readonly code: BridgePairingErrorCode, message: string) {
    super(message);
  }
}

export interface StoredBridgeGrant {
  clientId: string;
  name: string;
  scopes: BridgeClientScope[];
  state: BridgeClientGrantState;
  tokenHash: string;
  issuedAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

interface PersistedBridgeGrants {
  schema: 'extalia.bridge-grants.v1';
  grants: StoredBridgeGrant[];
}

interface PendingChallenge {
  challengeId: string;
  clientName: string;
  requestedScopes: BridgeClientScope[];
  codeHash: Buffer;
  expiresAtMs: number;
  attempts: number;
}

interface FinishedChallenge {
  status: 'consumed' | 'locked';
  expiresAtMs: number;
}

export interface BridgePairingOpenOptions {
  filePath: string;
  now?: () => number;
}

export interface IssueBridgeChallengeOptions {
  name: unknown;
  scopes: unknown;
  ttlMs?: unknown;
}

export interface ConfirmBridgeChallengeOptions {
  challengeId: unknown;
  code: unknown;
  grantTtlMs?: unknown;
}

export type VerifyBridgeTokenResult =
  | { ok: true; clientId: string; scopes: BridgeClientScope[] }
  | { ok: false; status: 401; reason: 'invalid' | 'revoked' | 'expired'; message: string };

const BRIDGE_GRANTS_SCHEMA = 'extalia.bridge-grants.v1';
const CHALLENGE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CHALLENGE_CODE_LENGTH = 8;
const DEFAULT_CHALLENGE_TTL_MS = 120_000;
const MAX_CHALLENGE_TTL_MS = 900_000;
const MAX_PENDING_CHALLENGES = 64;
const MAX_FINISHED_CHALLENGES = 256;
const MAX_CODE_ATTEMPTS = 5;
const MAX_REVOKE_REASON_LENGTH = 200;

const TOKEN_PATTERN = /^extb_(bc-[0-9a-f]{12})_([0-9a-f]{64})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const GRANT_STATES = new Set<BridgeClientGrantState>(['active', 'revoked', 'expired']);
const CONTROL_CHAR_PATTERN = /\p{Cc}/gu;

const sha256Buffer = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const sha256Hex = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toGrantView(record: StoredBridgeGrant): BridgeClientGrantView {
  return {
    clientId: record.clientId,
    name: record.name,
    scopes: [...record.scopes],
    state: record.state,
    issuedAt: record.issuedAt,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.revokeReason !== undefined ? { revokeReason: record.revokeReason } : {}),
  };
}

function cloneGrant(record: StoredBridgeGrant): StoredBridgeGrant {
  return {
    clientId: record.clientId,
    name: record.name,
    scopes: [...record.scopes],
    state: record.state,
    tokenHash: record.tokenHash,
    issuedAt: record.issuedAt,
    ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
    ...(record.lastUsedAt !== undefined ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.revokeReason !== undefined ? { revokeReason: record.revokeReason } : {}),
  };
}

function validateStoredGrant(raw: unknown): StoredBridgeGrant {
  if (!isPlainObject(raw)) {
    throw new BridgePairingError('corrupt', 'Bridge grants store entry must be an object.');
  }
  if ('token' in raw || 'code' in raw) {
    throw new BridgePairingError('corrupt', 'Bridge grants store must never contain plaintext secrets.');
  }
  let clientId: string;
  let name: string;
  let scopes: BridgeClientScope[];
  try {
    clientId = normalizeBridgeClientId(raw.clientId);
    name = normalizeBridgeClientName(raw.name);
    scopes = normalizeBridgeClientScopes(raw.scopes);
  } catch (error) {
    const detail = error instanceof BridgePairingInputError ? error.message : 'Invalid Bridge grant entry.';
    throw new BridgePairingError('corrupt', detail);
  }
  if (typeof raw.state !== 'string' || !GRANT_STATES.has(raw.state as BridgeClientGrantState)) {
    throw new BridgePairingError('corrupt', `Invalid Bridge grant state for ${clientId}.`);
  }
  if (typeof raw.tokenHash !== 'string' || !SHA256_HEX_PATTERN.test(raw.tokenHash)) {
    throw new BridgePairingError('corrupt', `Invalid token hash for ${clientId}.`);
  }
  if (!isValidIsoTimestamp(raw.issuedAt)) {
    throw new BridgePairingError('corrupt', `Invalid issuedAt timestamp for ${clientId}.`);
  }
  if (raw.expiresAt !== undefined && !isValidIsoTimestamp(raw.expiresAt)) {
    throw new BridgePairingError('corrupt', `Invalid expiresAt timestamp for ${clientId}.`);
  }
  if (raw.lastUsedAt !== undefined && !isValidIsoTimestamp(raw.lastUsedAt)) {
    throw new BridgePairingError('corrupt', `Invalid lastUsedAt timestamp for ${clientId}.`);
  }
  if (raw.revokedAt !== undefined && !isValidIsoTimestamp(raw.revokedAt)) {
    throw new BridgePairingError('corrupt', `Invalid revokedAt timestamp for ${clientId}.`);
  }
  if (raw.revokeReason !== undefined && typeof raw.revokeReason !== 'string') {
    throw new BridgePairingError('corrupt', `Invalid revokeReason for ${clientId}.`);
  }
  return {
    clientId,
    name,
    scopes,
    state: raw.state as BridgeClientGrantState,
    tokenHash: raw.tokenHash,
    issuedAt: raw.issuedAt,
    ...(raw.expiresAt !== undefined ? { expiresAt: raw.expiresAt } : {}),
    ...(raw.lastUsedAt !== undefined ? { lastUsedAt: raw.lastUsedAt } : {}),
    ...(raw.revokedAt !== undefined ? { revokedAt: raw.revokedAt } : {}),
    ...(raw.revokeReason !== undefined ? { revokeReason: raw.revokeReason } : {}),
  };
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20 * attempt));
    }
  }
}

async function writeGrantsAtomic(filePath: string, payload: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempFile = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tempFile, payload, { encoding: 'utf8', mode: 0o600 });
    if (process.platform !== 'win32') await chmod(tempFile, 0o600);
    await renameWithRetry(tempFile, filePath);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Durable store for scoped Bridge pairing challenges and least-privilege client grants.
 * Plaintext tokens and pairing codes are never written to disk; only SHA-256 digests are persisted.
 */
export class BridgePairingStore {
  private readonly pendingChallenges = new Map<string, PendingChallenge>();
  private readonly finishedChallenges = new Map<string, FinishedChallenge>();
  private readonly revokedListeners = new Set<(clientId: string) => void>();
  private writeChain: Promise<void> = Promise.resolve();
  private persistScheduled = false;
  private closed = false;

  private constructor(
    private readonly filePath: string,
    private readonly grants: Map<string, StoredBridgeGrant>,
    private readonly now: () => number,
  ) {}

  static async open(options: BridgePairingOpenOptions): Promise<BridgePairingStore> {
    if (typeof options.filePath !== 'string' || !options.filePath.trim()) {
      throw new BridgePairingError('invalid', 'Bridge grants file path is required.');
    }
    const now = options.now ?? (() => Date.now());
    const grants = new Map<string, StoredBridgeGrant>();
    let raw: string | undefined;
    try {
      raw = await readFile(options.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new BridgePairingError('corrupt', `Could not read Bridge grants store: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new BridgePairingError('corrupt', 'Bridge grants store contains invalid JSON.');
      }
      if (!isPlainObject(parsed) || parsed.schema !== BRIDGE_GRANTS_SCHEMA || !Array.isArray(parsed.grants)) {
        throw new BridgePairingError('corrupt', 'Bridge grants store has an invalid schema.');
      }
      for (const entry of parsed.grants) {
        const record = validateStoredGrant(entry);
        if (grants.has(record.clientId)) {
          throw new BridgePairingError('corrupt', `Duplicate Bridge client grant id: ${record.clientId}.`);
        }
        if (record.state === 'active' && record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now()) {
          record.state = 'expired';
        }
        grants.set(record.clientId, record);
      }
    }
    return new BridgePairingStore(options.filePath, grants, now);
  }

  private pruneChallenges(nowMs: number): void {
    for (const [id, challenge] of this.pendingChallenges) {
      if (challenge.expiresAtMs <= nowMs) this.pendingChallenges.delete(id);
    }
    for (const [id, finished] of this.finishedChallenges) {
      if (finished.expiresAtMs <= nowMs) this.finishedChallenges.delete(id);
    }
  }

  private recordFinished(challengeId: string, status: 'consumed' | 'locked', expiresAtMs: number): void {
    while (this.finishedChallenges.size >= MAX_FINISHED_CHALLENGES) {
      const oldest = this.finishedChallenges.keys().next().value;
      if (oldest === undefined) break;
      this.finishedChallenges.delete(oldest);
    }
    this.finishedChallenges.set(challengeId, { status, expiresAtMs });
  }

  private refreshExpiry(record: StoredBridgeGrant, nowMs = this.now()): void {
    if (record.state === 'active' && record.expiresAt !== undefined && Date.parse(record.expiresAt) <= nowMs) {
      record.state = 'expired';
    }
  }

  private buildPersistedPayload(): string {
    const data: PersistedBridgeGrants = {
      schema: BRIDGE_GRANTS_SCHEMA,
      grants: [...this.grants.values()].map(cloneGrant),
    };
    return `${JSON.stringify(data, null, 2)}\n`;
  }

  private async persistNow(): Promise<void> {
    this.persistScheduled = false;
    const task = this.writeChain.then(() => writeGrantsAtomic(this.filePath, this.buildPersistedPayload()));
    this.writeChain = task.catch(() => undefined);
    return task;
  }

  private schedulePersist(): void {
    if (this.closed || this.persistScheduled) return;
    this.persistScheduled = true;
    const task = this.writeChain.then(() => {
      if (!this.persistScheduled) return;
      this.persistScheduled = false;
      return writeGrantsAtomic(this.filePath, this.buildPersistedPayload());
    });
    this.writeChain = task.catch(() => undefined);
  }

  /** Flush any in-flight scheduled persistence writes before closing or cleaning up storage. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.persistScheduled) {
      await this.writeChain;
    }
    await this.writeChain;
  }

  issueChallenge(input: IssueBridgeChallengeOptions): BridgePairingChallengeView {
    let clientName: string;
    let requestedScopes: BridgeClientScope[];
    try {
      clientName = normalizeBridgeClientName(input.name);
      requestedScopes = normalizeBridgeClientScopes(input.scopes);
    } catch (error) {
      const detail = error instanceof BridgePairingInputError ? error.message : 'Invalid Bridge pairing request.';
      throw new BridgePairingError('invalid', detail);
    }
    const ttlMs = input.ttlMs === undefined ? DEFAULT_CHALLENGE_TTL_MS : input.ttlMs;
    if (typeof ttlMs !== 'number' || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_CHALLENGE_TTL_MS) {
      throw new BridgePairingError('invalid', `Challenge TTL must be a positive integer up to ${MAX_CHALLENGE_TTL_MS} ms.`);
    }

    const nowMs = this.now();
    this.pruneChallenges(nowMs);
    while (this.pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.pendingChallenges.keys().next().value;
      if (oldest === undefined) break;
      this.pendingChallenges.delete(oldest);
    }

    const challengeId = `bp-${randomBytes(6).toString('hex')}`;
    let code = '';
    for (let i = 0; i < CHALLENGE_CODE_LENGTH; i++) {
      code += CHALLENGE_ALPHABET[randomInt(0, CHALLENGE_ALPHABET.length)];
    }
    const expiresAtMs = nowMs + ttlMs;
    this.pendingChallenges.set(challengeId, {
      challengeId,
      clientName,
      requestedScopes,
      codeHash: sha256Buffer(code),
      expiresAtMs,
      attempts: 0,
    });

    return {
      challengeId,
      clientName,
      requestedScopes: [...requestedScopes],
      code,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  async confirmChallenge(input: ConfirmBridgeChallengeOptions): Promise<{ client: BridgeClientGrantView; token: string }> {
    if (typeof input.challengeId !== 'string' || !input.challengeId.trim()) {
      throw new BridgePairingError('invalid', 'Challenge id is required.');
    }
    const challengeId = input.challengeId.trim();
    const grantTtlMs = input.grantTtlMs;
    if (grantTtlMs !== undefined && (typeof grantTtlMs !== 'number' || !Number.isInteger(grantTtlMs) || grantTtlMs <= 0)) {
      throw new BridgePairingError('invalid', 'Grant TTL must be a positive integer.');
    }

    const finished = this.finishedChallenges.get(challengeId);
    if (finished?.status === 'consumed') {
      throw new BridgePairingError('consumed', 'Pairing challenge has already been used.');
    }
    if (finished?.status === 'locked') {
      throw new BridgePairingError('locked', 'Pairing challenge is locked after too many failed attempts.');
    }

    const challenge = this.pendingChallenges.get(challengeId);
    if (!challenge) {
      throw new BridgePairingError('not_found', 'Pairing challenge was not found.');
    }

    const nowMs = this.now();
    if (challenge.expiresAtMs <= nowMs) {
      this.pendingChallenges.delete(challengeId);
      throw new BridgePairingError('expired', 'Pairing challenge has expired.');
    }
    if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
      this.pendingChallenges.delete(challengeId);
      this.recordFinished(challengeId, 'locked', challenge.expiresAtMs);
      throw new BridgePairingError('locked', 'Pairing challenge is locked after too many failed attempts.');
    }

    const normalizedCode = String(input.code ?? '').trim().toUpperCase();
    const givenHash = sha256Buffer(normalizedCode);
    if (givenHash.length !== challenge.codeHash.length || !timingSafeEqual(givenHash, challenge.codeHash)) {
      challenge.attempts += 1;
      if (challenge.attempts >= MAX_CODE_ATTEMPTS) {
        this.pendingChallenges.delete(challengeId);
        this.recordFinished(challengeId, 'locked', challenge.expiresAtMs);
      }
      throw new BridgePairingError('invalid_code', 'Invalid pairing code.');
    }

    this.pendingChallenges.delete(challengeId);
    this.recordFinished(challengeId, 'consumed', challenge.expiresAtMs);

    let clientId = `bc-${randomBytes(6).toString('hex')}`;
    while (this.grants.has(clientId)) {
      clientId = `bc-${randomBytes(6).toString('hex')}`;
    }
    const token = `extb_${clientId}_${randomBytes(32).toString('hex')}`;
    const record: StoredBridgeGrant = {
      clientId,
      name: challenge.clientName,
      scopes: [...challenge.requestedScopes],
      state: 'active',
      tokenHash: sha256Hex(token),
      issuedAt: new Date(nowMs).toISOString(),
      ...(grantTtlMs !== undefined ? { expiresAt: new Date(nowMs + grantTtlMs).toISOString() } : {}),
    };
    this.grants.set(clientId, record);
    await this.persistNow();
    return { client: toGrantView(record), token };
  }

  verifyToken(rawToken: unknown): VerifyBridgeTokenResult {
    if (typeof rawToken !== 'string') {
      return { ok: false, status: 401, reason: 'invalid', message: 'Missing or invalid Bridge token.' };
    }
    const match = TOKEN_PATTERN.exec(rawToken);
    if (!match) {
      return { ok: false, status: 401, reason: 'invalid', message: 'Missing or invalid Bridge token.' };
    }
    const clientId = match[1] as string;
    const record = this.grants.get(clientId);
    if (!record) {
      return { ok: false, status: 401, reason: 'invalid', message: 'Missing or invalid Bridge token.' };
    }

    const givenHash = Buffer.from(sha256Hex(rawToken), 'hex');
    const expectedHash = Buffer.from(record.tokenHash, 'hex');
    if (givenHash.length !== expectedHash.length || !timingSafeEqual(givenHash, expectedHash)) {
      return { ok: false, status: 401, reason: 'invalid', message: 'Missing or invalid Bridge token.' };
    }

    if (record.state === 'revoked') {
      return { ok: false, status: 401, reason: 'revoked', message: 'Bridge client token has been revoked.' };
    }

    const nowMs = this.now();
    this.refreshExpiry(record, nowMs);
    if (record.state === 'expired') {
      return { ok: false, status: 401, reason: 'expired', message: 'Bridge client token has expired.' };
    }

    record.lastUsedAt = new Date(nowMs).toISOString();
    this.schedulePersist();
    return { ok: true, clientId: record.clientId, scopes: [...record.scopes] };
  }

  async revoke(clientId: string, reason?: unknown): Promise<BridgeClientGrantView> {
    let normalizedId: string;
    try {
      normalizedId = normalizeBridgeClientId(clientId);
    } catch (error) {
      const detail = error instanceof BridgePairingInputError ? error.message : 'Invalid Bridge client id.';
      throw new BridgePairingError('invalid', detail);
    }
    if (reason !== undefined && typeof reason !== 'string') {
      throw new BridgePairingError('invalid', 'Revoke reason must be text.');
    }

    const record = this.grants.get(normalizedId);
    if (!record) {
      throw new BridgePairingError('not_found', 'Bridge client grant was not found.');
    }

    if (record.state !== 'revoked') {
      record.state = 'revoked';
      record.revokedAt = new Date(this.now()).toISOString();
      if (typeof reason === 'string') {
        const sanitized = reason.replace(CONTROL_CHAR_PATTERN, '').trim().slice(0, MAX_REVOKE_REASON_LENGTH);
        if (sanitized) record.revokeReason = sanitized;
      }
      await this.persistNow();
    }

    for (const listener of this.revokedListeners) {
      try {
        listener(normalizedId);
      } catch {
        // Never allow a revocation listener failure to block closing other streams or returning.
      }
    }

    return toGrantView(record);
  }

  onRevoked(listener: (clientId: string) => void): () => void {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
  }

  list(): BridgeClientGrantView[] {
    const nowMs = this.now();
    const views: BridgeClientGrantView[] = [];
    for (const record of this.grants.values()) {
      this.refreshExpiry(record, nowMs);
      views.push(toGrantView(record));
    }
    return views;
  }
}
