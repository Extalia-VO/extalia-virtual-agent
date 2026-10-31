import { describe, expect, it } from 'vitest';
import { CONTROL_TASK_STATES, parseControlTaskProjectionContext, parseControlTaskSnapshot, parseOrchestration, type ControlTaskSnapshot } from '../src/index.js';
import schema from '../schemas/control-task-snapshot.schema.json' with { type: 'json' };
import fixtures from './fixtures/control/task-snapshot.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const base = () => clone(fixtures.cases[0]!.value) as ControlTaskSnapshot;
type ObjectValue = Record<string, unknown>;

describe('separate control task lifecycle and completion claims', () => {
  it.each(fixtures.cases)('$name', ({ valid, value }) => {
    expect(parseControlTaskSnapshot(value).ok).toBe(valid);
    expect(validateJsonSchema(schema, value)).toBe(valid);
  });
  it('covers every declared lifecycle, preserving legacy contract refusal', () => {
    for (const state of CONTROL_TASK_STATES) expect(fixtures.cases.some(test => test.valid && test.value && 'state' in test.value && test.value.state === state)).toBe(true);
    expect(parseOrchestration('task', base()).ok).toBe(false);
    expect(parseControlTaskSnapshot({ ...base(), protocol: 'extalia.v0', schemaVersion: 1 }).ok).toBe(false);
    expect(parseOrchestration('task', { schemaVersion: 1, state: 'superseded' }).ok).toBe(false);
  });
  it('keeps schema parity for every field and nested validation/acceptance variant', () => {
    const variants = [base(), ...fixtures.cases.filter(test => ['validation passed', 'acceptance waived', 'lifecycle completed'].includes(test.name)).map(test => clone(test.value) as ControlTaskSnapshot)];
    for (const value of variants) for (const level of ['root', 'validation', 'acceptance'] as const) {
      const original = (level === 'root' ? value : value[level]) as unknown as ObjectValue;
      for (const key of [...Object.keys(original), 'unexpected']) for (const mutation of [undefined, null, [], {}, '', true, 0, 1, 'constructor']) {
        const changed = clone(value);
        const target = (level === 'root' ? changed : changed[level]) as unknown as ObjectValue;
        if (mutation === undefined) delete target[key]; else target[key] = mutation;
        expect(validateJsonSchema(schema, changed), `${level}.${key}: ${JSON.stringify(mutation)}`).toBe(parseControlTaskSnapshot(changed).ok);
      }
    }
  });
  it('validates positive independent revisions, UTF-16 records and bounded evidence', () => {
    const value = base();
    value.definitionVersion = Number.MAX_SAFE_INTEGER; value.stateVersion = 2;
    value.acceptance = { state: 'waived', recordRef: 'record', reason: '😀'.repeat(1_000) };
    expect(parseControlTaskSnapshot(value).ok).toBe(true);
    value.acceptance.reason += 'x'; expect(parseControlTaskSnapshot(value).ok).toBe(false);
    value.acceptance = { state: 'unknown' };
    value.validation = { state: 'failed', recordRef: '😀'.repeat(100) };
    expect(parseControlTaskSnapshot(value).ok).toBe(true);
    value.validation.recordRef += 'x'; expect(parseControlTaskSnapshot(value).ok).toBe(false);
    value.validation = { state: 'unknown' };
    value.evidenceIds = Array.from({ length: 1_001 }, (_, index) => `${index.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`);
    expect(parseControlTaskSnapshot(value).ok).toBe(false);
    expect(validateJsonSchema(schema, value)).toBe(false);
  });
  it('checks explicit legacy context namespaces without fabricating task mappings', () => {
    const value = base();
    const context = { profileId: value.profileId, workspaceId: value.workspaceId, source: { family: 'orchestration.v1', system: 'extalia', instanceId: 'bridge-a', workspaceId: value.workspaceId, missionId: value.missionId } };
    expect(parseControlTaskProjectionContext(context).ok).toBe(true);
    for (const source of [{ ...context.source, family: 'extalia.v0' }, { ...context.source, instanceId: '' }, { ...context.source, system: 'external' }, { ...context.source, missionId: 'unknown' }, { ...context.source, extra: true }]) {
      expect(parseControlTaskProjectionContext({ ...context, source }).ok).toBe(false);
    }
    for (const bad of [null, [], {}, { ...context, extra: true }, Object.create(context)]) expect(parseControlTaskProjectionContext(bad).ok).toBe(false);
  });
});
