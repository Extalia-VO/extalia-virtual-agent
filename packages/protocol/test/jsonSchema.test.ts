import { describe, expect, it } from 'vitest';
import {
  isUtcTimestamp, parseDaemonFrame, parseOrchestration, parseWorkerFrame, parseWorkerBundleManifest, protocolJsonSchemas, serializeJsonSchema,
  type JsonSchema, type OrchestrationContractKind,
} from '../src/index.js';
import { schemaKeywords, SUPPORTED_KEYWORDS, validateJsonSchema } from './jsonSchemaSubset.js';
import agentEventSchema from '../schemas/agent-event.schema.json' with { type: 'json' };
import approvalSchema from '../schemas/approval.schema.json' with { type: 'json' };
import daemonFrameSchema from '../schemas/daemon-frame.schema.json' with { type: 'json' };
import workerFrameSchema from '../schemas/python-worker-frame.schema.json' with { type: 'json' };
import workerBundleSchema from '../schemas/worker-bundle-manifest.schema.json' with { type: 'json' };
import missionSchema from '../schemas/mission.schema.json' with { type: 'json' };
import permissionSchema from '../schemas/permission.schema.json' with { type: 'json' };
import taskSchema from '../schemas/task.schema.json' with { type: 'json' };
import controlManifestSchema from '../schemas/control-capability-manifest.schema.json' with { type: 'json' };
import identityMapSchema from '../schemas/control-identity-map.schema.json' with { type: 'json' };
import controlTaskSchema from '../schemas/control-task-snapshot.schema.json' with { type: 'json' };
import controlDelegationSchema from '../schemas/control-delegation-envelope.schema.json' with { type: 'json' };
import agentEventFixtures from './fixtures/orchestration/agent-event.json' with { type: 'json' };
import approvalFixtures from './fixtures/orchestration/approval.json' with { type: 'json' };
import missionFixtures from './fixtures/orchestration/mission.json' with { type: 'json' };
import permissionFixtures from './fixtures/orchestration/permission.json' with { type: 'json' };
import taskFixtures from './fixtures/orchestration/task.json' with { type: 'json' };
import frameFixtures from './fixtures/daemon/frames.json' with { type: 'json' };
import candidateFixtures from './fixtures/daemon/skill-candidates.json' with { type: 'json' };
import workerFixtures from './fixtures/worker/frames.json' with { type: 'json' };
import bundleFixtures from './fixtures/worker/bundles.json' with { type: 'json' };

interface Case { name: string; valid: boolean; value: unknown; schemaGap?: string; code?: string }
const DAEMON_CASES: Case[] = [...frameFixtures.cases, ...candidateFixtures.cases];
/** Committed files, read as the Rust daemon and `cargo test` will read them. */
const COMMITTED: Record<string, JsonSchema> = {
  'worker-bundle-manifest.schema.json': workerBundleSchema,
  'python-worker-frame.schema.json': workerFrameSchema,
  'control-delegation-envelope.schema.json': controlDelegationSchema,
  'control-task-snapshot.schema.json': controlTaskSchema,
  'control-identity-map.schema.json': identityMapSchema,
  'control-capability-manifest.schema.json': controlManifestSchema,
  'mission.schema.json': missionSchema, 'task.schema.json': taskSchema, 'agent-event.schema.json': agentEventSchema,
  'approval.schema.json': approvalSchema, 'permission.schema.json': permissionSchema, 'daemon-frame.schema.json': daemonFrameSchema,
};
const ORCHESTRATION: [OrchestrationContractKind, JsonSchema, { cases: Case[] }][] = [
  ['mission', missionSchema, missionFixtures], ['task', taskSchema, taskFixtures], ['agentEvent', agentEventSchema, agentEventFixtures],
  ['approval', approvalSchema, approvalFixtures], ['permission', permissionSchema, permissionFixtures],
];
const schemaAccepts = (schema: JsonSchema, value: unknown) => validateJsonSchema(schema, value);

