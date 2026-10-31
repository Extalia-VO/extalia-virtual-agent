/**
 * Additive control-plane discovery contracts (ADR 0036). These describe scoped
 * claims, never grant authority, execute a driver or replace legacy events.
 */
export const CONTROL_PROTOCOL_VERSION = 'extalia.control.v1' as const;
export const CONTROL_SCHEMA_VERSION = 1 as const;
export const CONTROL_ENGINE_IDS = ['native', 'hermes', 'openclaw'] as const;
export const CONTROL_WORKER_IDS = ['codex', 'claude-code', 'opencode', 'kiro', 'google'] as const;
export const CONTROL_CAPABILITY_NAMES = [
  'discover', 'observe', 'createSession', 'sendPrompt', 'streamEvents', 'resume',
  'fork', 'interrupt', 'cancel', 'queuePrompt', 'liveSteer', 'approvalRelay',
  'readArtifacts', 'listSessions', 'usage', 'cost', 'subagents', 'gitDiff',
] as const;
export type ControlEngineId = typeof CONTROL_ENGINE_IDS[number];
export type ControlWorkerAdapterId = typeof CONTROL_WORKER_IDS[number];
export type ControlCapabilityName = typeof CONTROL_CAPABILITY_NAMES[number];
/** Provider identifiers are open adapter IDs; the discriminant prevents aliasing. */
export type ControlSubject =
  | { kind: 'engine'; id: ControlEngineId; adapterVersion: string }
  | { kind: 'worker'; id: ControlWorkerAdapterId; adapterVersion: string }
  | { kind: 'provider'; id: string; adapterVersion: string };
export type ControlIntegrationMode = 'managed' | 'observer' | 'import-only';
export type ControlAuthMethod = 'none' | 'external_official_login' | 'user_api_key'
  | 'user_oauth_authorized' | 'local_model' | 'gateway_scoped' | 'enterprise_adc';
export type ControlInterface = 'sdk' | 'cli' | 'acp' | 'gateway' | 'hook' | 'otel' | 'import' | 'api';
/** References contain no credentials. Receivers must resolve and verify them. */
export interface ControlCapabilityVerification {
  runtimeVersion: string;
  policyRef: string;
  configurationRef: string;
  evidenceRefs: string[];
  checkedAt: string;
}
export type ControlCapability = { reason: string; interface: ControlInterface } & (
  | { state: 'supported'; verification: ControlCapabilityVerification }
  | { state: 'experimental'; verification: ControlCapabilityVerification; optInRequired: true }
  | { state: 'unsupported' | 'disabled_by_policy' | 'unavailable' | 'needs_verification' }
);
export interface ControlCapabilityManifest {
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  schemaVersion: typeof CONTROL_SCHEMA_VERSION;
  profileId: string;
  workspaceId: string;
  subject: ControlSubject;
  mode: ControlIntegrationMode;
  authMethod: ControlAuthMethod;
  /** Detection time, not a TTL or evidence that a connection is still live. */
  detectedAt: string;
  /** Every known capability is explicit. Missing entries never default to support. */
  capabilities: Record<ControlCapabilityName, ControlCapability>;
}
export type ControlManifestParseResult =
  | { ok: true; value: ControlCapabilityManifest }
  | { ok: false; errors: string[] };
