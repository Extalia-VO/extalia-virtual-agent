import { chmod, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeSkillRouting, normalizeSkillRoutingReport, type SkillRoutingInput, type SkillRoutingReport } from '@extalia/platform';
import { type DaemonOp } from '@extalia/protocol';
import { describe, expect, it, vi } from 'vitest';
import { type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { SKILL_REGISTRY_OPS, SkillRegistry } from '../src/skillRegistry.js';
import { createAgentHost } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON, queryCore } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';
const fixtures = JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/daemon/skill-routing.json', import.meta.url), 'utf8')) as {
  cases: { name: string; valid: boolean; value: Record<string, unknown> }[];
};
const temp = useTempDirs();
const input = (): SkillRoutingInput => ({ categories: ['quality'], intents: [], candidateRevisionIds: [`skr_${'a'.repeat(64)}`], pins: {}, maxResults: 16 });
const report = (): SkillRoutingReport => structuredClone(fixtures.cases.find(item => item.name === 'matched diagnostic only')!.value as { result: unknown }).result as SkillRoutingReport;
function fake(supported = true, answer: unknown = report()) {
  const calls: { op: string; params: unknown }[] = [];
  const client = { capabilities: [...SKILL_REGISTRY_OPS, ...(supported ? ['skill.routingPreview'] : [])], request: vi.fn(async (op: DaemonOp, params: unknown) => {
    calls.push({ op, params });
    if (op === 'skill.list') return { revisions: [], indexGeneration: 1 };
    if (op === 'skill.routingPreview') return answer;
    throw new Error('unexpected operation');
  }) } as unknown as DaemonClient;
  const registry = new SkillRegistry({ daemon: { connect: async () => client } as DaemonSidecar, dataDirectory: '/unused', profile: 'default',
    workspaceRoot: id => { if (id !== 'w_mh3p2k1x9f04c2a7') throw new Error('Unknown workspace.'); return '/unused'; },
    consentWorkspaces: () => { throw new Error('Preview must not record consent.'); } });
  return { calls, registry };
}
async function unlock(root: string): Promise<void> {
  const info = await lstat(root).catch(() => undefined); if (!info || info.isSymbolicLink()) return;
  await chmod(root, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const name of await readdir(root)) await unlock(path.join(root, name));
}
function snapshot(data: string) {
  return queryCore<{ name: string }>(data, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'skill_%' ORDER BY name")
    .map(({ name }) => [name, queryCore(data, `SELECT * FROM "${name}" ORDER BY rowid`)]);
}

describe('read-only skill routing host API', () => {
  it('advertises only the optional daemon capability and sends exactly one diagnostic operation', async () => {
    const f = fake(); expect((await f.registry.report()).routingPreview).toBe(true); f.calls.length = 0;
    expect(await f.registry.routingPreview(input())).toEqual(report());
    expect(f.calls).toEqual([{ op: 'skill.routingPreview', params: input() }]);
  });
  it('keeps legacy registry/preflight support intact without sending an unsupported preview', async () => {
    const f = fake(false); expect((await f.registry.report()).routingPreview).toBe(false); f.calls.length = 0;
    await expect(f.registry.routingPreview(input())).rejects.toThrow('not supported'); expect(f.calls).toEqual([]);
  });
  it('resolves workspace ownership before dispatch, rejecting syntax-only foreign workspace IDs', async () => {
    const f = fake(); await expect(f.registry.routingPreview({ ...input(), workspaceId: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow('Unknown workspace');
    expect(f.calls).toEqual([]);
  });
  it('accepts a known workspace without a project folder and refuses unknown membership before dispatch', async () => {
    const workspaceId = 'w_mh3p2k1x9f04c2a7', answer = { ...report(), input: { ...input(), workspaceId } };
    const request = vi.fn(async () => answer);
    const client = { capabilities: [...SKILL_REGISTRY_OPS, 'skill.routingPreview'], request } as unknown as DaemonClient;
    const registry = new SkillRegistry({ daemon: { connect: async () => client } as DaemonSidecar, dataDirectory: '/unused', profile: 'default',
      workspaceRoot: () => { throw new Error('No project folder.'); }, workspaceKnown: id => id === workspaceId });
    expect(await registry.routingPreview({ ...input(), workspaceId })).toEqual(answer);
    expect(request).toHaveBeenCalledExactlyOnceWith('skill.routingPreview', { ...input(), workspaceId });
    await expect(registry.routingPreview({ ...input(), workspaceId: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow('Unknown workspace');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('refuses caller authority and binds replies to selectors, exact candidates, pins and workspace', async () => {
    const f = fake(); await expect(f.registry.routingPreview({ ...input(), runtimeFacts: {} } as never)).rejects.toThrow('Invalid'); expect(f.calls).toEqual([]);
    for (const changed of [{ ...input(), workspaceId: 'w_mh3p2k1x9f04c2a7' }, { ...input(), intents: ['review_code'] }, { ...input(), pins: { dependency: `skr_${'d'.repeat(64)}` } }, { ...input(), maxResults: 1 }]) {
      expect(() => normalizeSkillRoutingReport(report(), changed)).toThrow('Invalid skill routing preview result');
    }
    await expect(fake(true, { ...report(), dispatchEligible: true }).registry.routingPreview(input())).rejects.toThrow('Invalid');
    const invalid = fixtures.cases.filter(item => !item.valid && item.value.kind === 'request');
    for (const item of invalid) expect(() => normalizeSkillRouting((item.value as { params: unknown }).params)).toThrow();
  });
  it.runIf(HAS_DAEMON)('carries the real host route through a temporary registry without changing any skill table', async () => {
    const root = await temp(), data = path.join(root, 'data'), home = path.join(root, 'home'), source = path.join(root, 'source');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: routing-example\ndescription: Example\n---\nReview a change.');
    await writeFile(path.join(source, 'extalia-skill.json'), JSON.stringify({ schema: 'extalia.skill-manifest.v1', id: 'routing-example', version: '1.0.0', risk_class: 'declarative', categories: ['quality.review'], intents: ['review_code'] }));
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'rust', EXTALIA_DAEMON_PATH: DAEMON_BINARY, HOME: home, PATH: process.env.PATH ?? '' }, daemon: { log: () => undefined } });
    try {
      const imported = await runtime.host.importSkill({ kind: 'folder', path: source });
      expect((await runtime.host.skillRegistry()).routingPreview).toBe(true);
      const before = snapshot(data);
      const request = { ...input(), candidateRevisionIds: [imported.revisionId!] };
      const result = await runtime.host.previewSkillRouting!(request);
      expect(result.status).toBe('no_safe_skill'); expect(result.dispatchEligible).toBe(false); expect(result.exclusions[0]!.identity.revisionId).toBe(imported.revisionId);
      expect(snapshot(data)).toEqual(before);
      await expect(runtime.host.previewSkillRouting!({ ...request, workspaceId: '00000000-0000-4000-8000-000000000001' })).rejects.toThrow();
      expect(snapshot(data)).toEqual(before);
    } finally { await runtime.close(); await unlock(data); }
  });
});