describe('JSON Schema anyOf semantics', () => {
  const alternatives = [{ type: 'integer' }, { type: 'number', minimum: 0 }];
  it.each([
    { value: 1, valid: true }, // Both branches match; anyOf is not oneOf.
    { value: 1.5, valid: true }, { value: -1, valid: true },
    { value: -1.5, valid: false }, { value: '1', valid: false },
  ])('accepts at least one matching branch for $value', ({ value, valid }) => {
    expect(validateJsonSchema({ anyOf: alternatives }, value)).toBe(valid);
  });
  it('keeps sibling constraints and resolves nested branches against the original root', () => {
    const schema: JsonSchema = { type: 'string', pattern: '^x', maxLength: 4,
      $defs: { Label: { type: 'string', minLength: 3 }, Never: false },
      anyOf: [{ $ref: '#/$defs/Never' }, { allOf: [{ $ref: '#/$defs/Label' }, { not: { const: 'xno' } }] }],
    };
    for (const [value, valid] of [['xok', true], ['xno', false], ['x', false], ['foo', false], ['xlong', false], [3, false]] as const) {
      expect(validateJsonSchema(schema, value), String(value)).toBe(valid);
    }
    expect(validateJsonSchema({ oneOf: alternatives }, 1)).toBe(false);
  });
  it('honors true and false schemas without ignoring sibling assertions', () => {
    expect(validateJsonSchema({ anyOf: [false, { const: 'accepted' }] }, 'accepted')).toBe(true);
    expect(validateJsonSchema({ anyOf: [false, { const: 'accepted' }] }, 'other')).toBe(false);
    expect(validateJsonSchema({ anyOf: [false, true] }, { arbitrary: 'value' })).toBe(true);
    expect(validateJsonSchema({ type: 'string', anyOf: [false, true] }, 42)).toBe(false);
    expect(validateJsonSchema({ anyOf: [false, false] }, 'value')).toBe(false);
  });
  it('still rejects an unsupported keyword in a branch after a successful branch', () => {
    const schema = { anyOf: [true, { unsupportedConstraint: true }] };
    expect(schemaKeywords(schema)).toContain('unsupportedConstraint');
    expect(() => validateJsonSchema(schema, 'value')).toThrow('Unsupported keyword unsupportedConstraint');
  });
  it('rejects malformed anyOf rather than silently dropping its constraint', () => {
    for (const anyOf of [[], {}, null]) expect(() => validateJsonSchema({ anyOf }, 'value')).toThrow('anyOf requires a nonempty array of schemas');
    expect(() => validateJsonSchema({ anyOf: [true, null] }, 'value')).toThrow('Expected an object or boolean JSON Schema');
  });
});

describe('generated JSON Schema files', () => {
  it('match the committed files byte for byte and stay self-contained', () => {
    const generated = protocolJsonSchemas();
    expect(Object.keys(generated).sort()).toEqual(Object.keys(COMMITTED).sort());
    for (const [file, schema] of Object.entries(generated)) {
      expect(JSON.parse(serializeJsonSchema(schema)), file).toEqual(COMMITTED[file]);
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    }
  });
  it('use only keywords the parity validator implements', () => {
    for (const schema of Object.values(COMMITTED)) for (const keyword of schemaKeywords(schema)) expect(SUPPORTED_KEYWORDS, keyword).toContain(keyword);
  });
});

describe('golden fixtures: validator and JSON Schema verdicts agree', () => {
  it.each((bundleFixtures as { cases: Case[] }).cases)('worker bundle: $name', ({ valid, value, schemaGap }) => {
    expect(parseWorkerBundleManifest(value).ok).toBe(valid);
    expect(schemaAccepts(workerBundleSchema, value)).toBe(schemaGap ? true : valid);
  });
  it.each((workerFixtures as { cases: Case[] }).cases)('worker frame: $name', ({ valid, value }) => {
    expect(parseWorkerFrame(value).ok).toBe(valid);
    expect(schemaAccepts(workerFrameSchema, value)).toBe(valid);
  });
  for (const [kind, schema, { cases }] of ORCHESTRATION) {
    it.each(cases)(`${kind}: $name`, ({ valid, value, schemaGap }) => {
      expect(parseOrchestration(kind, value).ok).toBe(valid);
      // A named gap is a semantic check JSON Schema cannot express; the schema accepts it.
      expect(schemaAccepts(schema, value)).toBe(schemaGap ? true : valid);
      if (schemaGap) expect(valid).toBe(false);
    });
  }
  it.each(DAEMON_CASES)('daemon frame: $name', ({ valid, value, schemaGap, code }) => {
    const result = parseDaemonFrame(value);
    expect(result.ok).toBe(valid);
    if (!result.ok) expect(result.code).toBe(code);
    expect(schemaAccepts(daemonFrameSchema, value)).toBe(schemaGap ? true : valid);
  });
});

