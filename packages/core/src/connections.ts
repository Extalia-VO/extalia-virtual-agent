import { assertNoCredentialFields } from './privacy.js';
import { decode, entityId, object, oneOf, optionalText, text, timestamp, type DecodeResult } from './validation.js';

/**
 * Connections tell the Extalia Native runtime how to reach a model: a provider
 * or router endpoint, a model, and where the credential lives. The credential
 * itself is never part of a connection; only a reference to the OS credential
 * store or the name of an environment variable is.
 */

/** Wire format spoken by the endpoint. */
export type ProviderApi = 'openai-chat' | 'anthropic-messages';
export const PROVIDER_APIS: readonly ProviderApi[] = ['openai-chat', 'anthropic-messages'];

export type ProviderPresetId = 'openai' | 'anthropic' | 'openrouter' | '9router' | 'omniroute' | 'ollama' | 'custom';

/**
 * Who provides memory or skills for a connection:
 * - `extalia`: Extalia's own memory/skills are given to the agent;
 * - `provider`: the provider or router manages them (for example OmniRoute), Extalia stays out;
 * - `off`: neither.
 */
export type FeatureOwner = 'extalia' | 'provider' | 'off';
export const FEATURE_OWNERS: readonly FeatureOwner[] = ['extalia', 'provider', 'off'];

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Task tiers for orchestration: workers use the tier's model; an empty tier uses the connection's model. */
export type TaskTier = 'complex' | 'standard' | 'quick';
export const TASK_TIERS: readonly TaskTier[] = ['complex', 'standard', 'quick'];

export interface Orchestration {
  /** Let the agent delegate bounded, read-only work to worker agents. On by default. */
  enabled: boolean;
  /** Most delegations per turn. */
  maxDelegations: number;
  tiers: Partial<Record<TaskTier, string>>;
}

export const DEFAULT_MAX_DELEGATIONS = 3;

export interface ProviderPreset {
  id: ProviderPresetId;
  label: string;
  api: ProviderApi;
  /** Default endpoint. For `anthropic-messages` it excludes `/v1`; for `openai-chat` it includes it. */
  baseUrl: string;
  apiKey: 'required' | 'optional' | 'none';
  /** Suggested model; the connection test lists the models the endpoint offers. */
  model: string;
  /** The provider can manage memory and skills itself, so `provider` is a valid owner. */
  nativeMemory: boolean;
  nativeSkills: boolean;
  defaults: { memory: FeatureOwner; skills: FeatureOwner; effort?: Effort };
  /** Suggested tier models; empty means "use the connection's model". */
  tiers: Partial<Record<TaskTier, string>>;
  /** A local router running on this machine. */
  local: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', api: 'openai-chat', baseUrl: 'https://api.openai.com/v1', apiKey: 'required', model: '', nativeMemory: false, nativeSkills: false, defaults: { memory: 'extalia', skills: 'extalia' }, tiers: { complex: 'gpt-6.1-sol', standard: 'gpt-6.1-sol', quick: 'gpt-6-luna' }, local: false },
  { id: 'anthropic', label: 'Anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', apiKey: 'required', model: 'claude-opus-5-5', nativeMemory: false, nativeSkills: false, defaults: { memory: 'extalia', skills: 'extalia', effort: 'high' }, tiers: { complex: 'claude-opus-5-5', standard: 'claude-sonnet-5-5', quick: 'claude-haiku-4-5' }, local: false },
  { id: 'openrouter', label: 'OpenRouter', api: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'required', model: '', nativeMemory: false, nativeSkills: false, defaults: { memory: 'extalia', skills: 'extalia' }, tiers: {}, local: false },
  { id: '9router', label: '9Router', api: 'openai-chat', baseUrl: 'http://localhost:20128/v1', apiKey: 'required', model: '', nativeMemory: false, nativeSkills: false, defaults: { memory: 'extalia', skills: 'extalia' }, tiers: {}, local: true },
  { id: 'omniroute', label: 'OmniRoute', api: 'openai-chat', baseUrl: 'http://localhost:20128/v1', apiKey: 'optional', model: 'auto', nativeMemory: true, nativeSkills: true, defaults: { memory: 'provider', skills: 'provider' }, tiers: {}, local: true },
  { id: 'ollama', label: 'Ollama', api: 'openai-chat', baseUrl: 'http://localhost:11434/v1', apiKey: 'none', model: '', nativeMemory: false, nativeSkills: false, defaults: { memory: 'extalia', skills: 'extalia' }, tiers: {}, local: true },
  { id: 'custom', label: 'Custom endpoint', api: 'openai-chat', baseUrl: '', apiKey: 'optional', model: '', nativeMemory: false, nativeSkills: false, defaults: { memory: 'extalia', skills: 'extalia' }, tiers: {}, local: false },
];

export function presetById(id: ProviderPresetId): ProviderPreset {
  return PROVIDER_PRESETS.find(preset => preset.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]!;
}

/** Where a credential comes from. The secret itself is never stored in a connection. */
export type CredentialSource =
  | { kind: 'none' }
  | { kind: 'stored'; ref: string }
  | { kind: 'env'; variable: string };

export interface Connection {
  id: string;
  name: string;
  preset: ProviderPresetId;
  api: ProviderApi;
  baseUrl: string;
  model: string;
  credential: CredentialSource;
  features: { memory: FeatureOwner; skills: FeatureOwner };
  /** Reasoning effort for `anthropic-messages` endpoints that support it. */
  effort?: Effort;
  orchestration: Orchestration;
  createdAt: string;
  updatedAt: string;
}

// WHATWG URL exists in every JavaScript runtime Extalia targets; core avoids DOM/Node type libraries.
declare const URL: new (input: string) => { protocol: string; username: string; password: string; search: string; hash: string };

