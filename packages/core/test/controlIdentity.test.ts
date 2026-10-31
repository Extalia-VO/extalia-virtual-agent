import { describe, expect, it } from 'vitest';
import { parseControlIdentityMap, type ControlIdentityMap } from '@extalia/protocol';
import { resolveControlIdentity, reverseControlIdentity } from '../src/controlIdentity.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base = (): ControlIdentityMap => ({
  protocol: 'extalia.control.v1', schemaVersion: 1, kind: 'identity-map',
  profileId: '00000001-1111-4111-8111-111111111111', workspaceId: '00000002-1111-4111-8111-111111111111',
  bindings: [{ entityKind: 'session', canonicalId: '00000003-1111-4111-8111-111111111111',
    source: { family: 'extalia.v0', system: 'extalia', instanceId: 'bridge-a', workspaceId: 'custom-workspace', id: 's_abc123' } }],
});
const reference = (map: ControlIdentityMap) => {
  const { entityKind, source } = map.bindings[0]!;
  return { entityKind, source: { ...source } };
};
const scope = (map: ControlIdentityMap) => ({ profileId: map.profileId, workspaceId: map.workspaceId });

describe('scoped explicit identity resolution', () => {
  it.each(['extalia.v0', 'orchestration.v1', 'external'] as const)('round trips %s without changing the source', family => {
    const input = base();
    input.bindings[0]!.source.family = family;
    if (family === 'external') input.bindings[0]!.source.system = 'custom-adapter';
    if (family === 'orchestration.v1') {
      input.bindings[0]!.source.workspaceId = input.workspaceId;
      input.bindings[0]!.source.id = '00000009-1111-4111-8111-111111111111';
    }
    const parsed = parseControlIdentityMap(input);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const map = parsed.value;
    const before = clone(map);
    for (const binding of map.bindings) {
      const { canonicalId, ...ref } = binding;
      expect(resolveControlIdentity(map, scope(map), ref)).toEqual({ ok: true, binding });
      expect(reverseControlIdentity(map, scope(map), ref.entityKind, canonicalId)).toEqual({ ok: true, binding });
    }
    expect(map).toEqual(before);
  });
  it('denies foreign profile and workspace on both lookup directions', () => {
    const map = base(), ref = reference(map), binding = map.bindings[0]!;
    for (const key of ['profileId', 'workspaceId'] as const) {
      const foreign = { ...scope(map), [key]: 'ffffffff-1111-4111-8111-111111111111' };
      expect(resolveControlIdentity(map, foreign, ref)).toEqual({ ok: false, reason: 'foreign-scope' });
      expect(reverseControlIdentity(map, foreign, binding.entityKind, binding.canonicalId)).toEqual({ ok: false, reason: 'foreign-scope' });
    }
  });
  it('matches the complete namespace, never just an ID or a canonical UUID', () => {
    const map = base(), ref = reference(map);
    for (const key of ['instanceId', 'workspaceId', 'id'] as const) {
      expect(resolveControlIdentity(map, scope(map), { ...ref, source: { ...ref.source, [key]: 'different' } })).toEqual({ ok: false, reason: 'unmapped' });
    }
    expect(resolveControlIdentity(map, scope(map), { ...ref, source: { ...ref.source, family: 'external' } })).toEqual({ ok: false, reason: 'unmapped' });
    const external = { ...ref, source: { ...ref.source, family: 'external', system: 'codex' } };
    expect(resolveControlIdentity(map, scope(map), external)).toEqual({ ok: false, reason: 'unmapped' });
    expect(resolveControlIdentity(map, scope(map), { ...ref, entityKind: 'workspace' })).toEqual({ ok: false, reason: 'unmapped' });
    expect(resolveControlIdentity(map, scope(map), { ...ref, source: { ...ref.source, id: map.bindings[0]!.canonicalId } })).toEqual({ ok: false, reason: 'unmapped' });
    expect(reverseControlIdentity(map, scope(map), 'workspace', map.bindings[0]!.canonicalId)).toEqual({ ok: false, reason: 'unmapped' });
    expect(reverseControlIdentity(map, scope(map), 'session', map.profileId)).toEqual({ ok: false, reason: 'unmapped' });
  });
  it('denies every invalid or ambiguous map before either lookup', () => {
    const map = base();
    const entry = map.bindings[0]!;
    const invalid = [null, [], {}, { ...map, protocol: 'extalia.v0' }, { ...map, schemaVersion: '1' },
      { ...map, bindings: [{ ...entry, canonicalId: 'legacy' }] },
      { ...map, bindings: [entry, { ...entry, canonicalId: map.profileId }] },
      { ...map, bindings: [entry, { ...entry, entityKind: 'workspace' }] }];
    for (const value of invalid) {
      expect(resolveControlIdentity(value, scope(map), reference(map))).toEqual({ ok: false, reason: 'invalid-map' });
      expect(reverseControlIdentity(value, scope(map), 'session', entry.canonicalId)).toEqual({ ok: false, reason: 'invalid-map' });
    }
    expect(resolveControlIdentity(map, scope(map), { ...reference(map), canonicalId: map.bindings[0]!.canonicalId })).toEqual({ ok: false, reason: 'invalid-reference' });
  });
  it('distinguishes external systems and retains whitespace in opaque IDs', () => {
    const map = base();
    map.bindings[0]!.source = { ...map.bindings[0]!.source, family: 'external', system: 'adapter-a', id: ' original ' };
    const ref = reference(map);
    expect(resolveControlIdentity(map, scope(map), ref).ok).toBe(true);
    for (const source of [{ ...ref.source, system: 'adapter-b' }, { ...ref.source, id: 'original' }]) {
      expect(resolveControlIdentity(map, scope(map), { ...ref, source })).toEqual({ ok: false, reason: 'unmapped' });
    }
  });
  it('returns detached bindings and revalidates mutable maps on each lookup', () => {
    const map = base(), ref = reference(map);
    const forward = resolveControlIdentity(map, scope(map), ref);
    const reverse = reverseControlIdentity(map, scope(map), 'session', map.bindings[0]!.canonicalId);
    for (const result of [forward, reverse]) if (result.ok) {
      result.binding.source.id = 'changed'; result.binding.canonicalId = 'changed';
    }
    expect(map.bindings[0]!.source.id).toBe(ref.source.id);
    expect(resolveControlIdentity(map, scope(map), ref).ok).toBe(true);
    map.bindings.push(clone(map.bindings[0]!));
    expect(resolveControlIdentity(map, scope(map), ref)).toEqual({ ok: false, reason: 'invalid-map' });
  });
});
