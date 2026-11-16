import { describe, expect, it } from 'vitest';
import { learningParams, learningResult } from '../src/daemonLearningRules.js';
const scope = { profileId: 'default', workspaceId: 'workspace-one', boundary: 'a'.repeat(64) };
const source = { kind: 'native', sourceId: 'extalia-native', sessionId: 'session-one', episodeId: 'turn-one', revision: 'b'.repeat(64) };
const capture = { action: 'memory.capture', input: { scope, source, outcome: 'failed', title: 'Parser attempt failed', summary: 'Fixture missing, retry requires current evidence.', entries: [{ id: 'tool-one', kind: 'tool', text: 'Missing fixture.' }], coverage: { mode: 'partial', omittedEntries: 0, truncated: false, limits: [] } } };
const valid = (rule: typeof learningParams, value: unknown) => { const errors: string[] = []; rule.check(value, 'value', errors); return errors.length === 0; };

describe('operational memory wire contract', () => {
  it('admits scoped capture for completed, failed and cancelled outcomes', () => {
    for (const outcome of ['completed', 'failed', 'cancelled']) expect(valid(learningParams, { ...capture, input: { ...capture.input, outcome } })).toBe(true);
    expect(valid(learningParams, { action: 'memory.search', input: { scope, query: 'fixture', limit: 4 } })).toBe(true);
    expect(valid(learningParams, { action: 'memory.read', input: { scope, id: 'c'.repeat(64), revision: 'd'.repeat(64), offset: 0, limit: 2 } })).toBe(true);
    expect(valid(learningParams, { action: 'memory.revoke', input: { scope, sourceKind: 'native', sessionId: 'session-one', episodeId: 'turn-one' } })).toBe(true);
  });
  it('requires an explicit current source access key for observed captures', () => {
    const observed = { ...capture.input, source: { ...source, kind: 'observed' } };
    expect(valid(learningParams, { ...capture, input: observed })).toBe(false);
    expect(valid(learningParams, { ...capture, input: { ...observed, source: { ...observed.source, accessKey: 'c'.repeat(64) } } })).toBe(true);
    expect(valid(learningParams, { action: 'memory.search', input: { scope, query: 'fixture', observedSourceKeys: Array.from({ length: 33 }, (_, i) => i.toString(16).padStart(64, '0')) } })).toBe(false);
  });
  it('refuses caller-supplied truth claims and excessive capture/read payloads', () => {
    expect(valid(learningParams, { ...capture, input: { ...capture.input, trust: 'verified' } })).toBe(false);
    expect(valid(learningParams, { ...capture, input: { ...capture.input, entries: Array.from({ length: 33 }, () => capture.input.entries[0]) } })).toBe(false);
    const record = { id: 'c'.repeat(64), revision: 'd'.repeat(64), scope, source, outcome: 'failed', title: capture.input.title, summary: capture.input.summary, capturedAt: '2026-01-01T00:00:00Z', entries: 1, trust: 'attributed-evidence', coverage: capture.input.coverage };
    expect(valid(learningResult, { action: 'memory.capture', record, created: true })).toBe(true);
    expect(valid(learningResult, { action: 'memory.capture', record: { ...record, trust: 'verified' }, created: true })).toBe(false);
    expect(valid(learningResult, { action: 'memory.read', record, entries: [{ ...capture.input.entries[0], text: 'x'.repeat(2001) }], offset: 0, total: 1 })).toBe(false);
  });
  it('accepts bounded historical context separately from current learning evidence', () => {
    const job = { profileId: 'default', revision: 'r1', workspaceId: 'workspace-one', sessionId: 'session-one', runId: 'run-one', promptSha256: 'c'.repeat(64), policy: { enabled: true, skills: true, notes: true }, tools: [], evidence: [], memoryContext: 'Attributed historical context; no verification implied.' };
    expect(valid(learningParams, { action: 'job.begin', input: job })).toBe(true);
    expect(valid(learningParams, { action: 'job.begin', input: { ...job, memoryContext: 'x'.repeat(6001) } })).toBe(false);
  });
});
