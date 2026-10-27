import { INTEGRATION_GATE_LIMITS as GATE_LIMITS } from '@extalia/core';

/**
 * Worktrees of write-capable mission workers and their integration queue (ADR 0028), as the user
 * sees them through `AgentHostApi`. These are user actions only: they are never offered to agents
 * as tools, and every input from the renderer is validated here before it reaches the host.
 */

export interface WorktreeOwnerView { missionId: string; taskId: string; agentId?: string }

export interface WorktreeView {
  id: string;
  /** The user's repository checkout the worktree was created from. */
  repository: string;
  /** The workspace folder relative to the repository root (`''` at the root). */
  prefix: string;
  /** The worktree folder under the Extalia data folder. */
  path: string;
  branch: string;
  baseCommit: string;
  /** Branch the base came from; the default integration target. */
  baseBranch?: string;
  owner: WorktreeOwnerView;
  /** `active` while its task may write; `released` once the task ended and its changes were committed. */
  state: 'active' | 'released';
  head?: string;
  /** Merge commit that integrated this worktree into its target. */
  integratedAs?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeStatusView {
  id: string;
  head: string;
  baseCommit: string;
  dirty: boolean;
  changedPaths: number;
  ahead: number;
  behind: number;
  targetBranch?: string;
  merged: boolean;
  /** Send this back to discard unmerged work; any change since it was read invalidates it. */
  fingerprint: string;
}

export interface WorktreeDiffFile { path: string; added?: number; deleted?: number; binary?: true }
export interface WorktreeDiffView { from: string; to: string; files: WorktreeDiffFile[]; truncated: boolean; digest: string }

export type WorktreeOrphanReason = 'owner-ended' | 'missing' | 'unregistered';
export interface WorktreeOrphanView {
  reason: WorktreeOrphanReason;
  path: string;
  id?: string;
  branch?: string;
  owner?: WorktreeOwnerView;
  dirty?: boolean;
  unmerged?: boolean;
}

/** The test gate: a command the user chose (never a model), run in the disposable integration worktree. */
export interface IntegrationGateInput { command: string; timeoutSeconds?: number }

export interface IntegrationGateResult {
  command: string;
  exitCode: number;
  ok: boolean;
  durationMs: number;
  /** Bounded (16,000 characters), redacted output. */
  log: string;
  logDigest: string;
  observedAt: string;
  basis: 'verified_by_extalia';
}

export type IntegrationStatus = 'ready' | 'conflict' | 'gate_failed' | 'gate_missing' | 'empty' | 'applied' | 'stale';
export const INTEGRATION_STATUSES: readonly IntegrationStatus[] = ['ready', 'conflict', 'gate_failed', 'gate_missing', 'empty', 'applied', 'stale'];

/**
 * Where a proposal's gate came from: the request (typed in the Changes panel) or the workspace
 * setting the host used because the request named none. Absent on proposals without a gate and
 * on records from older hosts.
 */
export type IntegrationGateSource = 'request' | 'workspace';

export interface IntegrationProposalView {
  id: string;
  worktreeId: string;
  repository: string;
  workerBranch: string;
  workerHead: string;
  targetBranch: string;
  targetCommit: string;
  mergeCommit?: string;
  status: IntegrationStatus;
  conflicts?: string[];
  files: WorktreeDiffFile[];
  /** What the user approves when applying: SHA-256 over the exact change `targetCommit → mergeCommit`. */
  diffDigest?: string;
  gate?: IntegrationGateResult;
  gateSource?: IntegrationGateSource;
  createdAt: string;
  appliedAt?: string;
}

/** Without `gate` the host uses the workspace's `integrationGate`; without either the proposal is `gate_missing`. */
export interface IntegrationRequest { targetBranch?: string; gate?: IntegrationGateInput }
export interface IntegrationApproval { diffDigest: string }
export interface WorktreeDiscardConfirmation { fingerprint: string }

/** Shared with the stored workspace setting (`@extalia/core` `decodeIntegrationGate`). */
export const INTEGRATION_GATE_LIMITS = GATE_LIMITS;

const WORKTREE_ID = /^w-[0-9a-f]{12}$/;
const PROPOSAL_ID = /^i-[0-9a-f]{12}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

class WorktreeInputError extends Error { override name = 'WorktreeInputError'; }
const invalid = (message: string): never => { throw new WorktreeInputError(message); };

/** A plain data object with only the listed own, enumerable value keys. */
function record(value: unknown, allowed: readonly string[], message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid(message);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid(message);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor?.enumerable || !('value' in descriptor)) return invalid(message);
  }
  return value as Record<string, unknown>;
}

