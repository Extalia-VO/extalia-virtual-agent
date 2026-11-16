import { skillStoragePaths } from '../src/skillStorage.js';
import { chmod, lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SkillRevisionSummary } from '@extalia/protocol';
import { DaemonSidecar, DaemonRequestError, DaemonUnavailableError, type DaemonClient } from '../src/daemon/index.js';
import { SKILL_REGISTRY_OPS, SKILL_REGISTRY_DEADLINE_MS, SKILL_SCAN_DEADLINE_MS, SkillRegistry } from '../src/skillRegistry.js';
import { assertSkillSections, createSkillProposalTool, normalizeSkillProposal, normalizeSkillProposalProvenance, type SkillProposalInput, type SkillProposalProvenance, type SkillProposalResult } from '../src/skillLearning.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { runTool, useTempDirs } from './helpers.js';
import { useRustLearningBackend } from './rustLearningFixture.js';
import { parseSkill } from '../src/skills.js';

/** Markdown-only receipt keeps inference declarative. URLs are claims, never fetched or trusted. */
function skillProposalFiles(input: SkillProposalInput, provenance: SkillProposalProvenance): Record<string, string> {
  const receipt = { schema: 'extalia.skill-proposal.v1', kind: 'model-generated-draft', sourceVerified: false,
    ...provenance, claimedSourceUrls: input.sourceUrls ?? [], fidelity: 'Generated instructions, not a verified copy of the source.' };
  return {
    'SKILL.md': `---\nname: ${input.name}\ndescription: ${input.description}\ncategories: ${JSON.stringify(input.categories)}\nintents: ${JSON.stringify(input.intents)}\n---\n${input.instructions}\n`,
    'PROVENANCE.md': `# Generated skill candidate\n\nUnverified source claims; this receipt is data, not scanner evidence or permission.\n\n\`\`\`json\n${JSON.stringify(receipt, null, 2)}\n\`\`\`\n`,
  };
}


