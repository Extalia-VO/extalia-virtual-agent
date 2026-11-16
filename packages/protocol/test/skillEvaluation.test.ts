import { describe, expect, it } from 'vitest';
import { parseDaemonFrame } from '../src/index.js';
import schema from '../schemas/daemon-frame.schema.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

const revisionId = `skr_${'a'.repeat(64)}`, treeSha256 = 'b'.repeat(64);
const frame = (kind: 'request' | 'response', op: string, body: unknown) => ({ schemaVersion: 1, kind,
  requestId: '00000000-0000-4000-8000-000000000200', op, [kind === 'request' ? 'params' : 'result']: body });
const plan = { evaluationId: 'evaluation-one', revisionId, treeSha256, subjects: [{ subject: 'candidate', instructions: 'Review the supplied input.',
  references: [], cases: [{ id: 'invalid', input: 'The required identifier is missing.' }] }] };
const evidence = { evaluationId: 'evaluation-one', provider: 'fixture', model: 'fixture-model', subjects: [{ subject: 'candidate', outputs: [{ caseId: 'invalid', text: 'Reject invalid input.' }] }] };
const valid = (value: unknown) => {
  expect(parseDaemonFrame(value).ok).toBe(true);
  expect(validateJsonSchema(schema, value)).toBe(true);
};
const invalid = (value: unknown) => {
  expect(parseDaemonFrame(value).ok).toBe(false);
  expect(validateJsonSchema(schema, value)).toBe(false);
};

describe('learned-skill evaluation wire boundary', () => {
  it('accepts pinned plans and raw evidence without a model-authored pass flag', () => {
    valid(frame('request', 'skill.evaluationBegin', { revisionId, treeSha256 }));
    valid(frame('response', 'skill.evaluationBegin', plan));
    valid(frame('request', 'skill.evaluationComplete', evidence));
    valid(frame('response', 'skill.evaluationComplete', { revisionId, state: 'validated', learnedQuality: {
      complete: true, missingSections: [], testCount: 1, evaluation: { revisionId, treeSha256, status: 'failed', passed: 0, total: 1,
        evaluatedAt: '2026-11-16T00:00:00.000Z', scope: 'synthetic-declarative', issues: ['assertion-failed'] },
    } }));
  });
  it('refuses exposed expectations, invented grades and oversized output evidence', () => {
    invalid(frame('response', 'skill.evaluationBegin', { ...plan, subjects: [{ ...plan.subjects[0], cases: [{ ...plan.subjects[0]!.cases[0], expectedIncludes: ['secret assertion'] }] }] }));
    invalid(frame('request', 'skill.evaluationComplete', { ...evidence, passed: true }));
    invalid(frame('request', 'skill.evaluationComplete', { ...evidence, subjects: [{ subject: 'candidate', outputs: [{ caseId: 'invalid', text: 'x'.repeat(12_001) }] }] }));
    invalid(frame('request', 'skill.evaluationBegin', { revisionId, treeSha256, approve: true }));
  });
  it('permits incomplete legacy plans without claiming evaluation success', () => {
    valid(frame('response', 'skill.evaluationBegin', { ...plan, subjects: [{ ...plan.subjects[0], cases: [] }] }));
    valid(frame('request', 'skill.evaluationComplete', { ...evidence, subjects: [] }));
  });
});
