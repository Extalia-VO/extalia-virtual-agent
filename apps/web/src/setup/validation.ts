import {
  DEFAULT_MAX_DELEGATIONS, DEFAULT_PERMISSIONS, ENV_VARIABLE_PATTERN, INTEGRATION_GATE_LIMITS, RUNTIME_MODEL_PATTERN, RUNTIME_PROFILE_PATTERN, TASK_TIERS, defaultOrchestration, presetById,
  workspaceRuntime,
  type Effort, type FeatureOwner, type Orchestration, type ProviderPresetId, type RuntimeId, type TaskTier, type Workspace, type WorkspacePermissions,
} from '@extalia/core';
import type { ConnectionInput, ConnectionView, WorkspaceInput } from '@extalia/platform';
import type { ConnectionErrorKey, WorkspaceErrorKey } from '../i18n';

/**
 * Form state and validation for connections and workspaces, shared by the
 * first-run wizard and Settings. API keys live only in the draft while the
 * user types; nothing here ever receives a stored key back from the host.
 */

export type CredentialMode = 'key' | 'env';

export interface ConnectionDraft {
  id?: string;
  name: string;
  preset: ProviderPresetId;
  baseUrl: string;
  model: string;
  credentialMode: CredentialMode;
  apiKey: string;
  envVariable: string;
  /** The host already stores a key for this connection. */
  hasStoredKey: boolean;
  memory: FeatureOwner;
  skills: FeatureOwner;
  /** Save this connection's sessions on disk. */
  history: boolean;
  effort: Effort;
  orchestration: OrchestrationDraft;
}

/** Orchestration as edited: the limit stays text while typing, empty tiers mean "the main model". */
export interface OrchestrationDraft { enabled: boolean; maxDelegations: string; tiers: Record<TaskTier, string> }

export function orchestrationDraft(value: Partial<Orchestration> | undefined): OrchestrationDraft {
  const tiers = Object.fromEntries(TASK_TIERS.map(tier => [tier, value?.tiers?.[tier] ?? ''])) as Record<TaskTier, string>;
  return { enabled: value?.enabled ?? true, maxDelegations: String(value?.maxDelegations ?? DEFAULT_MAX_DELEGATIONS), tiers };
}

/** Preset tier suggestions, or undefined when the preset has none. */
export function suggestedTiers(preset: ProviderPresetId): Record<TaskTier, string> | undefined {
  const tiers = orchestrationDraft(defaultOrchestration(preset)).tiers;
  return TASK_TIERS.some(tier => tiers[tier]) ? tiers : undefined;
}

const ENV_SUGGESTIONS: Partial<Record<ProviderPresetId, string>> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY' };

export function draftFromPreset(id: ProviderPresetId, previous?: ConnectionDraft): ConnectionDraft {
  const preset = presetById(id);
  const previousLabel = previous ? presetById(previous.preset).label : '';
  // Keep a name the user typed; replace one that was only the old preset's label.
  const name = previous && previous.name.trim() && previous.name !== previousLabel ? previous.name : preset.label;
  return {
    ...(previous?.id ? { id: previous.id } : {}),
    name,
    preset: preset.id,
    baseUrl: preset.baseUrl,
    model: preset.model,
    credentialMode: previous?.credentialMode ?? 'key',
    apiKey: '',
    envVariable: ENV_SUGGESTIONS[preset.id] ?? '',
    hasStoredKey: false,
    memory: preset.defaults.memory,
    skills: preset.defaults.skills,
    history: previous?.history ?? true,
    effort: preset.defaults.effort ?? 'high',
    // Tier models follow the provider; the on/off choice and limit are the user's.
    orchestration: {
      ...orchestrationDraft(defaultOrchestration(preset.id)),
      ...(previous ? { enabled: previous.orchestration.enabled, maxDelegations: previous.orchestration.maxDelegations } : {}),
    },
  };
}

export function draftFromConnection(view: ConnectionView): ConnectionDraft {
  const preset = presetById(view.preset);
  return {
    id: view.id,
    name: view.name,
    preset: view.preset,
    baseUrl: view.baseUrl,
    model: view.model,
    credentialMode: view.credential.kind === 'env' ? 'env' : 'key',
    apiKey: '',
    envVariable: view.credential.kind === 'env' ? view.credential.variable : ENV_SUGGESTIONS[view.preset] ?? '',
    hasStoredKey: view.credential.kind === 'stored',
    memory: view.features.memory,
    skills: view.features.skills,
    history: view.features.history !== false,
    effort: view.effort ?? preset.defaults.effort ?? 'high',
    orchestration: orchestrationDraft(view.orchestration),
  };
}

