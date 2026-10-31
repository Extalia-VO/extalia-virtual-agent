import { describe, expect, it } from 'vitest';
import { controlIdentityKey, parseControlIdentityMap, parseControlIdentityReference } from '../src/index.js';
import schema from '../schemas/control-identity-map.schema.json' with { type: 'json' };
import fixtures from './fixtures/control/identity-map.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base = () => clone(fixtures.cases[0]!.value) as unknown as {
  bindings: { source: Record<string, unknown>; canonicalId: string; entityKind: string }[];
};

describe('explicit scoped identity map contract', () => {
  it.each(fixtures.cases)('$name', test => {
    expect(parseControlIdentityMap(test.value).ok).toBe(test.valid);
    expect(validateJsonSchema(schema, test.value)).toBe('schemaGap' in test ? true : test.valid);
  });
  it('checks every required field, rejects unknown nested fields and preserves schema parity', () => {
    const value = base();
    const targets = [value, value.bindings[0]!, value.bindings[0]!.source];
    for (let level = 0; level < targets.length; level++) {
      for (const key of [...Object.keys(targets[level]!), 'unexpected']) {
        for (const mutation of [undefined, null, [], {}, '', false, 1, 'constructor']) {
          const changed = clone(value);
          const target = (level === 0 ? changed : level === 1 ? changed.bindings[0] : changed.bindings[0]!.source) as Record<string, unknown>;
          if (mutation === undefined) delete target[key]; else target[key] = mutation;
          expect(validateJsonSchema(schema, changed)).toBe(parseControlIdentityMap(changed).ok);
        }
      }
    }
  });
  it('bounds entries and UTF-16 identifiers, without trimming original IDs', () => {
    const value = base();
    value.bindings[0]!.source.id = '😀'.repeat(100);
    expect(parseControlIdentityMap(value).ok).toBe(true);
    value.bindings[0]!.source.id += 'x';
    expect(parseControlIdentityMap(value).ok).toBe(false);
    value.bindings = Array.from({ length: 1_001 }, () => value.bindings[0]!);
    expect(parseControlIdentityMap(value).ok).toBe(false);
    expect(validateJsonSchema(schema, value)).toBe(false);
    const reference = { entityKind: 'session', source: { ...base().bindings[0]!.source, id: ' original ' } };
    const parsed = parseControlIdentityReference(reference);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.source.id).toBe(' original ');
      expect(controlIdentityKey(parsed.value)).toContain(' original ');
    }
  });
  it('rejects inherited fields and non-plain objects', () => {
    expect(parseControlIdentityMap(Object.create(base())).ok).toBe(false);
    for (const value of [null, [], new Date(), { entityKind: 'session', source: null }]) {
      expect(parseControlIdentityReference(value).ok).toBe(false);
    }
  });
  it('accepts exactly 1000 unambiguous bindings before refusing the next entry', () => {
    const value = base(), binding = value.bindings[0]!;
    value.bindings = Array.from({ length: 1_000 }, (_, index) => ({
      ...binding, canonicalId: `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
      source: { ...binding.source, id: `legacy-${index}` },
    }));
    expect(parseControlIdentityMap(value).ok).toBe(true);
    expect(validateJsonSchema(schema, value)).toBe(true);
    value.bindings.push({ ...binding });
    expect(parseControlIdentityMap(value).ok).toBe(false);
  });
});
