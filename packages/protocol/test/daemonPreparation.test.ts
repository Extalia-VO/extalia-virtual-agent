import { describe, expect, it } from 'vitest';
import {
  createDaemonFrameReader, DAEMON_FRAME_HEADER_BYTES, DAEMON_OPS, DAEMON_PREPARATION_MAX_CONNECTIONS,
  DAEMON_PREPARATION_MAX_FRAME_BYTES, DAEMON_PREPARATION_OPS, encodeDaemonFrame, parseDaemonFrame,
  type DaemonFrame, type DaemonPreparationAdmission, type DaemonPreparationInspection,
} from '../src/index.js';
import schema from '../schemas/daemon-frame.schema.json' with { type: 'json' };
import fixtures from './fixtures/daemon/preparation.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

describe('durable preparation lifetime wire receipts', () => {
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
    expect(DAEMON_PREPARATION_OPS).toEqual(['preparation.begin', 'preparation.observe', 'preparation.inspect']);
    expect(DAEMON_OPS).toEqual(expect.arrayContaining([...DAEMON_PREPARATION_OPS]));
    expect(DAEMON_PREPARATION_MAX_CONNECTIONS).toBe(16);
    // Existing hello fields work with either the older baseline or the optional extension.
    for (const capabilities of [['hello', 'health'], ['hello', 'health', ...DAEMON_PREPARATION_OPS]]) {
      const envelope = { schemaVersion: 1, requestId: '00000000-0000-4000-8000-000000000003', op: 'hello' };
      for (const frame of [
        { ...envelope, kind: 'request', params: { clientVersion: 'example', capabilities } },
        { ...envelope, kind: 'response', result: { daemonVersion: 'example', capabilities, maxFrameBytes: 1_048_576 } },
      ]) {
        expect(parseDaemonFrame(frame).ok).toBe(true);
        expect(validateJsonSchema(schema, frame)).toBe(true);
      }
    }
  });
  it('bounds the largest canonical preparation inspection below 32 KiB', () => {
    const admission: DaemonPreparationAdmission = {
      invocationId: '00000000-0000-4000-8000-000000000001', missionId: '00000000-0000-4000-8000-000000000004',
      supervisorId: '00000000-0000-4000-8000-000000000002', canonicalWorkspaceId: '00000000-0000-4000-8000-000000000005',
      sessionId: 's'.repeat(200), workspaceId: 'w'.repeat(200),
      connectionIds: Array.from({ length: DAEMON_PREPARATION_MAX_CONNECTIONS }, (_, n) => `c${String(n).padStart(2, '0')}${'x'.repeat(197)}`),
      kind: 'native-mission-preparation', admittedAt: '2026-10-31T12:00:00.000Z', admissionDigest: 'a'.repeat(64),
    };
    const result: DaemonPreparationInspection = {
      admission,
      observation: { invocationId: admission.invocationId, admissionDigest: admission.admissionDigest, kind: 'local-preparation-settled', recordedAt: admission.admittedAt },
    };
    const frame: DaemonFrame = { schemaVersion: 1, kind: 'response', requestId: admission.invocationId, op: 'preparation.inspect', result };
    const bytes = encodeDaemonFrame(frame, DAEMON_PREPARATION_MAX_FRAME_BYTES);
    expect(bytes.length - DAEMON_FRAME_HEADER_BYTES).toBeLessThan(DAEMON_PREPARATION_MAX_FRAME_BYTES);
    expect(createDaemonFrameReader(DAEMON_PREPARATION_MAX_FRAME_BYTES).push(bytes)).toEqual([{ ok: true, frame }]);
  });
});