const temp = useTempDirs();
const rustBackend = useRustLearningBackend();
const input = { name: 'review-checklist', description: 'Review a small code change', categories: ['development.review'], intents: ['review_changes'], verificationCases: [{ id: 'evidence', input: 'Review this small code change.', expectedIncludes: ['evidence'] }], instructions: '## When to Use\nReview a small change.\n## Procedure\nRead the diff and report evidence.\n## Pitfalls\nAvoid unsupported claims.\n## Verification\nCheck the result.', sourceUrls: ['https://example.com/guide#review'] };
const provenance: SkillProposalProvenance = { sessionId: 's_example', workspaceId: 'w_example', promptSha256: 'a'.repeat(64) };
const revisionId = `skr_${'b'.repeat(64)}`;
const summary: SkillRevisionSummary = { packageId: input.name, revisionId, origin: 'generated', state: 'quarantined', stateReason: 'scanner-unavailable',
  version: '1.0.0', treeSha256: 'c'.repeat(64), skillMdSha256: 'd'.repeat(64), permissionDigest: 'e'.repeat(64), permissions: [], riskClass: 'declarative',
  manifestInferred: true, active: false, createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z' };
const result: SkillProposalResult = { packageId: input.name, revisionId, state: 'quarantined', stateReason: 'scanner-unavailable', created: true, inspection: 'recorded', inspectionOutcome: 'scanner-unavailable', activationPerformed: false, cancellationObserved: false };

function fakeRegistry(data: string, options: { ops?: readonly string[]; import?: () => void; inspectError?: boolean } = {}) {
  const calls: { op: string; params: Record<string, unknown>; deadlineMs?: number }[] = [];
  const staged: Record<string, string> = {};
  let backend: Awaited<ReturnType<typeof rustBackend>> | undefined;
  const client = {
    usable: true,
    capabilities: options.ops ?? [...SKILL_REGISTRY_OPS, 'learning.process'],
    request: async (op: string, params: Record<string, unknown>, deadlineMs?: number) => {
      if (op === 'learning.process') {
        backend ??= await rustBackend(data);
        return backend.process(params.action as Parameters<typeof backend.process>[0], params.input as never);
      }
      calls.push({ op, params, ...(deadlineMs === undefined ? {} : { deadlineMs }) });
      if (op === 'skill.import') {
        const folder = path.join(skillStoragePaths(data).imports, String(params.path));
        for (const file of await readdir(folder)) staged[file] = await readFile(path.join(folder, file), 'utf8');
        options.import?.();
        return { packageId: input.name, revisionId, treeSha256: summary.treeSha256, version: '1.0.0', state: 'quarantined', stateReason: 'scanner-unavailable', created: true };
      }
      if (op === 'skill.inspect') {
        if (options.inspectError) throw new Error('synthetic inspection transport loss');
        return { revision: summary, inspections: [{ inspectionId: 1, outcome: 'scanner-unavailable' }], approvals: [], history: [], consent: [], files: [], manifest: '{}' };
      }
      throw new Error(`unexpected ${op}`);
    },
  } as unknown as DaemonClient;
  const daemon = { connect: async () => client } as unknown as DaemonSidecar;
  return { registry: new SkillRegistry({ daemon, dataDirectory: data, profile: 'default', workspaceRoot: () => { throw new Error('unused'); } }), calls, staged };
}

describe.skipIf(process.platform === 'win32')('generated skill candidates from an explicitly requested user turn', () => {
  it('requires persisted organization, literal test fixtures and all four populated prose sections', () => {
    expect(normalizeSkillProposal(input)).toMatchObject({ categories: ['development.review'], intents: ['review_changes'], verificationCases: input.verificationCases });
    for (const change of [
      { categories: undefined }, { categories: [] }, { categories: ['development review'] }, { categories: ['finance\n'] },
      { intents: undefined }, { intents: ['review changes'] }, { intents: ['review_changes\n'] }, { intents: ['review_changes', 'review_changes'] },
      { verificationCases: [] }, { verificationCases: [{ ...input.verificationCases[0], passed: true }] },
      { verificationCases: [{ ...input.verificationCases[0], forbiddenIncludes: ['evidence'] }] },
      { instructions: input.instructions.replace('## Pitfalls\nAvoid unsupported claims.', '## Pitfalls') },
      { instructions: '```markdown\n' + input.instructions + '\n```' },
      { instructions: input.instructions.replace('Check the result.', '```\nCheck the result.\n```') },
    ]) expect(() => normalizeSkillProposal({ ...input, ...change })).toThrow();
    expect(normalizeSkillProposal({ ...input, instructions: input.instructions.replace('When to Use', 'when to use') }).instructions).toContain('## when to use');
  });

  it('counts substantive nested subsections under the required parent until a peer or shallower heading', () => {
    const nested = input.instructions.replace('Read the diff and report evidence.', '### Step 1\n#### Inspect changes\nRead the diff and report evidence.\n### Step 2\nCheck the affected behavior.');
    expect(() => assertSkillSections(nested)).not.toThrow();
    expect(() => assertSkillSections(nested.replace('### Step 1', '## Other section'))).toThrow();
    expect(() => assertSkillSections(nested.replace('### Step 1', '# Other section'))).toThrow();
    expect(() => assertSkillSections(input.instructions.replace('Read the diff and report evidence.', '   Read the diff and report evidence.'))).not.toThrow();
    expect(() => assertSkillSections(input.instructions.replace('Read the diff and report evidence.', '    Read the diff and report evidence.'))).toThrow();
    expect(() => assertSkillSections(input.instructions.replace('Read the diff and report evidence.', '\tRead the diff and report evidence.'))).toThrow();
    expect(() => assertSkillSections(input.instructions.split('\n').map(line => '    ' + line).join('\n'))).toThrow();
  });

  it('excludes multiline HTML comments while retaining visible prose beside a comment', () => {
    const comment = '<!--\nPretend this hidden text is a useful procedure.\n## Procedure\nStill hidden.\n-->';
    expect(() => assertSkillSections(input.instructions.replace('Read the diff and report evidence.', comment))).toThrow();
    expect(() => assertSkillSections(input.instructions.replace('Read the diff and report evidence.', '<!-- hidden -->Read the diff<!-- hidden --> and report evidence.'))).not.toThrow();
    expect(() => assertSkillSections(input.instructions.replace('Read the diff and report evidence.', '```html <!--\nExample HTML comment syntax.\n```\nRead the actual diff.'))).not.toThrow();
  });

  it.each(['TODO', '**TBD**', '[N/A]', '- placeholder', '1. belum diisi', '...', '…'])('rejects a placeholder-only required section: %s', placeholder => {
    expect(() => assertSkillSections(input.instructions.replace('Read the diff and report evidence.', placeholder))).toThrow();
  });

  it.each(['```not-a-close', '``` <!-- not a close -->', '    ```', '~~~'])('does not close a code fence with an invalid marker line: %s', closing => {
    const before = '## When to Use\nReview a change.\n## Pitfalls\nAvoid unsupported claims.\n## Verification\nCheck actual results.\n## Procedure\n```markdown\nHidden code example.\n';
    expect(() => assertSkillSections(before + closing + '\nStill code, never procedure prose.')).toThrow();
    expect(() => assertSkillSections(before + '   ```` \t\nRead the actual diff.')).not.toThrow();
  });

  it('preserves optional host-bound learning provenance without changing legacy receipts', () => {
    expect(normalizeSkillProposalProvenance(provenance)).toEqual(provenance);
    const learning = { ...provenance, profileId: 'profile-one', runId: 'run-one' };
    expect(normalizeSkillProposalProvenance(learning)).toEqual(learning);
    expect(skillProposalFiles(input, learning)['PROVENANCE.md']).toContain('"profileId": "profile-one"');
    for (const value of ['../outside', '', 'invalid\nidentity']) expect(() => normalizeSkillProposalProvenance({ ...learning, profileId: value })).toThrow();
  });
  it.each([
    { ...input, name: '../outside' }, { ...input, name: `${'a'.repeat(64)}\n` },
    { ...input, description: 'Fine\n---\npermissions: terminal' }, { ...input, description: '\u202eHidden' },
    { ...input, instructions: '' }, { ...input, instructions: 'x'.repeat(65_537) }, { ...input, instructions: '界'.repeat(21_846) },
    { ...input, instructions: 'Look\u0000hidden' }, { ...input, sourceUrls: ['file:///etc/hosts'] },
    { ...input, sourceUrls: ['https://user:secret@example.com/'] }, { ...input, sourceUrls: ['https://example.com/?token=opaque'] },
    { ...input, sourceUrls: Array(9).fill('https://example.com/') }, { ...input, verified: true }, { ...input, path: '/projects/example' },
  ])('refuses invalid candidates before creating staging files: %j', async candidate => {
    const data = path.join(await temp(), 'data'); const { registry, calls } = fakeRegistry(data);
    await expect(registry.propose(candidate, provenance)).rejects.toThrow();
    expect(calls).toEqual([]); await expect(lstat(data)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(!HAS_DAEMON)('stages only generated markdown and host-bound provenance, imports, then reports inspection without activation', async () => {
    const data = path.join(await temp(), 'data'); const { registry, calls, staged } = fakeRegistry(data);
    const proposed = await registry.propose(input, provenance);
    expect(proposed).toMatchObject(result);
    expect(calls.map(call => call.op)).toEqual(['skill.import', 'skill.inspect']);
    expect(calls[0]?.deadlineMs).toBe(SKILL_SCAN_DEADLINE_MS);
    expect(calls[1]?.deadlineMs).toBe(SKILL_REGISTRY_DEADLINE_MS);
    expect(calls[0]!.params).toMatchObject({ origin: 'generated', sourceRef: `prompt:s_example:${provenance.promptSha256}` });
    expect(calls[0]!.params.path).toMatch(/^proposal-[0-9a-f]{32}$/);
    expect(Object.keys(staged).sort()).toEqual(['PROVENANCE.md', 'SKILL.md', 'TESTS.json', 'extalia-skill.json']);
    expect(staged['SKILL.md']).toBe(skillProposalFiles(normalizeSkillProposal(input), provenance)['SKILL.md']);
    expect(parseSkill(staged['SKILL.md']!, input.name, 'generated')).toMatchObject({ categories: input.categories, intents: input.intents });
    expect(JSON.parse(staged['extalia-skill.json']!)).toMatchObject({ categories: input.categories, intents: input.intents, risk_class: 'declarative' });
    expect(JSON.parse(staged['TESTS.json']!)).toEqual({ schema: 'extalia.skill-verification.v1', cases: input.verificationCases });
    expect(staged['PROVENANCE.md']).toContain('"sourceVerified": false');
    expect(staged['PROVENANCE.md']).toContain('"promptSha256": "' + provenance.promptSha256 + '"');
    expect(staged['PROVENANCE.md']).toContain(input.sourceUrls[0]);
    expect(await readdir(skillStoragePaths(data).imports)).toEqual([]);
  });

  it('refuses unsupported/offline registry and cancelled requests before writing', async () => {
    for (const mode of ['off', 'old', 'cancelled', 'provenance'] as const) {
      const data = path.join(await temp(), 'data');
      const { registry: available, calls } = fakeRegistry(data, { ops: mode === 'old' ? [] : undefined });
      const registry = mode === 'off' ? new SkillRegistry({ daemon: undefined, dataDirectory: data, profile: 'default', workspaceRoot: () => '' }) : available;
      const controller = new AbortController(); if (mode === 'cancelled') controller.abort();
      await expect(registry.propose(input, mode === 'provenance' ? { ...provenance, promptSha256: 'forged' } : provenance, controller.signal)).rejects.toThrow();
      expect(calls).toEqual([]); await expect(lstat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it.skipIf(!HAS_DAEMON)('still inspects an acknowledged import after cancellation and does not claim rollback', async () => {
    const controller = new AbortController();
    const { registry, calls } = fakeRegistry(await temp(), { import: () => controller.abort() });
    expect(await registry.propose(input, provenance, controller.signal)).toMatchObject({ ...result, cancellationObserved: true });
    expect(calls.map(call => call.op)).toEqual(['skill.import', 'skill.inspect']);
  });

  it.skipIf(!HAS_DAEMON)('fails closed on offline connect without writing, and cleans staged files after an uncertain import failure', async () => {
    const data = path.join(await temp(), 'data');
    const offline = new SkillRegistry({ daemon: { connect: async () => { throw new DaemonUnavailableError('crashed'); } } as unknown as DaemonSidecar,
      dataDirectory: data, profile: 'default', workspaceRoot: () => '' });
    await expect(offline.propose(input, provenance)).rejects.toThrow(/unavailable/);
    await expect(lstat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    const { registry, calls, staged } = fakeRegistry(data, { import: () => { throw new Error('synthetic lost import acknowledgement'); } });
    await expect(registry.propose(input, provenance)).rejects.toThrow('synthetic lost import acknowledgement');
    expect(Object.keys(staged)).toHaveLength(4); expect(calls.map(call => call.op)).toEqual(['skill.import']);
    expect(await readdir(skillStoragePaths(data).imports)).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('retains the acknowledged import state when inspection transport fails, without claiming scanner success', async () => {
    const data = await temp(); const { registry } = fakeRegistry(data, { inspectError: true });
    const proposed = await registry.propose(input, provenance);
    expect(proposed).toMatchObject({ state: 'quarantined', inspection: 'unavailable', activationPerformed: false, created: true });
    expect(proposed.inspectionOutcome).toBeUndefined();
    expect(await readdir(skillStoragePaths(data).imports)).toEqual([]);
  });

  it('is a non-parallel write tool, rejects forged fields before effect and admits only one concurrent attempt', async () => {
    let release!: (value: SkillProposalResult) => void;
    const propose = vi.fn(() => new Promise<SkillProposalResult>(resolve => { release = resolve; }));
    const tool = createSkillProposalTool({ provenance, propose });
    expect(tool.access).toBe('write'); expect(tool.parallel).not.toBe(true);
    expect((await runTool([tool], 'skill_propose', { ...input, active: true })).ok).toBe(false); expect(propose).not.toHaveBeenCalled();
    const pending = runTool([tool], 'skill_propose', input);
    expect((await runTool([tool], 'skill_propose', input)).ok).toBe(false);
    release(result); const finished = await pending;
    expect(finished.ok).toBe(true); expect(JSON.parse(finished.output)).toMatchObject({ inspectionOutcome: 'scanner-unavailable', activationPerformed: false });
    expect(propose).toHaveBeenCalledExactlyOnceWith(input, provenance, expect.any(AbortSignal));
  });

  it('pins provenance and revalidates host scope before persistence, with cancellation after the scope read', async () => {
    const controller = new AbortController();
    const original = { ...provenance, profileId: 'profile-one' };
    const propose = vi.fn(async () => result);
    const assertCurrent = vi.fn(async () => { controller.abort(); });
    const tool = createSkillProposalTool({ provenance: original, assertCurrent, propose });
    original.profileId = 'profile-two';
    const response = await runTool([tool], 'skill_propose', input, controller.signal);
    expect(response.ok).toBe(false); expect(response.output).toContain('Cancelled before');
    expect(assertCurrent).toHaveBeenCalledTimes(1); expect(propose).not.toHaveBeenCalled();
  });

  it('fails closed on unavailable scope without exposing diagnostics or retrying the write', async () => {
    const propose = vi.fn(async () => result);
    const assertCurrent = vi.fn(async () => { throw new Error('private profile path'); });
    const tool = createSkillProposalTool({ provenance: { ...provenance, profileId: 'profile-one' }, assertCurrent, propose });
    const response = await runTool([tool], 'skill_propose', input);
    expect(response.ok).toBe(false); expect(response.output).toContain('profile changed or could not be confirmed');
    expect(response.output).not.toContain('private profile path');
    expect((await runTool([tool], 'skill_propose', input)).ok).toBe(false);
    expect(assertCurrent).toHaveBeenCalledTimes(1); expect(propose).not.toHaveBeenCalled();
  });

  it('reports known immutable-refinement refusals without copying arbitrary owner diagnostics', async () => {
    const stale = createSkillProposalTool({ provenance, propose: async () => {
      throw new Error('private native details', { cause: new DaemonRequestError('denied', 'refinement_base_changed') });
    } });
    const rejected = await runTool([stale], 'skill_propose', input);
    expect(rejected.ok).toBe(false); expect(rejected.output).toContain('Review the current candidate');
    expect(rejected.output).not.toContain('private native details');
    const unknown = createSkillProposalTool({ provenance, propose: async () => { throw new Error('private source path and content'); } });
    const uncertain = await runTool([unknown], 'skill_propose', input);
    expect(uncertain.output).toContain('may have been recorded'); expect(uncertain.output).not.toContain('private source');
  });

  it('submits the captured profile provenance after successful scope confirmation', async () => {
    const original = { ...provenance, profileId: 'profile-one' };
    const propose = vi.fn(async () => result);
    const assertCurrent = vi.fn(async () => undefined);
    const tool = createSkillProposalTool({ provenance: original, assertCurrent, propose });
    original.profileId = 'profile-two';
    expect((await runTool([tool], 'skill_propose', input)).ok).toBe(true);
    expect(propose).toHaveBeenCalledWith(input, { ...provenance, profileId: 'profile-one' }, expect.any(AbortSignal));
    expect(assertCurrent).toHaveBeenCalledTimes(1);
  });

  it('does not retry an uncertain imported candidate automatically or expose transport exception text', async () => {
    const propose = vi.fn(async () => { throw new Error('sensitive transport diagnostics'); });
    const tool = createSkillProposalTool({ provenance, propose });
    const first = await runTool([tool], 'skill_propose', input); const second = await runTool([tool], 'skill_propose', input);
    expect(first.ok).toBe(false); expect(first.output).toContain('may have been recorded'); expect(first.output).not.toContain('sensitive');
    expect(second.ok).toBe(false); expect(propose).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!HAS_DAEMON)('persists a real generated candidate in the library, records scanner-unavailable and offers no active instructions', async () => {
    const data = await temp();
    const daemon = new DaemonSidecar({ binary: () => DAEMON_BINARY, dataDirectory: data, profile: 'default', clientVersion: 'test', env: {}, log: () => {} });
    const registry = new SkillRegistry({ daemon, dataDirectory: data, profile: 'default', workspaceRoot: () => '' });
    try {
      const proposed = await registry.propose(input, { ...provenance, profileId: 'default' });
      expect(proposed).toMatchObject({ packageId: input.name, state: 'quarantined', stateReason: 'scanner-unavailable', inspection: 'recorded', inspectionOutcome: 'scanner-unavailable', activationPerformed: false });
      const listed = await registry.report();
      expect(listed.revisions).toHaveLength(1);
      expect(listed.revisions[0]).toMatchObject({ packageId: input.name, origin: 'generated', state: 'quarantined', active: false, riskClass: 'declarative', permissions: [] });
      const details = await registry.inspect(proposed.revisionId);
      expect(details.files.map(file => file.path).sort()).toEqual(['PROVENANCE.md', 'SKILL.md', 'TESTS.json', 'extalia-skill.json']);
      expect(details.approvals).toEqual([]); expect(await registry.activeSkills()).toEqual([]);
    } finally { await daemon.stop(); await unlockFixture(data); }
  });
});

async function unlockFixture(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined); if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(directory, 0o700); for (const file of await readdir(directory)) await unlockFixture(path.join(directory, file));
  } else await chmod(directory, 0o600);
}
