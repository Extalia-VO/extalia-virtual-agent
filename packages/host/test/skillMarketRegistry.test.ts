import { describe, expect, it, vi } from 'vitest';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { SkillRegistry, SKILL_REGISTRY_OPS } from '../src/skillRegistry.js';

const reviewId = '11111111-1111-4111-8111-111111111111';
const staged = { path: `market-${reviewId}`, treeSha256: 'a'.repeat(64), sourceRef: `github:acme/skills@${'b'.repeat(40)}#demo` };
function fixture(options: { down?: boolean; importFailure?: Error } = {}) {
  const calls: { op: string; params: Record<string, unknown> }[] = [];
  const client = { capabilities: [...SKILL_REGISTRY_OPS, 'skill.scanner'], request: vi.fn(async (op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'skill.import') {
      if (options.importFailure) throw options.importFailure;
      return { packageId: 'demo', revisionId: `skr_${'c'.repeat(64)}`, treeSha256: staged.treeSha256, version: '1.0.0', state: 'quarantined', created: true };
    }
    if (op === 'skill.list') return { revisions: [], indexGeneration: 1 };
    if (op === 'skill.scanner') return { scannerId: 'unavailable', pinned: false, policyVersion: 'extalia.skill-policy.v1', status: 'unavailable' };
    throw new Error(`Unexpected operation ${op}`);
  }) } as unknown as DaemonClient;
  const sidecar = { connect: vi.fn(async () => { if (options.down) throw new DaemonUnavailableError('crashed'); return client; }) } as unknown as DaemonSidecar;
  const registry = new SkillRegistry({ daemon: sidecar, dataDirectory: '/temporary/data', profile: 'fixture', workspaceRoot: () => '' });
  return { calls, client, sidecar, registry };
}

describe('SkillRegistry marketplace import boundary', () => {
  it('sends only imported origin, private stage-relative path, sourceRef and expected tree digest; never activates', async () => {
    const f = fixture();
    const result = await f.registry.importPreparedMarket(staged);
    expect(result).toMatchObject({ packageId: 'demo', revisionId: `skr_${'c'.repeat(64)}`, state: 'quarantined', created: true });
    expect(f.calls[0]).toEqual({ op: 'skill.import', params: { origin: 'imported', path: staged.path, sourceRef: staged.sourceRef, expectedTreeSha256: staged.treeSha256 } });
    expect(f.calls.map(call => call.op)).not.toContain('skill.activate');
    expect(f.calls.some(call => Object.values(call.params).some(value => typeof value === 'string' && value.startsWith('/')))).toBe(false);
  });

  it.each([
    { ...staged, path: '../outside' },
    { ...staged, path: '/tmp/market-stage' },
    { ...staged, treeSha256: 'not-a-hash' },
    { ...staged, sourceRef: `github:acme/skills@${'b'.repeat(40)}#demo\norigin:generated` },
  ])('refuses malformed stage receipts before daemon RPC: %j', async invalid => {
    const f = fixture();
    await expect(f.registry.importPreparedMarket(invalid)).rejects.toThrow(/Invalid marketplace staging receipt/);
    expect(f.sidecar.connect).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });

  it('reports import acknowledgement uncertainty after daemon loss, without retry or activation', async () => {
    const f = fixture({ importFailure: new DaemonUnavailableError('crashed') });
    await expect(f.registry.importPreparedMarket(staged)).rejects.toThrow(/Import completion could not be confirmed/);
    expect(f.calls.map(call => call.op)).toEqual(['skill.import']);
    expect(f.client.request).toHaveBeenCalledOnce();
  });

  it('keeps a structured daemon refusal distinct from uncertain transport completion', async () => {
    const f = fixture({ importFailure: new DaemonRequestError('denied', 'integrity') });
    await expect(f.registry.importPreparedMarket(staged)).rejects.toThrow(/stored skill|integrity/i);
    expect(f.calls.map(call => call.op)).toEqual(['skill.import']);
  });
});