/** Mirrors the host's endpoint rules so problems show before saving. */
export function checkBaseUrl(value: string): ConnectionErrorKey | undefined {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return 'baseUrlInvalid'; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'baseUrlInvalid';
  if (url.username || url.password) return 'baseUrlCredentials';
  if (url.search || url.hash) return 'baseUrlQuery';
  return undefined;
}

export type ConnectionField = 'name' | 'baseUrl' | 'apiKey' | 'envVariable' | 'model' | 'maxDelegations';

const parseLimit = (value: string): number | undefined => /^\s*\d{1,2}\s*$/.test(value) && Number(value) <= 20 ? Number(value) : undefined;

export function validateConnection(draft: ConnectionDraft): Partial<Record<ConnectionField, ConnectionErrorKey>> {
  const preset = presetById(draft.preset);
  const errors: Partial<Record<ConnectionField, ConnectionErrorKey>> = {};
  if (!draft.name.trim()) errors.name = 'nameRequired';
  const url = checkBaseUrl(draft.baseUrl);
  if (url) errors.baseUrl = url;
  if (preset.apiKey !== 'none') {
    if (draft.credentialMode === 'env') {
      if (!ENV_VARIABLE_PATTERN.test(draft.envVariable.trim())) errors.envVariable = 'envInvalid';
    } else if (preset.apiKey === 'required' && !draft.apiKey.trim() && !draft.hasStoredKey) {
      errors.apiKey = 'apiKeyRequired';
    }
  }
  if (!draft.model.trim()) errors.model = 'modelRequired';
  if (draft.orchestration.enabled && parseLimit(draft.orchestration.maxDelegations) === undefined) errors.maxDelegations = 'maxDelegationsInvalid';
  return errors;
}

export function toConnectionInput(draft: ConnectionDraft): { input: ConnectionInput; secret?: string } {
  const preset = presetById(draft.preset);
  const key = draft.apiKey.trim();
  let credential: ConnectionInput['credential'] = { kind: 'none' };
  if (preset.apiKey !== 'none') {
    if (draft.credentialMode === 'env') credential = { kind: 'env', variable: draft.envVariable.trim() };
    else if (key || draft.hasStoredKey) credential = { kind: 'stored' };
  }
  const owner = (value: FeatureOwner, native: boolean): FeatureOwner => value === 'provider' && !native ? 'extalia' : value;
  const input: ConnectionInput = {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    preset: preset.id,
    api: preset.api,
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
    model: draft.model.trim(),
    credential,
    features: { memory: owner(draft.memory, preset.nativeMemory), skills: owner(draft.skills, preset.nativeSkills), ...(draft.history ? {} : { history: false }) },
    ...(preset.api === 'anthropic-messages' ? { effort: draft.effort } : {}),
    orchestration: {
      enabled: draft.orchestration.enabled,
      maxDelegations: parseLimit(draft.orchestration.maxDelegations) ?? DEFAULT_MAX_DELEGATIONS,
      tiers: Object.fromEntries(TASK_TIERS.map(tier => [tier, draft.orchestration.tiers[tier].trim()]).filter(([, model]) => model)),
    },
  };
  return credential.kind === 'stored' && key ? { input, secret: key } : { input };
}

/** Stands in for the model when testing a connection before the user picked one; the test only lists models. */
export const TEST_MODEL_PLACEHOLDER = 'model-list';

/** Like `toConnectionInput`, but testing a connection never requires a model. */
export function toConnectionTestInput(draft: ConnectionDraft): { input: ConnectionInput; secret?: string } {
  const { input, secret } = toConnectionInput(draft);
  const probe = input.model ? input : { ...input, model: TEST_MODEL_PLACEHOLDER };
  return secret === undefined ? { input: probe } : { input: probe, secret };
}

export interface WorkspaceDraft {
  id?: string;
  name: string;
  /** Path as typed (Bridge) or picked (Desktop). */
  folderInput: string;
  /** The host confirmed this folder; cleared whenever the input changes. */
  folder?: { path: string; name: string };
  connectionId: string;
  permissions: WorkspacePermissions;
  /** Extalia Native needs a connection; Hermes Agent a profile (and optionally a model). */
  runtimeId: RuntimeId;
  hermesProfile: string;
  hermesModel: string;
  /**
   * ADR 0028 integration test gate, as typed (Settings only). `undefined` leaves the stored setting
   * untouched; an empty command removes it.
   */
  gateCommand?: string;
  /** Seconds as typed; empty means the host default (600 s). */
  gateTimeout?: string;
}

