import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SkillCandidateReadResult, SkillRevisionSummary } from '@extalia/protocol';
import { DaemonRequestError, type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { createSkillCandidateReviewTools, normalizeSkillCandidateList, normalizeSkillCandidateRead, SKILL_REVIEW_OUTPUT_CHARS, type SkillCandidateReadPage } from '../src/skillCandidateReview.js';
import { normalizeSkillProposal, type SkillProposalProvenance } from '../src/skillLearning.js';
import { SKILL_REGISTRY_OPS, SkillRegistry } from '../src/skillRegistry.js';
import { runTool } from './helpers.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const revisionId = `skr_${'a'.repeat(64)}`;
const provenance: SkillProposalProvenance = { profileId: 'profile-one', workspaceId: 'w_example', sessionId: 's_read', runId: 'run_read', promptSha256: 'b'.repeat(64) };
const proposal = { name: 'review-checklist', description: 'Use when reviewing a small change.', instructions: 'Read the change and verify the expected result.' };
const shortSkill = `---\nname: ${proposal.name}\ndescription: ${proposal.description}\n---\n${proposal.instructions}\n`;

function fixture(files: Record<string, string> = { 'SKILL.md': shortSkill }) {
  let sequence = 0;
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const summary: SkillRevisionSummary = { packageId: proposal.name, revisionId, origin: 'generated', state: 'quarantined', stateReason: 'scanner-unavailable', version: '0.0.0+tree.fixture', treeSha256: 'a'.repeat(64), skillMdSha256: digest(files['SKILL.md']!), riskClass: 'declarative', manifestInferred: true, permissionDigest: 'c'.repeat(64), permissions: [], active: false, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };
  const client = { usable: true, capabilities: [...SKILL_REGISTRY_OPS, 'skill.reviewRead', 'learning.process'], request: async (op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'skill.list') return { revisions: [summary], indexGeneration: 0 };
    if (op === 'skill.reviewRead') {
      if (params.profileId !== provenance.profileId || params.workspaceId !== provenance.workspaceId) throw new DaemonRequestError('denied', 'candidate_scope_mismatch');
      const content = files[String(params.path)];
      if (content === undefined) throw new DaemonRequestError('not_found');
      return { revisionId, packageId: proposal.name, path: String(params.path), size: Buffer.byteLength(content), sha256: digest(content), content,
        skillMdSha256: summary.skillMdSha256, untrusted: true, reviewReceipt: digest(`read-${++sequence}`),
        provenance: { profileId: provenance.profileId!, workspaceId: provenance.workspaceId, sessionId: 's_original', promptSha256: 'd'.repeat(64) },
        referencePaths: Object.keys(files).filter(name => name.startsWith('references/')).sort(),
      } satisfies SkillCandidateReadResult;
    }
    if (op === 'learning.process') {
      if (params.action === 'skill.stage') return { action: 'skill.stage', stageId: 'stage', path: 'proposal-fixture' };
      if (params.action === 'skill.cleanup') return { action: 'skill.cleanup', released: true };
    }
    if (op === 'skill.import') return { packageId: proposal.name, revisionId, treeSha256: summary.treeSha256, version: summary.version, state: 'quarantined', created: false };
    if (op === 'skill.inspect') return { revision: summary, inspections: [], approvals: [], history: [], files: [], manifest: '{}' };
    throw new Error(`Unexpected fixture operation ${op}`);
  } } as unknown as DaemonClient;
  const registry = new SkillRegistry({ daemon: { connect: async () => client } as unknown as DaemonSidecar, dataDirectory: '/tmp/extalia-review-fixture', profile: 'default', workspaceRoot: () => '' });
  return { registry, calls, summary };
}

const refinement = (page: SkillCandidateReadPage) => ({ ...proposal, baseRevisionId: page.revisionId, baseSkillSha256: page.skillMdSha256, baseReadReceipt: page.reviewReceipt, refinementReason: 'Add the evidenced verification step.' });

