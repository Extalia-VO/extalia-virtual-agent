import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EventBody } from '@extalia/protocol';
import type { ModelProvider, ModelRequest, ModelResult } from '@extalia/runtime';
import { DaemonSidecar } from '../src/daemon/index.js';
import { runAutomaticLearning } from '../src/automaticLearning.js';
import { createSkillCandidateReviewTools, type SkillCandidateListResult, type SkillCandidateReadPage } from '../src/skillCandidateReview.js';
import { type SkillProposalInput, type SkillProposalProvenance } from '../src/skillLearning.js';
import { SkillRegistry } from '../src/skillRegistry.js';
import { RustLearningBackend } from '../src/rustLearning.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const evidenceId = 'validation-result';
const packageId = 'validate-record';
const referencePath = 'references/order.md';
const instructions = (corrected: boolean) => `## When to Use\nUse before saving records.\n\n## Procedure\n${corrected ? '1. Validate input.\n2. Save valid records.' : '1. Save records.\n2. Validate input.'}\n\n## Pitfalls\nDo not assume input validity.\n\n## Verification\nReject invalid input. See [ordering](references/order.md).`;
const proposal = (corrected = false): SkillProposalInput => ({ name: packageId,
  description: 'Use when validating and saving records.', instructions: instructions(corrected),
  references: [{ path: referencePath, content: corrected ? '# Ordering\nValidate before saving; rejected input creates no record.' : '# Ordering\nThe initial draft saves before validating.' }] });
const response = (name: string, input: Record<string, unknown>, call: number): ModelResult => ({
  text: '', stop: 'tool_use', toolCalls: [{ id: `call-${call}`, name, input }], usage: { inputTokens: 120, outputTokens: 100 },
});
function toolData<T>(request: ModelRequest, name: string): T {
  const last = request.messages.at(-1);
  expect(last?.role).toBe('tool');
  if (last?.role !== 'tool') throw new Error('Expected the actual model-visible read response.');
  const result = last.results.find(item => item.name === name);
  expect(result?.isError).toBe(false);
  expect(result?.content.length).toBeLessThanOrEqual(2000);
  return JSON.parse(result!.content) as T;
}
async function unlock(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(directory, 0o700);
    for (const file of await readdir(directory)) await unlock(path.join(directory, file));
  } else await chmod(directory, 0o600);
}

async function fixture() {
  const root = await temp(), data = path.join(root, 'data');
  await mkdir(data);
  const daemon = new DaemonSidecar({ binary: () => DAEMON_BINARY, dataDirectory: data, profile: 'default', clientVersion: 'test', env: {}, log: () => undefined });
  const registry = new SkillRegistry({ daemon, dataDirectory: data, profile: 'default', workspaceRoot: () => '' });
  const backend = new RustLearningBackend(() => daemon.connect());
  const provenance = (run: string): SkillProposalProvenance => ({ profileId: 'profile-one', workspaceId: 'w_example', sessionId: `s_${run}`,
    runId: `run-${run}`, promptSha256: 'a'.repeat(64) });
  const run = async (id: string, next: (request: ModelRequest, call: number) => ModelResult) => {
    const source = provenance(id), events: EventBody[] = [], requests: ModelRequest[] = [];
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async request => {
      requests.push(request); return next(request, requests.length);
    } };
    const proposeSkill = vi.fn((input: SkillProposalInput, current: SkillProposalProvenance, signal: AbortSignal) => registry.propose(input, current, signal));
    const tools = createSkillCandidateReviewTools({ provenance: source,
      list: input => registry.reviewCandidates(source, input), read: input => registry.readCandidate(source, input) });
    const result = await runAutomaticLearning({ backend, profileId: source.profileId!, revision: 'profile-revision-one', workspaceId: source.workspaceId,
      sessionId: source.sessionId, runId: source.runId!, promptSha256: source.promptSha256,
      policy: { enabled: true, skills: true, notes: false }, provider, tools, signal: new AbortController().signal,
      assertCurrent: async () => undefined, emit: event => { events.push(event); }, proposeSkill,
      result: { outcome: 'completed', history: [], usage: {} },
      currentTurnEvidence: [{ toolCallId: evidenceId, name: 'test_validation', content: 'Synthetic validation case: invalid input must be rejected before any record is saved.', isError: false }],
    });
    expect(requests.length).toBeLessThanOrEqual(6);
    expect(events.filter(event => event.type === 'tool.started').length).toBeLessThanOrEqual(8);
    return { result, requests, events, proposeSkill, source };
  };
  return { registry, daemon, provenance, run, close: async () => { await daemon.stop(); await unlock(data); } };
}

