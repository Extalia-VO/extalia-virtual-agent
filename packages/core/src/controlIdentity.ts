import { controlIdentityKey, parseControlIdentityMap, parseControlIdentityReference, type ControlEntityKind, type ControlIdentityBinding } from '@extalia/protocol';

export interface ControlIdentityScope { profileId: string; workspaceId: string }
type Resolution = { ok: true; binding: ControlIdentityBinding } | { ok: false; reason: 'invalid-map' | 'foreign-scope' | 'invalid-reference' | 'unmapped' };
const copy = (binding: ControlIdentityBinding): Resolution => ({ ok: true, binding: { ...binding, source: { ...binding.source } } });

/** Resolve only explicit bindings. Successful resolution is not an ownership or permission grant. */
export function resolveControlIdentity(value: unknown, scope: ControlIdentityScope, reference: unknown): Resolution {
  const map = parseControlIdentityMap(value);
  if (!map.ok) return { ok: false, reason: 'invalid-map' };
  if (map.value.profileId !== scope.profileId || map.value.workspaceId !== scope.workspaceId) return { ok: false, reason: 'foreign-scope' };
  const parsed = parseControlIdentityReference(reference);
  if (!parsed.ok) return { ok: false, reason: 'invalid-reference' };
  const entry = map.value.bindings.find(binding => controlIdentityKey(binding) === controlIdentityKey(parsed.value));
  return entry ? copy(entry) : { ok: false, reason: 'unmapped' };
}
/** Reverse lookup returns the complete source namespace, never a guessed legacy alias. */
export function reverseControlIdentity(value: unknown, scope: ControlIdentityScope, kind: ControlEntityKind, canonicalId: string): Resolution {
  const map = parseControlIdentityMap(value);
  if (!map.ok) return { ok: false, reason: 'invalid-map' };
  if (map.value.profileId !== scope.profileId || map.value.workspaceId !== scope.workspaceId) return { ok: false, reason: 'foreign-scope' };
  const entry = map.value.bindings.find(binding => binding.entityKind === kind && binding.canonicalId === canonicalId);
  return entry ? copy(entry) : { ok: false, reason: 'unmapped' };
}