export function emptyWorkspaceDraft(connectionId = '', runtimeId: RuntimeId = 'extalia-native'): WorkspaceDraft {
  return { name: '', folderInput: '', connectionId, permissions: { ...DEFAULT_PERMISSIONS }, runtimeId, hermesProfile: 'default', hermesModel: '' };
}

export function draftFromWorkspace(workspace: Workspace): WorkspaceDraft {
  const path = workspace.projectLocation ?? '';
  return {
    id: workspace.id,
    name: workspace.name,
    folderInput: path,
    ...(path ? { folder: { path, name: path.split(/[\\/]/).pop() || path } } : {}),
    connectionId: workspace.providerProfileId ?? '',
    permissions: { ...DEFAULT_PERMISSIONS, ...workspace.permissions },
    runtimeId: workspaceRuntime(workspace),
    hermesProfile: workspace.runtimeProfileId ?? 'default',
    hermesModel: workspace.runtimeModel ?? '',
    gateCommand: workspace.integrationGate?.command ?? '',
    gateTimeout: workspace.integrationGate?.timeoutSeconds !== undefined ? String(workspace.integrationGate.timeoutSeconds) : '',
  };
}

export type WorkspaceField = 'name' | 'folder' | 'connection' | 'profile' | 'model' | 'gate' | 'gateTimeout';

const parseGateTimeout = (value: string): number | undefined => {
  const { minTimeoutSeconds, maxTimeoutSeconds } = INTEGRATION_GATE_LIMITS;
  return /^\s*\d{1,4}\s*$/.test(value) && Number(value) >= minTimeoutSeconds && Number(value) <= maxTimeoutSeconds ? Number(value) : undefined;
};

/** Mirrors the host's rules so problems show before saving. */
export function validateWorkspace(draft: WorkspaceDraft): Partial<Record<WorkspaceField, WorkspaceErrorKey>> {
  const errors: Partial<Record<WorkspaceField, WorkspaceErrorKey>> = {};
  if (!draft.name.trim()) errors.name = 'nameRequired';
  if (!draft.folder) errors.folder = draft.folderInput.trim() ? 'folderUnchecked' : 'folderRequired';
  if (draft.runtimeId === 'hermes') {
    if (!RUNTIME_PROFILE_PATTERN.test(draft.hermesProfile.trim() || 'default')) errors.profile = 'profileInvalid';
    if (draft.hermesModel.trim() && !RUNTIME_MODEL_PATTERN.test(draft.hermesModel.trim())) errors.model = 'modelInvalid';
  } else if (!draft.connectionId) errors.connection = 'connectionRequired';
  // Same rules as the host's `normalizeIntegrationGate`; an empty command means "not configured".
  const command = draft.gateCommand ?? '', timeout = (draft.gateTimeout ?? '').trim();
  if (command.length > INTEGRATION_GATE_LIMITS.maxCommand || command.includes('\0')) errors.gate = 'gateInvalid';
  else if (!command.trim() && timeout) errors.gate = 'gateRequired';
  if (timeout && parseGateTimeout(timeout) === undefined) errors.gateTimeout = 'gateTimeoutInvalid';
  return errors;
}

export function toWorkspaceInput(draft: WorkspaceDraft): WorkspaceInput {
  const common = {
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    projectLocation: draft.folder?.path ?? draft.folderInput.trim(),
  };
  const gate = toIntegrationGate(draft);
  if (draft.runtimeId !== 'hermes') return { ...common, connectionId: draft.connectionId, permissions: { ...draft.permissions }, ...gate };
  const model = draft.hermesModel.trim();
  return { ...common, runtimeId: 'hermes', runtimeProfileId: draft.hermesProfile.trim() || 'default', ...(model ? { runtimeModel: model } : {}), permissions: { ...draft.permissions }, ...gate };
}

/** Nothing when the form never showed the gate (the stored setting stays), `null` to remove it. */
function toIntegrationGate(draft: WorkspaceDraft): Pick<WorkspaceInput, 'integrationGate'> {
  if (draft.gateCommand === undefined) return {};
  const command = draft.gateCommand.trim(), timeoutSeconds = parseGateTimeout(draft.gateTimeout ?? '');
  return { integrationGate: command ? { command, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) } : null };
}

export const isValid = (errors: object) => Object.keys(errors).length === 0;