describe('bounded candidate review and refinement admission', () => {
  it('keeps the nested Markdown schema strict and rejects executable or partial refinement input', () => {
    const valid = { ...proposal, references: [{ path: 'references/checks.md', content: ' Verify the result. ' }] };
    expect(normalizeSkillProposal(valid).references).toEqual([{ path: 'references/checks.md', content: 'Verify the result.' }]);
    for (const references of [
      [{ path: 'scripts/run.sh', content: 'echo no' }], [{ path: 'references/../file.md', content: 'no' }],
      [{ path: 'references/checks.md', content: 'a', executable: true }],
      [{ path: 'references/checks.md', content: 'a' }, { path: 'references/checks.md', content: 'b' }],
      [{ path: 'references/checks.md', content: '界'.repeat(5_462) }],
      ['a', 'b', 'c', 'd'].map(name => ({ path: `references/${name}.md`, content: 'x'.repeat(16 * 1024) })),
    ]) expect(() => normalizeSkillProposal({ ...proposal, references })).toThrow();
    for (const input of [{ ...proposal, baseRevisionId: revisionId }, { ...proposal, refinementReason: 'Incomplete base.' }, { ...proposal, baseReadReceipt: 'forged' }]) expect(() => normalizeSkillProposal(input)).toThrow();
    expect(() => normalizeSkillCandidateRead({ revisionId, profileId: 'profile-two' })).toThrow();
    expect(() => normalizeSkillCandidateRead({ revisionId, path: 'references/checks.md', offset: -1 })).toThrow();
    expect(() => normalizeSkillCandidateRead({ revisionId, limit: 1_201 })).toThrow();
    expect(() => normalizeSkillCandidateList({ limit: 9 })).toThrow();
  });

  it('does not turn discovery, a partial view or a reference read into SKILL.md read proof', async () => {
    const { registry, calls } = fixture({ 'SKILL.md': shortSkill, 'references/checks.md': 'Verify the output.' });
    const catalog = await registry.reviewCandidates(provenance, {});
    expect(catalog).toMatchObject({ untrusted: true, candidates: [{ revisionId, state: 'quarantined', active: false }] });
    expect(JSON.stringify(catalog)).not.toMatch(/reviewReceipt|content|promptSha256/);
    const reference = await registry.readCandidate(provenance, { revisionId, path: 'references/checks.md' });
    expect(reference.readComplete).toBe(true);
    await expect(registry.propose(refinement(reference), provenance)).rejects.toThrow(/every page/);
    const partial = await registry.readCandidate(provenance, { revisionId, limit: 10 });
    expect(partial.readComplete).toBe(false);
    await expect(registry.propose(refinement(partial), provenance)).rejects.toThrow(/every page/);
    expect(calls.some(call => call.op === 'skill.import' || call.op === 'learning.process')).toBe(false);
  });

  it('tracks only exposed Unicode pages, preserves JSON and refuses gaps until the full file and references are read', async () => {
    const content = `${shortSkill}${'🙂 Verify "result" before reuse.\n'.repeat(100)}`;
    const { registry, calls } = fixture({ 'SKILL.md': content, 'references/checks.md': 'Read the failure output before retrying.' });
    const first = await registry.readCandidate(provenance, { revisionId, limit: 120 });
    expect(first.totalChars).toBe(Array.from(content).length);
    expect(first.nextOffset).toBe(120);
    const last = await registry.readCandidate(provenance, { revisionId, offset: first.totalChars - 40 });
    expect(last.truncated).toBe(false); expect(last.readComplete).toBe(false);
    await expect(registry.propose(refinement(last), provenance)).rejects.toThrow(/every page/);
    let page = first;
    while (!page.readComplete) {
      page = await registry.readCandidate(provenance, { revisionId, offset: page.nextOffset! });
      const json = JSON.stringify(page);
      expect(json.length).toBeLessThanOrEqual(SKILL_REVIEW_OUTPUT_CHARS);
      expect(json.indexOf('reviewReceipt')).toBeLessThan(json.indexOf('"content"'));
      expect(JSON.parse(json).content).toBe(page.content);
      expect(page.content).toBe(Array.from(content).slice(page.offset, page.offset + Array.from(page.content).length).join(''));
    }
    await expect(registry.propose(refinement(page), provenance)).rejects.toThrow(/every existing Markdown reference/);
    await registry.readCandidate(provenance, { revisionId, path: 'references/checks.md' });
    expect(await registry.propose({ ...refinement(page), references: [{ path: 'references/checks.md', content: 'Read the failure output before retrying.' }] }, provenance)).toMatchObject({ created: false, activationPerformed: false });
    const imported = calls.find(call => call.op === 'skill.import')!;
    expect(imported.params).toMatchObject({ expectedBaseRevisionId: revisionId, expectedBaseSkillSha256: digest(content), learningProfileId: provenance.profileId, learningWorkspaceId: provenance.workspaceId });
    expect(calls.some(call => ['skill.approve', 'skill.activate', 'skill.review'].includes(call.op))).toBe(false);
  });

  it('binds receipts to the actual session, run, profile and workspace instead of a supplied model label', async () => {
    const { registry, calls } = fixture();
    const page = await registry.readCandidate(provenance, { revisionId });
    expect(page.readComplete).toBe(true);
    for (const changed of [
      { ...provenance, sessionId: 's_other' }, { ...provenance, runId: 'run_other' },
      { ...provenance, profileId: 'profile-two' }, { ...provenance, workspaceId: 'w_other' },
      { ...provenance, promptSha256: 'f'.repeat(64) },
    ]) await expect(registry.propose(refinement(page), changed)).rejects.toThrow(/every page/);
    await expect(registry.readCandidate({ ...provenance, profileId: 'profile-two' }, { revisionId })).rejects.toThrow();
    await expect(registry.readCandidate({ ...provenance, workspaceId: 'w_other' }, { revisionId })).rejects.toThrow();
    expect(await registry.reviewCandidates({ ...provenance, profileId: 'profile-two' })).toEqual({ untrusted: true, candidates: [], truncated: false });
    expect(calls.some(call => call.op === 'skill.import')).toBe(false);
  });

  it('rejects stale or cancelled host scope before any review callback executes', async () => {
    const list = vi.fn(), read = vi.fn();
    const tools = createSkillCandidateReviewTools({ provenance, list, read, assertCurrent: async () => { throw new Error('scope changed'); } });
    expect((await runTool(tools, 'skill_candidate_list', {})).ok).toBe(false);
    expect((await runTool(tools, 'skill_candidate_read', { revisionId })).ok).toBe(false);
    const cancelled = new AbortController(); cancelled.abort();
    expect((await runTool(tools, 'skill_candidate_read', { revisionId }, cancelled.signal)).ok).toBe(false);
    expect(list).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(tools.every(tool => tool.access === 'read' && tool.parallel !== true)).toBe(true);
  });

  it('does not expose data after an in-flight cancellation or scope retarget, and expires read authority', async () => {
    const { registry } = fixture();
    const cancellation = new AbortController();
    const cancelledTools = createSkillCandidateReviewTools({ provenance,
      list: async () => { cancellation.abort(); return { untrusted: true, candidates: [], truncated: false }; },
      read: input => registry.readCandidate(provenance, input),
    });
    expect((await runTool(cancelledTools, 'skill_candidate_list', {}, cancellation.signal)).ok).toBe(false);
    let retargeted = false;
    const tools = createSkillCandidateReviewTools({ provenance,
      assertCurrent: async () => { if (retargeted) throw new Error('retargeted'); },
      list: input => registry.reviewCandidates(provenance, input),
      read: async input => { const result = await registry.readCandidate(provenance, input); retargeted = true; return result; },
    });
    const output = await runTool(tools, 'skill_candidate_read', { revisionId });
    expect(output.ok).toBe(false); expect(output.output).not.toContain('reviewReceipt'); expect(output.output).not.toContain(proposal.instructions);
    const page = await registry.readCandidate(provenance, { revisionId });
    const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60_000);
    try { await expect(registry.propose(refinement(page), provenance)).rejects.toThrow(/every page/); } finally { clock.mockRestore(); }
  });
});
