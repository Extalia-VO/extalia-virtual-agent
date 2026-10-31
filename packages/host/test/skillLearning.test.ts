import { chmod, lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SkillRevisionSummary } from '@extalia/protocol';
import { DaemonSidecar, DaemonUnavailableError, type DaemonClient } from '../src/daemon/index.js';
import { SKILL_REGISTRY_OPS, SkillRegistry } from '../src/skillRegistry.js';
import { createSkillProposalTool, normalizeSkillProposal, skillProposalFiles, type SkillProposalProvenance, type SkillProposalResult } from '../src/skillLearning.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { runTool, useTempDirs } from './helpers.js';

const temp = useTempDirs();
const input = { name: 'review-checklist', description: 'Review a small code change', instructions: 'Read the diff and report evidence.', sourceUrls: ['https://example.com/guide#review'] };
const provenance: SkillProposalProvenance = { sessionId: 's_example', workspaceId: 'w_example', promptSha256: 'a'.repeat(64) };
const revisionId = `skr_${'b'.repeat(64)}`;
const summary: SkillRevisionSummary = { packageId: input.name, revisionId, origin: 'generated', state: 'quarantined', stateReason: 'scanner-unavailable',
  version: '1.0.0', treeSha256: 'c'.repeat(64), skillMdSha256: 'd'.repeat(64), permissionDigest: 'e'.repeat(64), permissions: [], riskClass: 'declarative',
  manifestInferred: true, active: false, createdAt: '2026-10-31T00:00:00Z', updatedAt: '2026-10-31T00:00:00Z' };
const result: SkillProposalResult = { packageId: input.name, revisionId, state: 'quarantined', stateReason: 'scanner-unavailable', created: true, inspection: 'recorded', inspectionOutcome: 'scanner-unavailable', activationPerformed: false, cancellationObserved: false };

function fakeRegistry(data: string, options: { ops?: readonly string[]; import?: () => void; inspectError?: boolean } = {}) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const staged: Record<string, string> = {};
  const client = {
    capabilities: options.ops ?? SKILL_REGISTRY_OPS,
    request: async (op: string, params: Record<string, unknown>) => {
      calls.push({ op, params });
      if (op === 'skill.import') {
        const folder = path.join(data, 'profiles', 'default', 'skill-imports', String(params.path));
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

describe('generated skill candidates from an explicitly requested user turn', () => {
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

  it('stages only generated markdown and host-bound provenance, imports, then reports inspection without activation', async () => {
    const data = path.join(await temp(), 'data'); const { registry, calls, staged } = fakeRegistry(data);
    const proposed = await registry.propose(input, provenance);
    expect(proposed).toMatchObject(result);
    expect(calls.map(call => call.op)).toEqual(['skill.import', 'skill.inspect']);
    expect(calls[0]!.params).toMatchObject({ origin: 'generated', sourceRef: `prompt:s_example:${provenance.promptSha256}` });
    expect(calls[0]!.params.path).toMatch(/^proposal-[0-9a-f]{32}$/);
    expect(Object.keys(staged).sort()).toEqual(['PROVENANCE.md', 'SKILL.md']);
    expect(staged['SKILL.md']).toBe(skillProposalFiles(normalizeSkillProposal(input), provenance)['SKILL.md']);
    expect(staged['PROVENANCE.md']).toContain('"sourceVerified": false');
    expect(staged['PROVENANCE.md']).toContain('"promptSha256": "' + provenance.promptSha256 + '"');
    expect(staged['PROVENANCE.md']).toContain(input.sourceUrls[0]);
    expect(await readdir(path.join(data, 'profiles', 'default', 'skill-imports'))).toEqual([]);
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

  it('still inspects an acknowledged import after cancellation and does not claim rollback', async () => {
    const controller = new AbortController();
    const { registry, calls } = fakeRegistry(await temp(), { import: () => controller.abort() });
    expect(await registry.propose(input, provenance, controller.signal)).toMatchObject({ ...result, cancellationObserved: true });
    expect(calls.map(call => call.op)).toEqual(['skill.import', 'skill.inspect']);
  });

  it('fails closed on offline connect without writing, and cleans staged files after an uncertain import failure', async () => {
    const data = path.join(await temp(), 'data');
    const offline = new SkillRegistry({ daemon: { connect: async () => { throw new DaemonUnavailableError('crashed'); } } as unknown as DaemonSidecar,
      dataDirectory: data, profile: 'default', workspaceRoot: () => '' });
    await expect(offline.propose(input, provenance)).rejects.toThrow(/unavailable/);
    await expect(lstat(data)).rejects.toMatchObject({ code: 'ENOENT' });
    const { registry, calls, staged } = fakeRegistry(data, { import: () => { throw new Error('synthetic lost import acknowledgement'); } });
    await expect(registry.propose(input, provenance)).rejects.toThrow('synthetic lost import acknowledgement');
    expect(Object.keys(staged)).toHaveLength(2); expect(calls.map(call => call.op)).toEqual(['skill.import']);
    expect(await readdir(path.join(data, 'profiles', 'default', 'skill-imports'))).toEqual([]);
  });

  it('retains the acknowledged import state when inspection transport fails, without claiming scanner success', async () => {
    const data = await temp(); const { registry } = fakeRegistry(data, { inspectError: true });
    const proposed = await registry.propose(input, provenance);
    expect(proposed).toMatchObject({ state: 'quarantined', inspection: 'unavailable', activationPerformed: false, created: true });
    expect(proposed.inspectionOutcome).toBeUndefined();
    expect(await readdir(path.join(data, 'profiles', 'default', 'skill-imports'))).toEqual([]);
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
      const proposed = await registry.propose(input, provenance);
      expect(proposed).toMatchObject({ packageId: input.name, state: 'quarantined', stateReason: 'scanner-unavailable', inspection: 'recorded', inspectionOutcome: 'scanner-unavailable', activationPerformed: false });
      const listed = await registry.report();
      expect(listed.revisions).toHaveLength(1);
      expect(listed.revisions[0]).toMatchObject({ packageId: input.name, origin: 'generated', state: 'quarantined', active: false, riskClass: 'declarative', permissions: [] });
      const details = await registry.inspect(proposed.revisionId);
      expect(details.files.map(file => file.path).sort()).toEqual(['PROVENANCE.md', 'SKILL.md']);
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
