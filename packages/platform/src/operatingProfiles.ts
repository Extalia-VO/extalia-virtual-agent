import { assertNoCredentialFields, assertOperatingProfileBytes, OPERATING_PROFILE_LIMITS, readAgentPersona, readOperatingProfileDefaults, type AgentPersona, type OperatingProfileDefaults, type OperatingProfileOverrides } from '@extalia/core';
export type { AgentPersona, OperatingProfile, OperatingProfileDefaults, OperatingProfileOverrides, SessionOperatingProfile } from '@extalia/core';
export interface OperatingProfileInput { id?: string; expectedRevision?: number; createRequestId?: string; name: string; purpose?: string; personality?: string; defaults: OperatingProfileDefaults }
export interface WorkspaceOperatingProfileSelection { profileId: string | null; overrides?: OperatingProfileOverrides }
export interface SessionOperatingProfileInput { lead?: AgentPersona | null }
export const OPERATING_PROFILE_HOST_METHODS = ['listOperatingProfiles', 'saveOperatingProfile', 'deleteOperatingProfile', 'setWorkspaceOperatingProfile', 'getSessionOperatingProfile', 'saveSessionOperatingProfile'] as const;
function record(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid operating profile.'); return raw as Record<string, unknown>; }
function keys(value: Record<string, unknown>, allowed: readonly string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown operating profile fields.'); }
function id(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 200 || /\p{Cc}/u.test(value) || value.trim() !== value) throw new Error('Choose an operating profile.'); return value; }
export function normalizeOperatingProfileInput(raw: unknown): OperatingProfileInput {
  assertOperatingProfileBytes(raw); assertNoCredentialFields(raw);
  const value = record(raw); keys(value, ['id', 'expectedRevision', 'createRequestId', 'name', 'purpose', 'personality', 'defaults']);
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || /\p{Cc}/u.test(value.name)) throw new Error('Enter a profile name of up to 120 characters.');
  if (value.id !== undefined && (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1)) throw new Error('Refresh this profile before saving.');
  if (value.id === undefined && value.expectedRevision !== undefined) throw new Error('New profiles do not have an existing revision.');
  if (value.createRequestId !== undefined && (value.id !== undefined || typeof value.createRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.createRequestId))) throw new Error('Use a valid creation request id for a new profile only.');
  const text = (key: 'purpose' | 'personality') => { if (value[key] === undefined) return {}; if (typeof value[key] !== 'string' || value[key].length > OPERATING_PROFILE_LIMITS[key]) throw new Error(`Invalid ${key}.`); return { [key]: value[key].trim() }; };
  return { ...(value.id !== undefined ? { id: id(value.id), expectedRevision: value.expectedRevision as number } : {}), ...(value.createRequestId !== undefined ? { createRequestId: value.createRequestId as string } : {}), name: value.name.trim(), ...text('purpose'), ...text('personality'), defaults: readOperatingProfileDefaults(value.defaults) };
}
export function normalizeWorkspaceOperatingProfile(raw: unknown): WorkspaceOperatingProfileSelection {
  assertOperatingProfileBytes(raw); assertNoCredentialFields(raw);
  const value = record(raw); keys(value, ['profileId', 'overrides']);
  if (value.profileId === null && value.overrides !== undefined && Object.keys(record(value.overrides)).length) throw new Error('Choose a profile before overriding its defaults.');
  return { profileId: value.profileId === null ? null : id(value.profileId), ...(value.overrides !== undefined ? { overrides: readOperatingProfileDefaults(value.overrides, true) } : {}) };
}
export function normalizeSessionOperatingProfileInput(raw: unknown): SessionOperatingProfileInput {
  assertOperatingProfileBytes(raw); assertNoCredentialFields(raw);
  const value = record(raw); keys(value, ['lead']);
  return value.lead === undefined ? {} : { lead: value.lead === null ? null : readAgentPersona(value.lead) };
}
