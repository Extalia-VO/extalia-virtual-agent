/** Reusable Native operating defaults; never a storage, credential or workspace grant. */
import { EFFORTS, type Effort } from './connections.js';
import { assertNoCredentialFields } from './privacy.js';
import { decodeAgentTeam, type AgentTeam } from './teams.js';
import { decode, entityId, object, oneOf, text, timestamp, type DecodeResult } from './validation.js';

export interface AgentPersona { role?: string; task?: string; soul?: string }
export interface OperatingProfileDefaults {
  connectionId?: string; model?: string; effort?: Effort;
  lead?: AgentPersona | null; team?: AgentTeam | null;
}
export interface OperatingProfileOverrides extends OperatingProfileDefaults { purpose?: string; personality?: string }
export interface OperatingProfile {
  id: string; name: string; revision: number; createdAt: string; updatedAt: string;
  purpose?: string; personality?: string; defaults: OperatingProfileDefaults;
}
export interface SessionOperatingProfile {
  /** Source metadata, all present or all absent for individually configured sessions. */
  id?: string; name?: string; revision?: number;
  purpose?: string; personality?: string; lead?: AgentPersona;
}
export const OPERATING_PROFILE_LIMITS = { profiles: 32, profileBytes: 65_536, storeBytes: 524_288, purpose: 4000, personality: 4000, persona: 1000 } as const;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unknown operating profile fields.');
}
function optionalText(value: Record<string, unknown>, key: string, max: number) {
  return value[key] === undefined ? {} : { [key]: text(value[key], key, { allowEmpty: true, max }).trim() };
}
export function readAgentPersona(raw: unknown): AgentPersona {
  assertOperatingProfileBytes(raw);
  const value = object(raw, 'persona'); keys(value, ['role', 'task', 'soul']);
  return { ...optionalText(value, 'role', OPERATING_PROFILE_LIMITS.persona), ...optionalText(value, 'task', OPERATING_PROFILE_LIMITS.persona), ...optionalText(value, 'soul', OPERATING_PROFILE_LIMITS.persona) };
}
export function readOperatingProfileDefaults(raw: unknown, overrides = false): OperatingProfileOverrides {
  assertOperatingProfileBytes(raw);
  const value = object(raw, 'defaults');
  keys(value, ['connectionId', 'model', 'effort', 'lead', 'team', ...(overrides ? ['purpose', 'personality'] : [])]);
  const result: OperatingProfileOverrides = {};
  if (value.connectionId !== undefined) result.connectionId = entityId(value.connectionId, 'connectionId');
  if (value.model !== undefined) {
    if (typeof value.model !== 'string' || !MODEL.test(value.model)) throw new Error('Choose a valid model id.');
    result.model = value.model;
  }
  if (value.effort !== undefined) result.effort = oneOf(value.effort, EFFORTS, 'effort');
  if (value.lead !== undefined) result.lead = value.lead === null ? null : readAgentPersona(value.lead);
  if (value.team !== undefined) {
    if (value.team === null) result.team = null;
    else { const decoded = decodeAgentTeam(value.team); if (!decoded.ok) throw new Error(decoded.errors.join(' ')); result.team = decoded.value; }
  }
  if (overrides) Object.assign(result, optionalText(value, 'purpose', OPERATING_PROFILE_LIMITS.purpose), optionalText(value, 'personality', OPERATING_PROFILE_LIMITS.personality));
  return result;
}
export function assertOperatingProfileBytes(value: unknown): void {
  // JSON emits unpaired surrogates as ASCII escapes; scalar iteration counts the
  // serialized UTF-8 bytes without requiring DOM or Node globals in the pure core.
  let bytes = 0;
  for (const character of JSON.stringify(value) ?? '') {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > OPERATING_PROFILE_LIMITS.profileBytes) throw new Error('This operating profile is too large. Keep it under 64 KiB.');
  }
}
export function decodeOperatingProfile(raw: unknown): DecodeResult<OperatingProfile> {
  return decode(() => {
    assertOperatingProfileBytes(raw); assertNoCredentialFields(raw);
    const value = object(raw, 'operating profile'); keys(value, ['id', 'name', 'revision', 'createdAt', 'updatedAt', 'purpose', 'personality', 'defaults']);
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error('Invalid operating profile revision.');
    const createdAt = timestamp(value.createdAt, 'createdAt'), updatedAt = timestamp(value.updatedAt, 'updatedAt');
    if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error('Invalid profile timestamps.');
    return { id: entityId(value.id, 'id'), name: text(value.name, 'name', { singleLine: true, max: 120 }).trim(), revision: value.revision as number, createdAt, updatedAt,
      ...optionalText(value, 'purpose', OPERATING_PROFILE_LIMITS.purpose), ...optionalText(value, 'personality', OPERATING_PROFILE_LIMITS.personality), defaults: readOperatingProfileDefaults(value.defaults) };
  });
}
export function decodeSessionOperatingProfile(raw: unknown): DecodeResult<SessionOperatingProfile> {
  return decode(() => {
    assertOperatingProfileBytes(raw); assertNoCredentialFields(raw);
    const value = object(raw, 'session operating profile'); keys(value, ['id', 'name', 'revision', 'purpose', 'personality', 'lead']);
    const result: SessionOperatingProfile = { ...optionalText(value, 'purpose', OPERATING_PROFILE_LIMITS.purpose), ...optionalText(value, 'personality', OPERATING_PROFILE_LIMITS.personality) };
    if (['id', 'name', 'revision'].some(key => value[key] !== undefined)) {
      result.id = entityId(value.id, 'id'); result.name = text(value.name, 'name', { singleLine: true, max: 120 });
      if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error('Invalid source profile revision.');
      result.revision = value.revision as number;
    }
    if (value.lead !== undefined) result.lead = readAgentPersona(value.lead);
    return result;
  });
}
/** Clone the validated data model without requiring a platform clone API. */
function cloneDefaults(defaults: OperatingProfileOverrides): OperatingProfileOverrides {
  const team = defaults.team;
  return { ...defaults,
    ...(defaults.lead ? { lead: { ...defaults.lead } } : {}),
    ...(team ? { team: { ...team,
      allowedModels: [...team.allowedModels],
      members: team.members.map(member => ({ ...member, models: [...member.models],
        ...(member.scope ? { scope: [...member.scope] } : {}), ...(member.forbidden ? { forbidden: [...member.forbidden] } : {}) })),
      ...(team.connections ? { connections: team.connections.map(grant => ({ ...grant, allowedModels: [...grant.allowedModels] })) } : {}),
      ...(team.rules ? { rules: [...team.rules] } : {}),
      ...(team.goalDocument ? { goalDocument: { ...team.goalDocument } } : {}),
    } } : {}),
  };
}
/** One pure inheritance resolver. Empty persona fields explicitly clear inherited text. */
export function resolveOperatingProfile(profile: OperatingProfile | undefined, overrides: OperatingProfileOverrides = {}) {
  const defaults = { ...profile?.defaults, ...overrides };
  if (overrides.lead !== null && profile?.defaults.lead && overrides.lead) defaults.lead = { ...profile.defaults.lead, ...overrides.lead };
  const snapshot: SessionOperatingProfile = {
    ...(profile ? { id: profile.id, name: profile.name, revision: profile.revision } : {}),
    ...(overrides.purpose !== undefined || profile?.purpose !== undefined ? { purpose: overrides.purpose ?? profile?.purpose } : {}),
    ...(overrides.personality !== undefined || profile?.personality !== undefined ? { personality: overrides.personality ?? profile?.personality } : {}),
    ...(defaults.lead ? { lead: { ...defaults.lead } } : {}),
  };
  return { defaults: cloneDefaults(defaults), snapshot };
}