describe('generated parity beyond the golden fixtures', () => {
  const mutations = [undefined, null, 'x', '', -1, 1.5, true, [], {}];
  it('agrees on every field mutation of every valid fixture', () => {
    const check = (verdict: (value: unknown) => boolean, accepts: (value: unknown) => boolean, value: Record<string, unknown>) => {
      for (const key of Object.keys(value)) for (const mutation of mutations) {
        const changed = { ...value };
        if (mutation === undefined) delete changed[key]; else changed[key] = mutation;
        expect(accepts(changed), `${key} = ${JSON.stringify(mutation)}`).toBe(verdict(changed));
      }
    };
    for (const [kind, schema, { cases }] of ORCHESTRATION) for (const item of cases.filter(entry => entry.valid)) {
      check(value => parseOrchestration(kind, value).ok, value => schemaAccepts(schema, value), item.value as Record<string, unknown>);
    }
    for (const item of DAEMON_CASES.filter(entry => entry.valid)) {
      const frame = item.value as Record<string, unknown>;
      check(value => parseDaemonFrame(value).ok, value => schemaAccepts(daemonFrameSchema, value), frame);
      const key = 'params' in frame ? 'params' : 'result' in frame ? 'result' : 'error';
      const nested = (value: unknown) => ({ ...frame, [key]: value });
      check(value => parseDaemonFrame(nested(value)).ok, value => schemaAccepts(daemonFrameSchema, nested(value)), frame[key] as Record<string, unknown>);
    }
  });
  it('agrees on every refinement-base presence combination and import origin', () => {
    const fields: Record<string, string> = {
      expectedBaseRevisionId: `skr_${'a'.repeat(64)}`, expectedBaseSkillSha256: 'b'.repeat(64),
      learningProfileId: 'profile-one', learningWorkspaceId: 'w_example',
    };
    const entries = Object.entries(fields);
    for (const origin of ['generated', 'user', 'workspace', 'imported', 'builtin']) for (let mask = 0; mask < 1 << entries.length; mask++) {
      const params: Record<string, unknown> = { origin, path: 'proposal-fixture' };
      for (let index = 0; index < entries.length; index++) if (mask & 1 << index) {
        const [key, value] = entries[index]!; params[key] = value;
      }
      const frame = { schemaVersion: 1, kind: 'request', requestId: '00000000-0000-4000-8000-000000000001', op: 'skill.import', params };
      const expected = origin !== 'builtin' && (mask === 0 || origin === 'generated' && mask === (1 << entries.length) - 1);
      expect(parseDaemonFrame(frame).ok, `${origin}, fields=${mask}`).toBe(expected);
      expect(schemaAccepts(daemonFrameSchema, frame), `${origin}, fields=${mask}`).toBe(expected);
    }
  });
  it('agrees on every enumeration value and on unknown values', () => {
    const mission = missionFixtures.cases[0]!.value;
    const task = taskFixtures.cases[0]!.value;
    const approval = approvalFixtures.cases[1]!.value;
    const variants: [OrchestrationContractKind, JsonSchema, Record<string, unknown>, string, string[]][] = [
      ['mission', missionSchema, mission, 'state', ['draft', 'planning', 'queued', 'running', 'waiting', 'awaiting_approval', 'reviewing', 'completed', 'failed', 'cancelled', 'recovering', 'paused']],
      ['task', taskSchema, task, 'state', ['queued', 'blocked', 'assigned', 'running', 'waiting', 'awaiting_approval', 'verifying', 'completed', 'failed', 'cancelled', 'unknown', 'paused']],
      ['task', taskSchema, { ...task, state: 'completed' }, 'verification', ['unverified', 'verified', 'maybe']],
      ['approval', approvalSchema, approval, 'status', ['pending', 'granted', 'rejected', 'expired', 'revoked', 'approved']],
      ['approval', approvalSchema, approval, 'risk', ['low', 'medium', 'high', 'critical']],
    ];
    for (const [kind, schema, base, field, values] of variants) for (const value of values) {
      const record = { ...base, [field]: value };
      expect(schemaAccepts(schema, record), `${kind}.${field} = ${value}`).toBe(parseOrchestration(kind, record).ok);
    }
  });
  it('agrees with trim() and control-character rules for every BMP character', () => {
    const permission = permissionFixtures.cases[0]!.value;
    const event = agentEventFixtures.cases[3]!.value as { body: Record<string, unknown> };
    for (let code = 0; code <= 0xffff; code++) {
      const character = String.fromCharCode(code);
      const record = { ...permission, capability: character };
      expect(schemaAccepts(permissionSchema, record), `U+${code.toString(16)}`).toBe(parseOrchestration('permission', record).ok);
      const v0 = { ...event, body: { ...event.body, label: character } };
      expect(schemaAccepts(agentEventSchema, v0), `v0 U+${code.toString(16)}`).toBe(parseOrchestration('agentEvent', v0).ok);
    }
  }, 30_000);
  it('accepts exactly the real calendar timestamps isUtcTimestamp accepts', () => {
    const timestamp = { type: 'string', pattern: (missionSchema.$defs.UtcTimestamp as { pattern: string }).pattern };
    const pad = (value: number, size = 2) => String(value).padStart(size, '0');
    for (const year of [0, 4, 100, 400, 1900, 2000, 2023, 2024, 2026, 2100, 9999]) for (let month = 0; month <= 13; month++) for (let day = 0; day <= 32; day++) {
      for (const time of ['00:00:00', '23:59:59.999', '24:00:00', '12:60:00', '12:00:60', '12:00:00.1234']) {
        const value = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${time}Z`;
        expect(validateJsonSchema(timestamp, value), value).toBe(isUtcTimestamp(value));
      }
    }
  });
});
