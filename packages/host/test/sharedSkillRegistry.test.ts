import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SkillApprovalRecord, SkillRevisionSummary } from '@extalia/protocol';
import type { DaemonClient, DaemonSidecar } from '../src/daemon/index.js';
import { DaemonRequestError } from '../src/daemon/index.js';
import { SkillRegistry, SKILL_REGISTRY_OPS } from '../src/skillRegistry.js';
import { buildAgentSkillCatalog, createSkillTools } from '../src/skills.js';
import { runTool, useTempDirs } from './helpers.js';

const temp = useTempDirs();
const SKILL = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nCollect merged changes and summarise them.`;
const summary = (packageId: string, state: SkillRevisionSummary['state'], active: boolean, origin: SkillRevisionSummary['origin']): SkillRevisionSummary => ({
  packageId, revisionId: `skr_${'4'.repeat(64)}`, origin, version: '1.0.0', treeSha256: 'a'.repeat(64), skillMdSha256: 'b'.repeat(64),
  state, riskClass: 'declarative', manifestInferred: true, permissionDigest: 'c'.repeat(64), permissions: [], active,
  createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
});

/** Synthetic authority fixture only; no production scanner or successful scan is emulated. */
function fakeDaemon(revisions: SkillRevisionSummary[], files: Record<string, string>, _ops: typeof SKILL_REGISTRY_OPS,
  extra: { 'skill.inspect': () => unknown }) {
  const calls: { op: string; params: unknown }[] = [];
  let denied: string | undefined;
  for (const revision of revisions) revision.skillMdSha256 = createHash('sha256').update(files[revision.packageId]!).digest('hex');
  const client = { capabilities: SKILL_REGISTRY_OPS, async request(op: string, params: Record<string, unknown>) {
    calls.push({ op, params });
    if (op === 'skill.list') return { revisions, indexGeneration: 1 };
    if (op === 'skill.inspect') return extra['skill.inspect']();
    if (op === 'skill.read') {
      if (denied) throw new DaemonRequestError('denied', denied);
      const revision = revisions.find(row => row.revisionId === params.revisionId);
      if (!revision?.active) throw new DaemonRequestError('denied', 'not_active');
      const content = files[revision.packageId]!;
      return { revisionId: revision.revisionId, packageId: revision.packageId, path: 'SKILL.md', size: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'), content };
    }
    throw new Error(`Unexpected synthetic daemon operation ${op}`);
  } } as unknown as DaemonClient;
  return { sidecar: { connect: async () => client } as unknown as DaemonSidecar, calls, denyRead: (reason: string) => { denied = reason; } };
}

describe('shared user-library skills with active-pointer approval scope', () => {
  const first = 'w_mh3p2k1x9f04c2a7', isolated = 'w_mh3p2k1x8a04c2b7';
  async function shared(origin: SkillRevisionSummary['origin'] = 'generated') {
    const active = { ...summary('shared-procedure', 'active', true, origin), activationApprovalId: 7 };
    const approval: SkillApprovalRecord = { approvalId: 7, kind: 'user', approver: 'user:local', status: 'granted',
      permissionDigest: active.permissionDigest, createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:10:00.000Z' };
    const approvals = [approval];
    const daemon = fakeDaemon([active], { 'shared-procedure': SKILL('shared-procedure', 'Reusable general procedure') }, SKILL_REGISTRY_OPS, {
      'skill.inspect': () => ({ revision: { ...active }, approvals: approvals.map(record => ({ ...record })) }),
    });
    const registry = new SkillRegistry({ daemon: daemon.sidecar, dataDirectory: await temp(), profile: 'default', workspaceRoot: () => { throw new Error('No project read needed.'); } });
    return { active, approval, approvals, daemon, registry };
  }

  it.each(['generated', 'user', 'workspace', 'imported'] as const)('offers a globally activated %s skill to ordinary and isolated workspace identities', async origin => {
    const { registry, daemon } = await shared(origin);
    for (const workspace of [first, isolated]) {
      const catalog = await registry.activeCatalog(workspace);
      expect(catalog.skills.map(skill => skill.name)).toEqual(['shared-procedure']);
      const loaded = await registry.reloadMany(catalog.skills, workspace);
      expect(loaded[0]!.body).toContain('Collect merged changes');
      const nativeCatalog = await buildAgentSkillCatalog(catalog.skills, {
        reload: skill => registry.reload(skill, workspace), reloadMany: skills => registry.reloadMany(skills, workspace),
      });
      const read = await runTool(createSkillTools(nativeCatalog), 'skill_read', { name: 'shared-procedure' });
      expect(read.ok).toBe(true); expect(read.output).toContain('Collect merged changes');
    }
    expect(daemon.calls.filter(call => call.op === 'skill.inspect').every(call => !('workspaceId' in (call.params as object)))).toBe(true);
  });

  it('keeps explicitly workspace-scoped active authority scoped despite an unrelated global grant', async () => {
    const { registry, approval, approvals } = await shared();
    approval.workspaceId = first;
    approvals.push({ ...approval, approvalId: 6, workspaceId: undefined });
    expect((await registry.activeCatalog(first)).skills).toHaveLength(1);
    expect((await registry.activeCatalog(isolated)).skills).toEqual([]);
    const offered = (await registry.activeCatalog(first)).skills;
    await expect(registry.reloadMany(offered, isolated)).rejects.toThrow(/not approved for this workspace/);
  });

  it.each(['missing-pointer', 'unrelated-only', 'revoked', 'revoked-at', 'digest'] as const)('refuses %s approval evidence without weakening fresh read guards', async mode => {
    const { registry, active, approval, approvals } = await shared();
    if (mode === 'missing-pointer') delete (active as SkillRevisionSummary).activationApprovalId;
    if (mode === 'unrelated-only') approvals.splice(0, 1, { ...approval, approvalId: 6 });
    if (mode === 'revoked') approval.status = 'revoked';
    if (mode === 'revoked-at') approval.revokedAt = '2020-01-01T00:05:00.000Z';
    if (mode === 'digest') approval.permissionDigest = 'd'.repeat(64);
    expect((await registry.activeCatalog(first)).skills).toEqual([]);
  });

  it('retains consumed active authority after its first-activation window and refuses revoked or changed scanner reads', async () => {
    const { registry, approval, daemon } = await shared();
    const offered = (await registry.activeCatalog(first)).skills;
    expect(offered).toHaveLength(1); // The actual active pointer consumed this old grant.
    daemon.denyRead('attestation_mismatch');
    await expect(registry.reloadMany(offered, isolated)).rejects.toThrow();
    approval.status = 'revoked';
    expect((await registry.activeCatalog(isolated)).skills).toEqual([]);
  });
});
