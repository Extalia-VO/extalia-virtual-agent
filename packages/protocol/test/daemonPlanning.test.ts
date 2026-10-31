import { describe, expect, it } from 'vitest';
import {
  createDaemonFrameReader, DAEMON_FRAME_HEADER_BYTES, DAEMON_OPS, DAEMON_PLANNING_MAX_CONNECTIONS,
  DAEMON_PLANNING_MAX_FRAME_BYTES, DAEMON_PLANNING_OPS, encodeDaemonFrame, parseDaemonFrame,
  type DaemonFrame, type DaemonPlanningAdmission, type DaemonPlanningInspection,
} from '../src/index.js';
import schema from '../schemas/daemon-frame.schema.json' with { type: 'json' };
import fixtures from './fixtures/daemon/planning.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

describe('durable planning lifetime wire receipts', () => {
  it.each(fixtures.cases)('$name', testCase => {
    const result = parseDaemonFrame(testCase.value);
    expect(result.ok).toBe(testCase.valid);
    if (!result.ok) expect(result.code).toBe('code' in testCase ? testCase.code : undefined);
    expect(validateJsonSchema(schema, testCase.value)).toBe(testCase.valid || 'schemaGap' in testCase);
    if (testCase.valid) {
      const frame = testCase.value as DaemonFrame;
      expect(createDaemonFrameReader().push(encodeDaemonFrame(frame))).toEqual([{ ok: true, frame }]);
    }
  });
  it('publishes three additive optional operations and bounded connection scope', () => {
    expect(DAEMON_PLANNING_OPS).toEqual(['planning.begin', 'planning.observe', 'planning.inspect']);
    expect(DAEMON_OPS).toEqual(expect.arrayContaining([...DAEMON_PLANNING_OPS]));
    expect(DAEMON_PLANNING_MAX_CONNECTIONS).toBe(16);
    // Older peers can still advertise their own baseline without planning capabilities.
    expect(parseDaemonFrame({ schemaVersion: 1, kind: 'response', requestId: '00000000-0000-4000-8000-000000000003', op: 'hello', result: { daemonVersion: 'example', capabilities: ['hello', 'health'], maxFrameBytes: 1_048_576 } }).ok).toBe(true);
  });
  it('bounds the largest canonical planning inspection below 32 KiB', () => {
    const admission: DaemonPlanningAdmission = {
      invocationId: '00000000-0000-4000-8000-000000000001', supervisorId: '00000000-0000-4000-8000-000000000002',
      sessionId: 's'.repeat(200), workspaceId: 'w'.repeat(200),
      connectionIds: Array.from({ length: DAEMON_PLANNING_MAX_CONNECTIONS }, (_, n) => `c${String(n).padStart(2, '0')}${'x'.repeat(197)}`),
      kind: 'native-planning', admittedAt: '2026-10-31T12:00:00.000Z', admissionDigest: 'a'.repeat(64),
    };
    const result: DaemonPlanningInspection = {
      admission,
      observation: { invocationId: admission.invocationId, admissionDigest: admission.admissionDigest, kind: 'local-pipeline-settled', recordedAt: admission.admittedAt },
    };
    const frame: DaemonFrame = { schemaVersion: 1, kind: 'response', requestId: admission.invocationId, op: 'planning.inspect', result };
    const bytes = encodeDaemonFrame(frame, DAEMON_PLANNING_MAX_FRAME_BYTES);
    expect(bytes.length - DAEMON_FRAME_HEADER_BYTES).toBeLessThan(DAEMON_PLANNING_MAX_FRAME_BYTES);
    expect(createDaemonFrameReader(DAEMON_PLANNING_MAX_FRAME_BYTES).push(bytes)).toEqual([{ ok: true, frame }]);
  });
});