export const ENV_VARIABLE_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Endpoint URLs: http(s), no embedded credentials, query or fragment. */
export function checkEndpoint(value: unknown, field = 'baseUrl'): string {
  const raw = text(value, field, { singleLine: true, max: 2048 }).trim().replace(/\/+$/, '');
  let url: InstanceType<typeof URL>;
  try { url = new URL(raw); } catch { throw new Error(`${field}: expected a URL such as https://api.example.com/v1.`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${field}: use http or https.`);
  if (url.username || url.password) throw new Error(`${field}: credentials do not belong in the URL.`);
  if (url.search || url.hash) throw new Error(`${field}: remove the query string or fragment.`);
  return raw;
}

function decodeCredential(raw: unknown): CredentialSource {
  const value = object(raw, 'credential');
  const kind = oneOf(value.kind, ['none', 'stored', 'env'] as const, 'credential.kind');
  if (kind === 'none') return { kind };
  if (kind === 'stored') return { kind, ref: entityId(value.ref, 'credential.ref') };
  const variable = text(value.variable, 'credential.variable', { singleLine: true, max: 128 });
  if (!ENV_VARIABLE_PATTERN.test(variable)) throw new Error('credential.variable: use an environment variable name such as OPENAI_API_KEY.');
  return { kind, variable };
}

export function defaultOrchestration(preset: ProviderPresetId): Orchestration {
  return { enabled: true, maxDelegations: DEFAULT_MAX_DELEGATIONS, tiers: { ...presetById(preset).tiers } };
}

/** Orchestration is optional in stored data; connections saved before it existed get it enabled. */
function decodeOrchestration(raw: unknown): Orchestration {
  if (raw === undefined) return { enabled: true, maxDelegations: DEFAULT_MAX_DELEGATIONS, tiers: {} };
  const value = object(raw, 'orchestration');
  if (typeof value.enabled !== 'boolean') throw new Error('orchestration.enabled: expected true or false.');
  const max = value.maxDelegations;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0 || max > 20) throw new Error('orchestration.maxDelegations: expected a whole number from 0 to 20.');
  const tiers: Partial<Record<TaskTier, string>> = {};
  if (value.tiers !== undefined) {
    const raw = object(value.tiers, 'orchestration.tiers');
    for (const tier of TASK_TIERS) {
      const model = optionalText(raw[tier], `orchestration.tiers.${tier}`, { singleLine: true, max: 200, allowEmpty: true })?.trim();
      if (model) tiers[tier] = model;
    }
  }
  return { enabled: value.enabled, maxDelegations: max, tiers };
}

/** The model a tier uses: its own, or the connection's main model. */
export function tierModel(connection: Pick<Connection, 'model' | 'orchestration'>, tier: TaskTier): string {
  return connection.orchestration.tiers[tier] || connection.model;
}

export function decodeConnection(raw: unknown): DecodeResult<Connection> {
  return decode(() => {
    assertNoCredentialFields(raw);
    const value = object(raw, 'connection');
    const preset = presetById(oneOf(value.preset, PROVIDER_PRESETS.map(item => item.id), 'preset'));
    const features = object(value.features, 'features');
    const memory = oneOf(features.memory, FEATURE_OWNERS, 'features.memory');
    const skills = oneOf(features.skills, FEATURE_OWNERS, 'features.skills');
    if (memory === 'provider' && !preset.nativeMemory) throw new Error(`features.memory: ${preset.label} does not manage memory itself.`);
    if (skills === 'provider' && !preset.nativeSkills) throw new Error(`features.skills: ${preset.label} does not manage skills itself.`);
    const createdAt = timestamp(value.createdAt, 'createdAt'), updatedAt = timestamp(value.updatedAt, 'updatedAt');
    const connection: Connection = {
      id: entityId(value.id, 'id'),
      name: text(value.name, 'name', { singleLine: true, max: 120 }).trim(),
      preset: preset.id,
      api: oneOf(value.api, PROVIDER_APIS, 'api'),
      baseUrl: checkEndpoint(value.baseUrl),
      model: text(value.model, 'model', { singleLine: true, max: 200 }).trim(),
      credential: decodeCredential(value.credential),
      features: { memory, skills },
      orchestration: decodeOrchestration(value.orchestration),
      createdAt,
      updatedAt,
    };
    const effort = optionalText(value.effort, 'effort');
    if (effort !== undefined) connection.effort = oneOf(effort, EFFORTS, 'effort');
    return connection;
  });
}

/** What the Extalia Native runtime should do for a connection. */
export interface ResolvedFeatures {
  /** Give the agent Extalia's memory tools and notes. */
  extaliaMemory: boolean;
  /** Give the agent Extalia's skills. */
  extaliaSkills: boolean;
  /** Ask the provider not to inject its own memory, so the two never overlap. */
  suppressProviderMemory: boolean;
}

export function resolveFeatures(connection: Pick<Connection, 'preset' | 'features'>): ResolvedFeatures {
  const preset = presetById(connection.preset);
  const extaliaMemory = connection.features.memory === 'extalia';
  return {
    extaliaMemory,
    extaliaSkills: connection.features.skills === 'extalia',
    suppressProviderMemory: extaliaMemory && preset.nativeMemory,
  };
}

/** Extra request headers a preset needs for the resolved features. */
export function providerHeaders(connection: Pick<Connection, 'preset' | 'features'>): Record<string, string> {
  const { suppressProviderMemory } = resolveFeatures(connection);
  // OmniRoute documents this per-request opt-out from its own memory injection.
  return suppressProviderMemory && connection.preset === 'omniroute' ? { 'x-omniroute-no-memory': 'true' } : {};
}