/** Real curator, registry, immutable package bytes and scanner refusal; only the model is scripted. */
describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('generated skill refinement across sessions', () => {
  it('creates, reviews and revises one class skill with its reference, then discovers the corrected revision', async () => {
    const f = await fixture();
    try {
      const first = await f.run('first', (request, call) => {
        if (call === 1) return response('skill_candidate_list', { query: packageId }, call);
        expect(toolData<SkillCandidateListResult>(request, 'skill_candidate_list').candidates).toEqual([]);
        return response('submit_learning', { title: 'Validation ordering draft', lesson: 'Maintain a reusable validation procedure.', evidenceIds: [evidenceId], skill: proposal() }, call);
      });
      expect(first.result).toMatchObject({ outcome: 'completed', note: { status: 'skipped' }, skill: { status: 'recorded', receipt: {
        packageId, state: 'quarantined', stateReason: 'scanner-unavailable', activationPerformed: false,
      } } });
      const initialId = first.result.skill.receipt!.revisionId;
      expect(first.proposeSkill).toHaveBeenCalledTimes(1);
      let base: SkillCandidateReadPage | undefined;
      const second = await f.run('second', (request, call) => {
        if (call === 1) return response('skill_candidate_list', { query: packageId }, call);
        if (call === 2) {
          const listed = toolData<SkillCandidateListResult>(request, 'skill_candidate_list');
          expect(listed).toMatchObject({ untrusted: true, candidates: [{ packageId, revisionId: initialId, state: 'quarantined', active: false }] });
          return response('skill_candidate_read', { revisionId: listed.candidates[0]!.revisionId }, call);
        }
        if (call === 3) {
          base = toolData<SkillCandidateReadPage>(request, 'skill_candidate_read');
          expect(base).toMatchObject({ path: 'SKILL.md', readComplete: true, untrusted: true, referencePaths: [referencePath] });
          expect(base.content).toContain('1. Save records.');
          return response('skill_candidate_read', { revisionId: base.revisionId, path: referencePath }, call);
        }
        const reference = toolData<SkillCandidateReadPage>(request, 'skill_candidate_read');
        expect(reference).toMatchObject({ path: referencePath, readComplete: true, untrusted: true });
        expect(reference.content).toContain('saves before validating');
        return response('submit_learning', { title: 'Correct validation ordering', lesson: 'Invalid inputs must be rejected before writes.', evidenceIds: [evidenceId],
          skill: { ...proposal(true), baseRevisionId: base!.revisionId, baseSkillSha256: base!.skillMdSha256,
            baseReadReceipt: base!.reviewReceipt, refinementReason: 'The validation evidence requires rejecting invalid input before saving.' } }, call);
      });
      expect(second.result).toMatchObject({ outcome: 'completed', skill: { status: 'recorded', receipt: { packageId, created: true, activationPerformed: false } } });
      const revisedId = second.result.skill.receipt!.revisionId;
      expect(revisedId).not.toBe(initialId);
      expect(second.proposeSkill).toHaveBeenCalledTimes(1);
      expect(second.proposeSkill.mock.calls[0]![1]).toEqual(second.source);
      expect(second.requests).toHaveLength(4);
      const third = await f.run('third', (request, call) => {
        if (call === 1) return response('skill_candidate_list', { query: packageId }, call);
        if (call === 2) {
          const listed = toolData<SkillCandidateListResult>(request, 'skill_candidate_list');
          expect(listed.candidates.map(item => item.revisionId)).toEqual([revisedId]);
          return response('skill_candidate_read', { revisionId: listed.candidates[0]!.revisionId }, call);
        }
        if (call === 3) {
          const read = toolData<SkillCandidateReadPage>(request, 'skill_candidate_read');
          expect(read).toMatchObject({ revisionId: revisedId, path: 'SKILL.md', readComplete: true, untrusted: true });
          expect(read.content).toContain('1. Validate input.\n2. Save valid records.');
          return response('skill_candidate_read', { revisionId: read.revisionId, path: referencePath }, call);
        }
        const read = toolData<SkillCandidateReadPage>(request, 'skill_candidate_read');
        expect(read.content).toContain('Validate before saving; rejected input creates no record.');
        return response('submit_learning', { skipReason: 'The latest candidate already preserves the correction; no additional revision.' }, call);
      });
      expect(third.result.outcome).toBe('skipped');
      expect(third.proposeSkill).not.toHaveBeenCalled();
      const report = await f.registry.report();
      expect(report.revisions).toHaveLength(2);
      expect(report.revisions.every(item => !item.active && item.state === 'quarantined')).toBe(true);
      expect(await f.registry.activeSkills()).toEqual([]);
      // Curators review the current head only. Historical bytes remain available to
      // human inspection without becoming stale automated-refinement authority.
      await expect(f.registry.readCandidate(third.source, { revisionId: initialId })).rejects.toMatchObject({ reason: 'candidate_not_latest' });
      const old = await f.registry.inspect(initialId);
      expect(old.instructions).toBe(base!.content);
      expect(old.revision.skillMdSha256).toBe(base!.sha256);
      const details = await f.registry.inspect(revisedId);
      expect(details.files.map(file => file.path).sort()).toEqual(['PROVENANCE.md', 'SKILL.md', referencePath]);
      expect(details.approvals).toEqual([]);
      const client = await f.daemon.connect();
      const lineage = await client.request('skill.reviewRead', { revisionId: revisedId, path: 'PROVENANCE.md', profileId: third.source.profileId!, workspaceId: third.source.workspaceId });
      expect(lineage.content).toContain(initialId);
      expect(lineage.content).toContain(base!.skillMdSha256);
      expect(lineage.content).toContain('rejecting invalid input before saving');
    } finally { await f.close(); }
  });

  it('rejects a model-forged review receipt before any revision is staged or imported', async () => {
    const f = await fixture();
    try {
      const original = await f.registry.propose(proposal(), f.provenance('seed'));
      const details = await f.registry.inspect(original.revisionId);
      const forged = await f.run('forged', (_request, call) => response('submit_learning', {
        title: 'Unreviewed refinement', lesson: 'Validate before saving.', evidenceIds: [evidenceId],
        skill: { ...proposal(true), baseRevisionId: original.revisionId, baseSkillSha256: details.revision.skillMdSha256,
          baseReadReceipt: '0'.repeat(64), refinementReason: 'The model claims it already reviewed the package.' },
      }, call));
      expect(forged.result.outcome).toBe('failed');
      expect(forged.result.reason).toContain('unreviewed_skill_refinement');
      expect(forged.requests).toHaveLength(2);
      expect(forged.proposeSkill).not.toHaveBeenCalled();
      expect((await f.registry.report()).revisions.map(item => item.revisionId)).toEqual([original.revisionId]);
      expect(await f.registry.activeSkills()).toEqual([]);
    } finally { await f.close(); }
  });
});
