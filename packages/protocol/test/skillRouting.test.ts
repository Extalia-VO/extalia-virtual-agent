import { describe, expect, it } from 'vitest';
import { parseDaemonFrame, SKILL_ROUTING_MAX_BYTES } from '../src/index.js';
import fixtures from './fixtures/daemon/skill-routing.json' with { type: 'json' };
import schema from '../schemas/daemon-frame.schema.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

describe('read-only skill routing contract', () => {
  it.each(fixtures.cases)('$name', item => {
    const result = parseDaemonFrame(item.value);
    expect(result.ok).toBe(item.valid);
    if (!result.ok) expect(result.code).toBe('code' in item ? item.code : undefined);
    expect(validateJsonSchema(schema, item.value)).toBe(item.valid || 'schemaGap' in item);
  });
  it('bounds semantic reports at 512 KiB even with individually valid strings and arrays', () => {
    const valid = fixtures.cases.find(item => item.name === 'matched diagnostic only')!.value as { result: unknown };
    const report = JSON.parse(JSON.stringify(valid.result)) as { input: { candidateRevisionIds: string[]; pins: Record<string, string> }; candidates: { identity: Record<string, string>; plan: Record<string, string>[] }[]; eligibleCount: number; topTieCount: number; status: string };
    report.input.candidateRevisionIds = Array.from({ length: 16 }, (_, n) => `skr_${n.toString(16).padStart(64, '0')}`);
    report.input.pins = Object.fromEntries(Array.from({ length: 127 }, (_, n) => [`dependency-${n}`, `skr_${(n + 100).toString(16).padStart(64, '0')}`]));
    report.candidates = report.input.candidateRevisionIds.map((revisionId, n) => {
      const identity = { packageId: `candidate-${String(n).padStart(2, '0')}`, revisionId, version: `1.0.0+${'v'.repeat(122)}`, treeSha256: revisionId.slice(4), permissionDigest: 'f'.repeat(64) };
      return { ...JSON.parse(JSON.stringify((valid.result as { candidates: object[] }).candidates[0])), identity,
        plan: [...Object.entries(report.input.pins).map(([packageId, revisionId]) => ({ ...identity, packageId, revisionId, treeSha256: revisionId.slice(4) })), identity] } as typeof report.candidates[number];
    });
    report.eligibleCount = 16; report.topTieCount = 16; report.status = 'ambiguous';
    expect(JSON.stringify(report).length).toBeGreaterThan(SKILL_ROUTING_MAX_BYTES);
    expect(parseDaemonFrame({ ...valid, result: report }).ok).toBe(false);
  });
});
