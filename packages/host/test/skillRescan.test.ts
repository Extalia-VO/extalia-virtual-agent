import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DaemonOp, SkillRevisionSummary } from '@extalia/protocol';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { SKILL_REGISTRY_OPS, SKILL_REGISTRY_DEADLINE_MS, SKILL_SCAN_DEADLINE_MS, SkillRegistry } from '../src/skillRegistry.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const revisionId = `skr_${'a'.repeat(64)}`;
const revision: SkillRevisionSummary = { packageId: 'review-notes', revisionId, origin: 'generated', state: 'quarantined', stateReason: 'scanner-unavailable', version: '1.0.0', treeSha256: 'b'.repeat(64), skillMdSha256: 'c'.repeat(64), permissionDigest: 'd'.repeat(64), permissions: [], riskClass: 'declarative', manifestInferred: true, active: false, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' };
type Call = { op: string; params: unknown; deadline?: number };
/** Transport fixture only: these scanner claims never certify a production package. */
async function fixture(options: { rescan?: boolean; fail?: Error; responseState?: string } = {}) {
  const calls: Call[] = [];
  let timeoutRecorded = false;
  const capabilities: DaemonOp[] = [...SKILL_REGISTRY_OPS, 'skill.scanner', ...(options.rescan === false ? [] : ['skill.rescan' as const])];
  const client = {
    capabilities,
    async request(op: string, params: unknown, deadline?: number) {
      calls.push({ op, params, deadline });
      if (op === 'skill.list') return { revisions: [{ ...revision }], indexGeneration: 1 };
      if (op === 'skill.scanner') return { scannerId: 'nvidia-skillspector', pinned: true, pin: `54824463814a0be01360792523ec7245a69190fc:${'e'.repeat(64)}`, version: '2.13.4', policyVersion: 'extalia.skill-policy.v2', status: 'ready' };
      if (op === 'skill.inspect') return { revision: { ...revision, ...(timeoutRecorded ? { stateReason: 'timeout' } : {}) }, manifest: '{}', files: [],
        inspections: timeoutRecorded ? [{ inspectionId: 1, scannerId: 'nvidia-skillspector', scannerVersion: '2.13.4', policyVersion: 'extalia.skill-policy.v2', outcome: 'timeout', coverage: 'none', startedAt: revision.createdAt, finishedAt: revision.updatedAt }] : [], approvals: [], consent: [], history: [] };
      if (op === 'skill.rescan') {
        if (options.fail) {
          // A durable failed-scan receipt can exist even when its reply is lost.
          if (options.fail instanceof DaemonUnavailableError) timeoutRecorded = true;
          throw options.fail;
        }
        return { revisionId, packageId: revision.packageId, state: options.responseState ?? 'awaiting_approval', stateReason: 'manual-instruction-approval' };
      }
      throw new Error(`Unexpected mutating operation: ${op}`);
    },
  } as unknown as DaemonClient;
  const daemon = { connect: async () => client } as unknown as DaemonSidecar;
  const registry = new SkillRegistry({ daemon, dataDirectory: path.join(await temp(), 'data'), profile: 'default', workspaceRoot: () => { throw new Error('No workspace is needed for a stored revision'); } });
  return { registry, calls };
}

describe('explicit user rescan of a stored skill', () => {
  it('advertises the optional operation only when the daemon actually serves it', async () => {
    expect(await (await fixture()).registry.report()).toMatchObject({ mode: 'registry', status: 'ready', rescan: true });
    expect(await (await fixture({ rescan: false })).registry.report()).toMatchObject({ mode: 'registry', status: 'ready', rescan: false });
  });
  it('uses bounded scan and metadata verification budgets without changing other daemon defaults', async () => {
    const { registry, calls } = await fixture();
    const result = await registry.rescan(revisionId);
    expect(SKILL_SCAN_DEADLINE_MS).toBe(90_000);
    expect(calls[0]).toEqual({ op: 'skill.rescan', params: { revisionId }, deadline: 90_000 });
    expect(calls.slice(1).map(call => call.op)).toEqual(['skill.list', 'skill.scanner']);
    expect(calls.slice(1).every(call => call.deadline === SKILL_REGISTRY_DEADLINE_MS)).toBe(true);
    expect(result).toMatchObject({ revisionId, state: 'awaiting_approval', report: { rescan: true } });
    calls.length = 0;
    expect(await registry.inspect(revisionId)).toMatchObject({ revision: { state: 'quarantined', active: false }, approvals: [], inspections: [] });
    expect(calls).toEqual([{ op: 'skill.inspect', params: { revisionId }, deadline: SKILL_REGISTRY_DEADLINE_MS }]);
  });
  it('keeps every scan result inactive and does not approve or activate on the user’s behalf', async () => {
    for (const state of ['awaiting_approval', 'review_required', 'blocked', 'quarantined']) {
      const { registry, calls } = await fixture({ responseState: state });
      expect(await registry.rescan(revisionId)).toMatchObject({ state });
      expect(calls.map(call => call.op)).toEqual(['skill.rescan', 'skill.list', 'skill.scanner']);
    }
  });
  it('does not fall back to import, inspection, approval or a fabricated scan for an older daemon', async () => {
    const { registry, calls } = await fixture({ rescan: false });
    await expect(registry.rescan(revisionId)).rejects.toThrow('does not support rescanning');
    expect(calls).toEqual([]);
  });
  it.each(['../SKILL.md', 'https://example.com/skill', `${revisionId}\n`, { revisionId, principal: 'user:local' }, null])('rejects malformed revision input before sending it: %j', async input => {
    const { registry, calls } = await fixture();
    await expect(registry.rescan(input)).rejects.toThrow();
    expect(calls).toEqual([]);
  });
  it('does not rescan when the user only refreshes the registry or opens revision details', async () => {
    const { registry, calls } = await fixture();
    await registry.report(); await registry.inspect(revisionId); await registry.inspect(revisionId);
    expect(calls.map(call => call.op)).toEqual(['skill.list', 'skill.scanner', 'skill.inspect', 'skill.inspect']);
    expect(calls.every(call => call.deadline === SKILL_REGISTRY_DEADLINE_MS)).toBe(true);
  });
  it('surfaces scanner refusal without trying another mutation', async () => {
    const { registry, calls } = await fixture({ fail: new DaemonRequestError('denied', 'invalid_state') });
    await expect(registry.rescan(revisionId)).rejects.toThrow();
    expect(calls.map(call => call.op)).toEqual(['skill.rescan']);
  });
  it('does not retry an uncertain scan after a transport timeout', async () => {
    const { registry, calls } = await fixture({ fail: new DaemonUnavailableError('timeout') });
    let message = '';
    try { await registry.rescan(revisionId); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('completion could not be confirmed');
    expect(message).toContain('an inspection may have been recorded');
    expect(message).not.toContain('nothing changed');
    expect(calls.map(call => call.op)).toEqual(['skill.rescan']);
    const details = await registry.inspect(revisionId);
    expect(details).toMatchObject({ revision: { state: 'quarantined', active: false, stateReason: 'timeout' }, inspections: [{ outcome: 'timeout', coverage: 'none' }], approvals: [] });
    expect(calls.map(call => call.op)).toEqual(['skill.rescan', 'skill.inspect']);
  });
});
