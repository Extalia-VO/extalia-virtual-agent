import { createHash } from 'node:crypto';
import type { DaemonOp, SkillApprovalRecord, SkillRevisionSummary } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../src/builtinSkills.js';
import type { DaemonClient, DaemonSidecar } from '../src/daemon/index.js';
import { SKILL_REGISTRY_OPS, SkillRegistry } from '../src/skillRegistry.js';
import { buildAgentSkillCatalog } from '../src/skills.js';

const workspace = '00000000-0000-4000-8000-000000000001';
const foreign = '00000000-0000-4000-8000-000000000002';
const permissionDigest = 'b'.repeat(64);
const grant = (patch: Partial<SkillApprovalRecord> = {}): SkillApprovalRecord => ({ approvalId: 1, kind: 'user', approver: 'user:local', status: 'granted', workspaceId: workspace,
  permissionDigest, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), ...patch });

/** Synthetic daemon only: no filesystem or real profile reads, and no production scanner claim. */
function fixture(approvals: SkillApprovalRecord[][] = [[grant()]]) {
  const contents = approvals.map((_, index) => `---\nname: external-${index}\ndescription: Metadata sentinel ${index}\n---\nBody sentinel ${index}.`);
  const revisions: SkillRevisionSummary[] = approvals.map((_, index) => ({ packageId: `external-${index}`, revisionId: `skr_${String(index).padStart(64, '0')}`, origin: 'imported', version: '1.0.0',
    treeSha256: String(index).padStart(64, '0'), skillMdSha256: createHash('sha256').update(contents[index]!).digest('hex'), state: 'active', riskClass: 'declarative', manifestInferred: true,
    permissionDigest, permissions: [], active: true, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }));
  const inspectedRevision: Partial<SkillRevisionSummary> = {};
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  let inspectUnavailable = false, scannerUnavailable = false;
  const client = { capabilities: SKILL_REGISTRY_OPS, request: async (op: DaemonOp, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'skill.list') return { revisions: structuredClone(revisions), indexGeneration: 1 };
    const index = revisions.findIndex(revision => revision.revisionId === params.revisionId);
    const revision = revisions[index]!;
    if (op === 'skill.inspect') {
      if (inspectUnavailable) throw new Error('Inspection unavailable');
      return { revision: { ...revision, ...inspectedRevision }, approvals: structuredClone(approvals[index]), manifest: '{}', files: [], inspections: [], history: [],
        consent: [{ path: 'SKILL.md', sha256: revision.skillMdSha256, workspaceId: workspace }] };
    }
    if (op === 'skill.read') {
      if (scannerUnavailable) throw new Error('Scanner unavailable');
      const content = contents[index]!;
      return { revisionId: revision.revisionId, packageId: revision.packageId, path: 'SKILL.md', content, size: Buffer.byteLength(content), sha256: revision.skillMdSha256 };
    }
    throw new Error('Unexpected fixture operation');
  } } as unknown as DaemonClient;
  const registry = new SkillRegistry({ daemon: { connect: async () => client } as unknown as DaemonSidecar, dataDirectory: '/unused', profile: 'default',
    workspaceRoot: () => { throw new Error('No project path lookup expected'); }, consentWorkspaces: async () => { throw new Error('No consent lookup expected'); } });
  return { registry, revisions, approvals, calls, inspectedRevision,
    failInspect: () => { inspectUnavailable = true; }, failScanner: () => { scannerUnavailable = true; } };
}

