import { describe, expect, it } from 'vitest';
import { parseControlDelegationEnvelope, parseControlTaskSnapshot, parseOrchestration, type ControlDelegationEnvelope } from '../src/index.js';
import schema from '../schemas/control-delegation-envelope.schema.json' with { type: 'json' };
import fixtures from './fixtures/control/delegation-envelope.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base = () => clone(fixtures.cases[0]!.value) as unknown as ControlDelegationEnvelope;
type ObjectValue = Record<string, unknown>;

describe('unresolved control delegation intent contract', () => {
  it.each(fixtures.cases)('$name', test => {
    expect(parseControlDelegationEnvelope(test.value).ok).toBe(test.valid);
    expect(validateJsonSchema(schema, test.value)).toBe('schemaGap' in test ? true : test.valid);
  });
  it('matches schema field/shape checks without accepting unknown aliases', () => {
    const value = base();
    for (const level of ['root', 'budget', 'lineage'] as const) {
      const target = (level === 'root' ? value : level === 'budget' ? value.budget : value.lineage[0]) as unknown as ObjectValue;
      for (const key of [...Object.keys(target), 'unexpected']) for (const mutation of [undefined, null, [], {}, '', false, -1, 1.5, 'constructor']) {
        const changed = clone(value);
        const receive = (level === 'root' ? changed : level === 'budget' ? changed.budget : changed.lineage[0]) as unknown as ObjectValue;
        if (mutation === undefined) delete receive[key]; else receive[key] = mutation;
        expect(validateJsonSchema(schema, changed), `${level}.${key}: ${JSON.stringify(mutation)}`).toBe(parseControlDelegationEnvelope(changed).ok);
      }
    }
  });
  it('does not reinterpret legacy approvals, task snapshots or runtime capability booleans', () => {
    const value = base();
    expect(parseOrchestration('task', value).ok).toBe(false);
    expect(parseControlTaskSnapshot(value).ok).toBe(false);
    const legacy = { schemaVersion: 1, originEngineId: 'native', delegateeEngineId: 'hermes', ownershipToken: 'approval-ref' };
    expect(parseControlDelegationEnvelope(legacy).ok).toBe(false);
    const { authorityRef: _authority, ...withoutAuthority } = value;
    expect(parseControlDelegationEnvelope({ ...withoutAuthority, approvalRef: 'approval-record' }).ok).toBe(false);
    expect(parseControlDelegationEnvelope(Object.create(value)).ok).toBe(false);
  });
  it('checks UTF-16 limits without normalizing references or claiming their truth', () => {
    const value = base(); value.authorityRef = ' original ';
    const parsed = parseControlDelegationEnvelope(value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.authorityRef).toBe(' original ');
    value.idempotencyKey = '😀'.repeat(100);
    expect(parseControlDelegationEnvelope(value).ok).toBe(true);
    value.idempotencyKey += 'x';
    expect(parseControlDelegationEnvelope(value).ok).toBe(false);
  });
});
