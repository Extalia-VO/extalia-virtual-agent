import type { AgentHostMethod } from './agentHost.js';

/**
 * Browser-safe contracts, validators, and fail-closed method scope mapping for
 * Scoped Bridge Pairing & Client Grants (#58 / V2-20).
 *
 * Zero Node built-ins or secret fields: tokens and hashes never appear in views.
 */

export const BRIDGE_CLIENT_SCOPES = ['read', 'events', 'chat', 'approvals', 'admin'] as const;
export type BridgeClientScope = (typeof BRIDGE_CLIENT_SCOPES)[number];

export type BridgeClientGrantState = 'active' | 'revoked' | 'expired';

export interface BridgePairingChallengeView {
  challengeId: string;
  clientName: string;
  requestedScopes: BridgeClientScope[];
  code: string;
  expiresAt: string;
}

export interface BridgeClientGrantView {
  clientId: string;
  name: string;
  scopes: BridgeClientScope[];
  state: BridgeClientGrantState;
  issuedAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokeReason?: string;
}

export class BridgePairingInputError extends Error {
  override name = 'BridgePairingInputError';
}

function invalid(message: string): never {
  throw new BridgePairingInputError(message);
}

const VALID_SCOPES = new Set<string>(BRIDGE_CLIENT_SCOPES);
const CLIENT_ID_PATTERN = /^bc-[0-9a-f]{12}$/;
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

/** Validate a human-readable client name for Bridge pairing (1..80 chars, no control characters). */
export function normalizeBridgeClientName(raw: unknown): string {
  if (typeof raw !== 'string') invalid('Client name must be text.');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 80 || CONTROL_CHAR_PATTERN.test(trimmed)) {
    invalid('Client name must be 1–80 characters without control characters.');
  }
  return trimmed;
}

/** Validate and deduplicate requested Bridge grant scopes in canonical order. */
export function normalizeBridgeClientScopes(raw: unknown): BridgeClientScope[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    invalid('Select at least one Bridge scope.');
  }
  const seen = new Set<BridgeClientScope>();
  for (const item of raw) {
    if (typeof item !== 'string' || !VALID_SCOPES.has(item)) {
      invalid(`Unsupported Bridge scope: ${String(item)}.`);
    }
    seen.add(item as BridgeClientScope);
  }
  return BRIDGE_CLIENT_SCOPES.filter(scope => seen.has(scope));
}

/** Validate a Bridge client grant identifier (`bc-<12 hex>`). */
export function normalizeBridgeClientId(raw: unknown): string {
  return typeof raw === 'string' && CLIENT_ID_PATTERN.test(raw)
    ? raw
    : invalid('Invalid Bridge client id.');
}

const READ_METHODS = new Set<string>([
  'getState',
  'getStateSummary',
  'getProfile',
  'sessionEvents',
  'listFiles',
  'readFile',
  'gitStatus',
  'gitDiff',
  'gitRepositories',
  'listApprovals',
  'commandSandboxStatus',
  'listWorkerLeases',
  'listSchedules',
  'listScheduleRuns',
  'scheduleRunDetail',
  'previewScheduleNextRuns',
  'gatewayOverview',
  'gatewayDiagnostics',
  'listWorkspaceReports',
  'listSessionSystemReports',
  'listWorktrees',
  'worktreeStatus',
  'worktreeDiff',
  'worktreeOrphans',
  'integrationProposals',
  'nativeStatus',
  'modelChoices',
  'teamModelChoices',
  'getSessionTeam',
  'runtimes',
  'listNativeMissions',
  'nativeMissionRun',
  'sessionBrowserGroups',
  'sessionBrowserSessions',
  'knowledgeStatus',
  'knowledgeNode',
  'knowledgeLinks',
  'knowledgeBacklinks',
  'searchKnowledge',
  'knowledgeGraph',
  'knowledgeOverview',
  'listVaultProfiles',
  'listOperatingProfiles',
  'workspaceSkills',
  'skillRegistry',
  'skillRegistryPage',
  'builtinSkills',
  'characterAppearances',
  'agentAppConnections',
  'hookIngest',
  'importLocations',
  'librarySession',
  'learningSchedule',
  'promptQueueStatus',
  'promptSuggestions',
  'sessionContinuity',
  'readContinuity',
  'handoverHarnesses',
  'nativeMemoryList',
  'nativeMemoryRead',
  'attachmentPreview',
  'modelSelectionGuide',
  'hermesModels',
  'observationSession',
  'observedWorkspaceLink',
  'observedUserInputStatus',
  'observedCodexStatus',
  'observedCodexQueueStatus',
  'observedCodexNativeQueueStatus',
  'observedNativeQueueStatus',
  'observedCodexPermissionStatus',
  'observedReplyStatus',
  'observedControlStatus',
  'observedInboxStatus',
  'observedCliResumeStatus',
  'observedMemorySearch',
  'observedMemoryRead',
  'listManualObservedInboxes',
  'observedHermesStatus',
  'checkFolder',
  'browseDirectories',
]);

const CHAT_METHODS = new Set<string>([
  'createSession',
  'sendPrompt',
  'cancel',
  'setSessionOptions',
  'uploadAttachment',
  'removeAttachment',
  'renameSession',
  'changePromptQueue',
  'requestPromptSuggestions',
  'continueSession',
]);

const APPROVAL_METHODS = new Set<string>([
  'resolveApproval',
  'revokeApproval',
  'reconcileWorkerLease',
  'reviewUnknownScheduleRun',
]);

/**
 * Returns the minimum Bridge scope required to invoke `method`.
 * Any unclassified or mutating administration method defaults fail-closed to `'admin'`.
 */
export function requiredBridgeScopeForMethod(method: AgentHostMethod): BridgeClientScope {
  if (READ_METHODS.has(method)) return 'read';
  if (CHAT_METHODS.has(method)) return 'chat';
  if (APPROVAL_METHODS.has(method)) return 'approvals';
  return 'admin';
}

/** True when `granted` satisfies `required` (`'admin'` supersedes all scopes). */
export function hasBridgeScope(
  granted: readonly BridgeClientScope[],
  required: BridgeClientScope,
): boolean {
  return granted.includes('admin') || granted.includes(required);
}
