import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillEvaluationPlan } from '@extalia/protocol';
import type { ModelRequest, ModelResult } from '@extalia/runtime';
import { runSkillEvaluation, type SkillEvaluationOptions } from '../src/skillEvaluation.js';

const revisionId = `skr_${'a'.repeat(64)}`, treeSha256 = 'b'.repeat(64);
const subject = (kind: 'candidate' | 'baseline') => ({ subject: kind, instructions: `${kind} procedure`,
  references: [{ path: 'references/source.md', content: 'Treat invalid input carefully.' }], cases: [{ id: 'invalid', input: 'A required identifier is missing. What should happen?' }] });
const reply = (patch: Partial<ModelResult> = {}): ModelResult => ({ text: JSON.stringify({ outputs: [{ caseId: 'invalid', text: 'Validate and reject the invalid input.' }] }), stop: 'end', toolCalls: [], ...patch });
function fixture(settings: { baseline?: boolean; plan?: Partial<SkillEvaluationPlan>; complete?(request: ModelRequest): Promise<ModelResult> } = {}) {
  const requests: ModelRequest[] = [], controller = new AbortController();
  const plan: SkillEvaluationPlan = { evaluationId: 'evaluation-one', revisionId, treeSha256, subjects: [subject('candidate')],
    ...(settings.baseline ? { baselineRevisionId: `skr_${'c'.repeat(64)}`, baselineTreeSha256: 'd'.repeat(64), subjects: [subject('candidate'), subject('baseline')] } : {}), ...settings.plan };
  const begin = vi.fn(async () => plan);
  const complete = vi.fn(async (_evidence: Parameters<SkillEvaluationOptions['backend']['complete']>[0]) => ({ revisionId, state: 'awaiting_approval' as const,
    learnedQuality: { complete: true, missingSections: [], testCount: 1 } }));
  const provider = vi.fn(async () => ({ name: 'fixture-connection', model: 'fixture-model', provider: { api: 'openai-chat' as const,
    listModels: async () => ['fixture-model'],
    complete: async (request: ModelRequest) => { requests.push(request); return settings.complete ? settings.complete(request) : reply(); } } }));
  const assertCurrent = vi.fn(() => undefined);
  const options: SkillEvaluationOptions = { revisionId, treeSha256, backend: { begin, complete }, provider, signal: controller.signal, assertCurrent };
  return { options, plan, begin, complete, provider, requests, controller, assertCurrent };
}
afterEach(() => vi.useRealTimers());

describe('isolated learned-skill evaluation orchestration', () => {
  it('runs candidate and active baseline against blind inputs without tools, then submits raw outputs for Rust grading', async () => {
    const f = fixture({ baseline: true });
    const result = await runSkillEvaluation(f.options);
    expect(result.state).toBe('awaiting_approval');
    expect(f.begin).toHaveBeenCalledExactlyOnceWith({ revisionId, treeSha256 });
    expect(f.requests).toHaveLength(2);
    for (const request of f.requests) {
      expect(request.tools).toEqual([]);
      const body = JSON.parse((request.messages[0] as { text: string }).text);
      expect(Object.keys(body)).toEqual(['instructions', 'references', 'cases']);
      expect(body.cases).toEqual(f.plan.subjects[0]!.cases);
      expect(JSON.stringify(request)).not.toMatch(/expectedIncludes|forbiddenIncludes|baselineRevisionId/);
    }
    expect(f.complete).toHaveBeenCalledExactlyOnceWith({ evaluationId: 'evaluation-one', provider: 'fixture-connection', model: 'fixture-model',
      subjects: ['candidate', 'baseline'].map(subject => ({ subject, outputs: [{ caseId: 'invalid', text: 'Validate and reject the invalid input.' }] })) });
  });

  it.each([
    { text: '{"passed":true,"outputs":[{"caseId":"invalid","text":"Pass"}]}' },
    { text: '{"outputs":[{"caseId":"invented","text":"Pass"}]}' },
    { text: '{"outputs":[]}' },
    { text: '{"outputs":[{"caseId":"invalid","text":"bad\\u0000control"}]}' },
    { text: 'x'.repeat(80_001) },
    { stop: 'max_tokens' as const },
    { refusal: 'Cannot answer.' },
    { toolCalls: [{ id: 'unwanted', name: 'write_file', input: {} }] },
  ])('never accepts model grades, malformed answers, refusals, truncated responses or tool requests (case %#)', async patch => {
    const f = fixture({ baseline: true, complete: async () => reply(patch) });
    await runSkillEvaluation(f.options);
    expect(f.requests).toHaveLength(1);
    expect(f.complete.mock.calls[0]![0].subjects).toEqual([{ subject: 'candidate', outputs: [] }]);
  });

  it('avoids inference for incomplete fixtures, oversized plans and unavailable providers', async () => {
    for (const subjects of [[{ ...subject('candidate'), cases: [] }], [{ ...subject('candidate'), instructions: 'x'.repeat(150_000) }]]) {
      const f = fixture({ plan: { subjects } });
      await runSkillEvaluation(f.options);
      expect(f.provider).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
      expect(f.complete.mock.calls[0]![0].subjects).toEqual([]);
    }
    const f = fixture(); f.provider.mockRejectedValue(new Error('Unavailable.'));
    await runSkillEvaluation(f.options);
    expect(f.requests).toEqual([]); expect(f.complete.mock.calls[0]![0].subjects).toEqual([]);
  });

  it('rejects changed pins or workspace authority without publishing a passing receipt', async () => {
    const wrong = fixture({ plan: { treeSha256: 'c'.repeat(64) } });
    await expect(runSkillEvaluation(wrong.options)).rejects.toThrow('plan');
    expect(wrong.provider).not.toHaveBeenCalled(); expect(wrong.complete).not.toHaveBeenCalled();
    const unpaired = fixture({ plan: { baselineRevisionId: `skr_${'c'.repeat(64)}`, subjects: [subject('candidate'), subject('baseline')] } });
    await expect(runSkillEvaluation(unpaired.options)).rejects.toThrow('plan');
    expect(unpaired.provider).not.toHaveBeenCalled();
    const changed = fixture({ complete: async () => { changed.assertCurrent.mockImplementation(() => { throw new Error('Changed scope.'); }); return reply(); } });
    await expect(runSkillEvaluation(changed.options)).rejects.toThrow('Changed scope');
    expect(changed.complete).not.toHaveBeenCalled();
  });

  it('waits for physical provider settlement after timeout and records no successful answer', async () => {
    vi.useFakeTimers();
    let finish!: (value: ModelResult) => void;
    const held = new Promise<ModelResult>(resolve => { finish = resolve; });
    const f = fixture({ complete: async () => held });
    const running = runSkillEvaluation({ ...f.options, requestTimeoutMs: 10 });
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(20);
    expect(f.requests[0]!.signal?.aborted).toBe(true); expect(f.complete).not.toHaveBeenCalled();
    finish(reply()); await running;
    expect(f.complete.mock.calls[0]![0].subjects).toEqual([{ subject: 'candidate', outputs: [] }]);
  });

  it('drains cancelled inference and refuses publication after host shutdown', async () => {
    let finish!: (value: ModelResult) => void;
    const held = new Promise<ModelResult>(resolve => { finish = resolve; });
    const f = fixture({ complete: async () => held });
    const running = runSkillEvaluation(f.options);
    const outcome = expect(running).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    f.controller.abort(); expect(f.complete).not.toHaveBeenCalled();
    finish(reply()); await outcome;
    expect(f.complete).not.toHaveBeenCalled();
  });
});
