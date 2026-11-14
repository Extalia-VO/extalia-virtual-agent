import { describe, expect, it } from 'vitest';
import { learningParams, learningResult } from '../src/daemonLearningRules.js';
const scope = { profileId: 'default', workspaceId: 'workspace-one', sessionId: 'observed-one', sourceId: 'codex', nativeSessionId: 'native-one', boundary: 'a'.repeat(64) };
const capture = { action: 'observed.capture', input: { scope, episodeId: 'terminal-one', sourceRevision: 'native-r1', entries: [{ id: 'event-one', kind: 'assistant', text: 'A reported outcome.' }], coverage: { mode: 'partial', omittedEntries: 0, truncated: false, limits: ['Visible source only.'] } } };
const valid = (rule: typeof learningParams, value: unknown) => { const errors: string[] = []; rule.check(value, 'value', errors); return errors.length === 0; };
describe('observed memory learning contract', () => {
  it('admits bounded source-attributed capture and exact-scope retrieval requests', () => {
    expect(valid(learningParams, capture)).toBe(true);
    expect(valid(learningParams, { action: 'observed.search', input: { scope, query: 'reported outcome', limit: 6 } })).toBe(true);
    expect(valid(learningParams, { action: 'observed.read', input: { scope, episodeId: 'b'.repeat(64), revision: 'c'.repeat(64), offset: 0, limit: 32 } })).toBe(true);
    expect(valid(learningParams, { action: 'observed.revoke', input: { scope } })).toBe(true);
  });
  it('refuses caller-supplied verified status, complete coverage and unbounded entries', () => {
    expect(valid(learningParams, { ...capture, input: { ...capture.input, trust: 'verified' } })).toBe(false);
    expect(valid(learningParams, { ...capture, input: { ...capture.input, coverage: { ...capture.input.coverage, mode: 'full' } } })).toBe(false);
    expect(valid(learningParams, { ...capture, input: { ...capture.input, entries: Array.from({ length: 33 }, () => capture.input.entries[0]) } })).toBe(false);
    expect(valid(learningParams, { ...capture, input: { ...capture.input, entries: [{ ...capture.input.entries[0], text: 'a'.repeat(8001) }] } })).toBe(false);
  });
  it('accepts observed curator jobs only by stored episode identity, never fabricated tool results', () => {
    const input = { scope, episodeId: 'b'.repeat(64), revision: 'c'.repeat(64), runId: 'observed-curator', promptSha256: 'd'.repeat(64), policy: { enabled: true, skills: true, notes: true }, tools: [] };
    expect(valid(learningParams, { action: 'observed.jobBegin', input })).toBe(true);
    expect(valid(learningParams, { action: 'observed.jobBegin', input: { ...input, evidence: [{ toolCallId: 'fabricated', content: 'Verified', isError: false }] } })).toBe(false);
    expect(valid(learningParams, { action: 'observed.jobBegin', input: { ...input, intakeId: 'arbitrary-native-intake' } })).toBe(false);
  });
  it('requires the literal untrusted-observed marker and retained coverage in replies', () => {
    const episode = { id: 'b'.repeat(64), episodeId: 'terminal-one', scope, revision: 'c'.repeat(64), sourceRevision: 'r1', capturedAt: '1234', entries: 1, trust: 'untrusted-observed', coverage: capture.input.coverage };
    expect(valid(learningResult, { action: 'observed.capture', episode, created: true })).toBe(true);
    expect(valid(learningResult, { action: 'observed.capture', episode: { ...episode, trust: 'verified' }, created: true })).toBe(false);
    expect(valid(learningResult, { action: 'observed.read', episode, entries: [{ id: 'event-one', kind: 'assistant', text: 'a'.repeat(2001) }], offset: 0, total: 1 })).toBe(false);
  });
});