describe('workspace-scoped automatic external skill context', () => {
  it('reads only exact workspace grants before offering metadata, excluding global and foreign approvals', async () => {
    const f = fixture([[grant()], [grant({ workspaceId: undefined })], [grant({ workspaceId: foreign })]]);
    const catalog = await f.registry.activeCatalog(workspace);
    expect(catalog.incomplete).toBe(false);
    expect(catalog.skills.map(skill => skill.name)).toEqual(['external-0']);
    expect(JSON.stringify(catalog)).not.toContain('Metadata sentinel 1');
    expect(JSON.stringify(catalog)).not.toContain('Metadata sentinel 2');
    expect(f.calls.filter(call => call.op === 'skill.read')).toEqual([{ op: 'skill.read', params: { revisionId: f.revisions[0]!.revisionId, path: 'SKILL.md' } }]);
    expect(f.calls.filter(call => call.op === 'skill.inspect').every(call => Object.keys(call.params).join() === 'revisionId')).toBe(true);
    expect(f.calls.findIndex(call => call.op === 'skill.inspect')).toBeLessThan(f.calls.findIndex(call => call.op === 'skill.read'));
    expect(Object.hasOwn(catalog.skills[0]!, 'body')).toBe(false);
  });

  it.each([
    ['foreign', { workspaceId: foreign }], ['global', { workspaceId: undefined }], ['revoked status', { status: 'revoked' }],
    ['revoked timestamp', { revokedAt: new Date().toISOString() }], ['expired', { expiresAt: '2020-01-01T00:00:00.000Z' }],
    ['invalid expiry', { expiresAt: 'invalid' }], ['permission mismatch', { permissionDigest: 'c'.repeat(64) }],
  ] satisfies [string, Partial<SkillApprovalRecord>][] )('does not read metadata with a %s approval, even with matching consent', async (_name, patch) => {
    const f = fixture([[grant(patch)]]);
    expect(await f.registry.activeCatalog(workspace)).toEqual({ skills: [], incomplete: false });
    expect(f.calls.some(call => call.op === 'skill.read')).toBe(false);
  });

  it.each([
    ['revision', { revisionId: `skr_${'f'.repeat(64)}` }], ['package', { packageId: 'other-package' }], ['source', { origin: 'generated' }],
    ['tree digest', { treeSha256: 'c'.repeat(64) }], ['file digest', { skillMdSha256: 'c'.repeat(64) }],
    ['permission digest', { permissionDigest: 'c'.repeat(64) }], ['state', { state: 'revoked' }], ['activation', { active: false }],
  ] satisfies [string, Partial<SkillRevisionSummary>][] )('rejects fresh inspect %s drift before reading metadata', async (_name, patch) => {
    const f = fixture();
    Object.assign(f.inspectedRevision, patch);
    expect(await f.registry.activeCatalog(workspace)).toEqual({ skills: [], incomplete: false });
    expect(f.calls.some(call => call.op === 'skill.read')).toBe(false);
  });

  it('fails closed on missing approvals or unavailable inspection without exposing foreign inventory counts', async () => {
    const f = fixture([[]]);
    expect(await f.registry.activeCatalog(workspace)).toEqual({ skills: [], incomplete: false });
    f.approvals[0]!.push(grant());
    f.failInspect();
    expect(await f.registry.activeCatalog(workspace)).toEqual({ skills: [], incomplete: false });
    expect(f.calls.some(call => call.op === 'skill.read')).toBe(false);
  });

  it('checks the workspace and fresh approval again for every reload and metadata batch', async () => {
    const f = fixture();
    const reference = (await f.registry.activeCatalog(workspace)).skills[0]!;
    f.calls.length = 0;
    await expect(f.registry.reload(reference, foreign)).rejects.toThrow('not approved for this workspace');
    expect(f.calls.some(call => call.op === 'skill.read')).toBe(false);
    f.calls.length = 0;
    expect((await f.registry.reloadMany([reference], workspace))[0]!.body).toContain('Body sentinel 0');
    expect(f.calls.map(call => call.op)).toEqual(['skill.list', 'skill.inspect', 'skill.read']);
    f.approvals[0]![0]!.revokedAt = new Date().toISOString();
    f.calls.length = 0;
    await expect(f.registry.reload(reference, workspace)).rejects.toThrow('not approved for this workspace');
    await expect(f.registry.reloadMany([reference], workspace)).rejects.toThrow('not approved for this workspace');
    expect(f.calls.some(call => call.op === 'skill.read')).toBe(false);
  });

  it('retains scanner checks independently of workspace grants and keeps canonical builtins available', async () => {
    const f = fixture();
    f.failScanner();
    const active = await f.registry.activeCatalog(workspace);
    expect(active).toEqual({ skills: [], incomplete: true });
    const catalog = await buildAgentSkillCatalog(active.skills);
    expect(catalog.skills.map(skill => skill.name).sort()).toEqual(BUILTIN_SKILLS.map(skill => skill.name).sort());
  });

  it('retains unscoped user inspection compatibility without treating it as workspace authority', async () => {
    const f = fixture([[grant({ workspaceId: foreign })]]);
    const catalog = await f.registry.activeCatalog();
    expect(catalog.skills).toHaveLength(1);
    expect((await f.registry.activeSkills())[0]!.body).toContain('Body sentinel 0');
    expect((await f.registry.reload(catalog.skills[0]!)).name).toBe('external-0');
    expect(f.calls.some(call => call.op === 'skill.inspect')).toBe(false);
    f.calls.length = 0;
    expect(await f.registry.activeCatalog(workspace)).toEqual({ skills: [], incomplete: false });
    expect(f.calls.some(call => call.op === 'skill.read')).toBe(false);
  });
});