export function normalizeWorktreeId(raw: unknown): string {
  return typeof raw === 'string' && WORKTREE_ID.test(raw) ? raw : invalid('Invalid worktree id.');
}

export function normalizeProposalId(raw: unknown): string {
  return typeof raw === 'string' && PROPOSAL_ID.test(raw) ? raw : invalid('Invalid integration proposal id.');
}

/** `git check-ref-format --branch` rules for a local branch name, bounded to 200 characters. */
export function isIntegrationBranch(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 200 || value === '@' || value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if ([...value].some(character => character.charCodeAt(0) <= 0x20 || character.charCodeAt(0) === 0x7f || '~^:?*[\\'.includes(character)) || /\.\.|@\{|\/\//.test(value)) return false;
  return value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

export function normalizeDiscardConfirmation(raw: unknown): WorktreeDiscardConfirmation | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = record(raw, ['fingerprint'], 'Invalid discard confirmation.');
  return typeof value.fingerprint === 'string' && SHA256.test(value.fingerprint) ? { fingerprint: value.fingerprint } : invalid('Invalid discard confirmation.');
}

/**
 * A test gate from the renderer (a proposal request or the workspace setting): a plain object with
 * a non-empty command of up to 4,000 characters (trimmed, no NUL) and an optional whole-second
 * timeout of 1–1800 s. Nothing else is accepted.
 */
export function normalizeIntegrationGate(raw: unknown): IntegrationGateInput {
  const gate = record(raw, ['command', 'timeoutSeconds'], 'Invalid test gate.');
  const { maxCommand, minTimeoutSeconds, maxTimeoutSeconds } = INTEGRATION_GATE_LIMITS;
  if (typeof gate.command !== 'string' || !gate.command.trim() || gate.command.length > maxCommand || gate.command.includes('\0')) invalid('The test gate needs a command of up to 4,000 characters.');
  const timeout = gate.timeoutSeconds;
  if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < minTimeoutSeconds || timeout > maxTimeoutSeconds)) invalid('The test gate timeout must be 1–1800 seconds.');
  return { command: (gate.command as string).trim(), ...(timeout !== undefined ? { timeoutSeconds: timeout as number } : {}) };
}

export function normalizeIntegrationRequest(raw: unknown): IntegrationRequest {
  if (raw === undefined || raw === null) return {};
  const value = record(raw, ['targetBranch', 'gate'], 'Invalid integration request.');
  const request: IntegrationRequest = {};
  if (value.targetBranch !== undefined) {
    if (!isIntegrationBranch(value.targetBranch)) invalid('The target branch name is not a valid local branch name.');
    request.targetBranch = value.targetBranch as string;
  }
  if (value.gate !== undefined) request.gate = normalizeIntegrationGate(value.gate);
  return request;
}

export function normalizeIntegrationApproval(raw: unknown): IntegrationApproval {
  const value = record(raw, ['diffDigest'], 'The approval must carry the proposal’s diff digest.');
  return typeof value.diffDigest === 'string' && SHA256.test(value.diffDigest) ? { diffDigest: value.diffDigest } : invalid('The approval must carry the proposal’s diff digest.');
}

/** The `AgentHostApi` worktree methods; all optional (hosts without write-capable workers omit them). */
export const WORKTREE_HOST_METHODS = [
  'listWorktrees', 'worktreeStatus', 'worktreeDiff', 'worktreeOrphans', 'removeWorktree', 'proposeIntegration', 'integrationProposals', 'applyIntegration',
] as const;
