import { chmod, lstat, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HOST_WORKSPACE_ID_PATTERN, type DaemonOp, type SkillRevisionSummary } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS } from '../src/builtinSkills.js';
import { DaemonRequestError, DaemonUnavailableError, type DaemonClient, type DaemonSidecar } from '../src/daemon/index.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { SKILL_REGISTRY_OPS, SkillRegistry, copyPackage, type SkillConsentWorkspace } from '../src/skillRegistry.js';
import { createSkillTools, withBuiltinSkills } from '../src/skills.js';
import { DAEMON_BINARY, HAS_DAEMON, queryCore } from './daemonBackend.js';
import { findTool, runTool, useTempDirs } from './helpers.js';

// W3 Skill Security Center: the host's skill registry service over the Rust core daemon. The daemon cases need the
// debug binary (`cargo build -p extalia-daemon`) and are skipped without it, like missionDaemon.test.ts.
if (!HAS_DAEMON) console.warn('skillRegistry.test.ts daemon cases skipped: build the daemon with `cargo build -p extalia-daemon`.');

const temp = useTempDirs();
const posix = process.platform !== 'win32';
const SKILL = (name: string, description = 'Write release notes') => `---\nname: ${name}\ndescription: ${description}\n---\nCollect merged changes and summarise them.`;

async function writePackage(directory: string, name: string, files: Record<string, string> = {}): Promise<string> {
  const root = path.join(directory, name);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'SKILL.md'), SKILL(name));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  return root;
}

/** The daemon's skill store is read-only (0400/0500); make it removable for the temp-folder cleanup. */
async function unlockStore(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) await unlockStore(path.join(directory, entry));
  } else await chmod(directory, 0o600);
}

function recordingFetch() {
  const bodies: { messages: { role: string; content?: unknown }[]; tools?: { function: { name: string; description: string } }[] }[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'mock-agent' }] });
    bodies.push(JSON.parse(String(init?.body)));
    const chunk = { choices: [{ delta: { content: 'Done.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, bodies };
}

async function untilIdle(runtime: AgentHostRuntime): Promise<void> {
  for (let i = 0; i < 500 && runtime.isBusy(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(runtime.isBusy()).toBe(false);
}

/** A host with one native workspace whose project has a `.extalia/skills/deploy` skill, and one user skill. */
async function hostFixture(env: Record<string, string>) {
  const dir = await temp();
  const data = path.join(dir, 'data'), home = path.join(dir, 'home'), project = path.join(dir, 'project');
  await writePackage(path.join(project, '.extalia', 'skills'), 'deploy');
  await writePackage(path.join(data, 'skills'), 'team-rules');
  const recorded = recordingFetch();
  const log: string[] = [];
  const runtime = await createAgentHost({
    kind: 'bridge', version: '0.0.0-test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000, fetch: recorded.fetch,
    env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH ?? '', HOME: home, ...env }, daemon: { log: line => { log.push(line); } },
  });
  const { host } = runtime;
  const saved = await host.saveConnection({ name: 'Mock', preset: 'custom', api: 'openai-chat', baseUrl: 'http://mock.test/v1', model: 'mock-agent', credential: { kind: 'none' }, features: { memory: 'off', skills: 'extalia' } });
  await host.saveWorkspace({ name: 'Repo', projectLocation: project, connectionId: saved.connections[0]!.id, permissions: { fileWrite: 'ask', commands: 'ask' } });
  const workspace = (await host.completeSetup()).workspaces[0]!;
  const session = await host.createSession(workspace.id);
  const catalog = () => recorded.bodies.at(-1)!.tools!.find(tool => tool.function.name === 'skill_read')!.function.description;
  const turn = async () => { await host.sendPrompt(session.id, 'Write the notes'); await untilIdle(runtime); };
  const close = async () => { await runtime.close(); await unlockStore(path.join(data, 'profiles')); };
  return { dir, data, project, runtime, host, workspace, catalog, turn, log, recorded, close };
}

describe('skill registry with the native core flag off (legacy)', () => {
  it('reports legacy mode and keeps the W0 path: consented project skills and user skills reach the model', async () => {
    const fixture = await hostFixture({});
    try {
      const { host, workspace } = fixture;
      expect(await host.skillRegistry()).toMatchObject({ mode: 'legacy', status: 'off', revisions: [] });
      await expect(host.importSkill({ kind: 'workspace', workspaceId: workspace.id, name: 'deploy' })).rejects.toThrow(/does not serve the skill registry/);
      await host.allowWorkspaceSkills(workspace.id, (await host.workspaceSkills(workspace.id)).pending);
      await fixture.turn();
      expect(fixture.catalog()).toContain('- deploy (workspace, untrusted)');
      expect(fixture.catalog()).toContain('- team-rules (user, untrusted)');
      for (const skill of BUILTIN_SKILLS) expect(fixture.catalog()).toContain(`- ${skill.name}: `);
    } finally { await fixture.close(); }
  });
});

describe('skill registry with the flag on but the daemon unavailable', () => {
  it('reports unavailable, refuses actions and offers only built-in skills (fail closed)', async () => {
    const fixture = await hostFixture({ EXTALIA_NATIVE_CORE: 'rust', EXTALIA_DAEMON_PATH: path.join(await temp(), 'missing-daemon') });
    try {
      const { host, workspace } = fixture;
      const report = await host.skillRegistry();
      expect(report).toMatchObject({ mode: 'registry', status: 'unavailable', revisions: [] });
      expect(report.unavailableReason).toMatch(/binary_missing|spawn_failed/);
      await expect(host.importSkill({ kind: 'workspace', workspaceId: workspace.id, name: 'deploy' })).rejects.toThrow(/native core is unavailable/);
      // W0 consent no longer feeds the model while the flag is on.
      await host.allowWorkspaceSkills(workspace.id, (await host.workspaceSkills(workspace.id)).pending);
      await fixture.turn();
      const catalog = fixture.catalog();
      for (const skill of BUILTIN_SKILLS) expect(catalog).toContain(`- ${skill.name}: `);
      expect(catalog).not.toContain('deploy');
      expect(catalog).not.toContain('team-rules');
      expect(catalog).not.toContain('untrusted');
    } finally { await fixture.close(); }
  });
});

describe.skipIf(!HAS_DAEMON)('skill registry against the real daemon', () => {
  const rust = { EXTALIA_NATIVE_CORE: 'rust', EXTALIA_DAEMON_PATH: DAEMON_BINARY };

  it('imports a folder into quarantine and refuses approval and activation while no scanner is pinned', async () => {
    const fixture = await hostFixture(rust);
    try {
      const { host, data } = fixture;
      const initial = await host.skillRegistry();
      expect(initial).toMatchObject({ mode: 'registry', status: 'ready', scanner: 'unpinned', approvalTtlMs: 600_000, revisions: [] });
      // `skill.review` is served once core migration 0004 lands; either way a quarantined revision cannot be reviewed.
      expect(typeof initial.review).toBe('boolean');
      const source = await writePackage(await temp(), 'release-notes', { 'notes/template.md': '# Notes\n' });
      if (posix) await writeFile(path.join(source, '.DS_Store'), 'finder');
      const imported = await host.importSkill({ kind: 'folder', path: source });
      expect(imported).toMatchObject({ packageId: 'release-notes', state: 'quarantined', stateReason: 'scanner-unavailable', created: true });
      expect(imported.revisionId).toMatch(/^skr_[0-9a-f]{64}$/);
      // The inbox copy is gone; only the daemon's private object remains.
      expect(await readdir(path.join(data, 'profiles', 'default', 'skill-imports'))).toEqual([]);
      const listed = imported.report.revisions;
      expect(listed).toHaveLength(1);
      const revision = listed[0]!;
      expect(revision).toMatchObject({ packageId: 'release-notes', origin: 'imported', state: 'quarantined', active: false, riskClass: 'declarative', manifestInferred: true });

      const details = await host.inspectSkill(revision.revisionId);
      expect(details.files.map(file => file.path).sort()).toEqual(['SKILL.md', 'notes/template.md']);
      expect(details.inspections[0]).toMatchObject({ outcome: 'scanner-unavailable' });

      // Same bytes again: the same revision, not a new one.
      expect(await host.importSkill({ kind: 'folder', path: source })).toMatchObject({ revisionId: revision.revisionId, created: false });

      await expect(host.approveSkill({ revisionId: revision.revisionId, treeSha256: revision.treeSha256, permissionDigest: revision.permissionDigest }))
        .rejects.toThrow(/not in a state that allows this|scanner/);
      await expect(host.activateSkill(revision.revisionId)).rejects.toThrow(/Approve this revision before activating it/);
      await expect(host.reviewSkill({ revisionId: revision.revisionId, treeSha256: revision.treeSha256, decision: 'accept' }))
        .rejects.toThrow(initial.review ? /not in a state that allows this/ : /not available yet/);
      expect((await host.skillRegistry()).revisions[0]).toMatchObject({ state: 'quarantined', active: false });

      // A quarantined revision is never offered to the model.
      await fixture.turn();
      expect(fixture.catalog()).not.toContain('release-notes');

      const revoked = await host.revokeSkill(revision.revisionId);
      expect(revoked).toMatchObject({ state: 'revoked' });
    } finally { await fixture.close(); }
  });

  it('reports the installed scanner and shows W0 consent of the host workspace as stored review input', async () => {
    const fixture = await hostFixture(rust);
    try {
      const { host, workspace, data } = fixture;
      // The id the host generated is the form the skill contract and core schema 5 accept.
      expect(workspace.id).toMatch(HOST_WORKSPACE_ID_PATTERN);
      const report = await host.skillRegistry();
      expect(report).toMatchObject({
        status: 'ready', scanner: 'unpinned',
        inspector: { scannerId: 'unavailable', pinned: false, policyVersion: 'extalia.skill-policy.v1', status: 'unavailable' },
      });
      expect(report.inspector).not.toHaveProperty('pin');
      await host.allowWorkspaceSkills(workspace.id, (await host.workspaceSkills(workspace.id)).pending);
      const imported = await host.importSkill({ kind: 'workspace', workspaceId: workspace.id, name: 'deploy' });
      const details = await host.inspectSkill(imported.revisionId!);
      expect(details.consent).toHaveLength(1);
      expect(details.consent[0]).toMatchObject({ path: 'SKILL.md', sha256: details.revision.skillMdSha256, workspaceId: workspace.id });
      expect(Date.parse(details.consent[0]!.allowedAt!)).not.toBeNaN();
      // Review input only: nothing moved, nothing was approved.
      expect(details.revision).toMatchObject({ state: 'quarantined', active: false });
      expect(details.approvals).toEqual([]);
      // Shown again without re-sending it; stored once.
      expect((await host.inspectSkill(imported.revisionId!)).consent).toEqual(details.consent);
      expect(queryCore<{ workspace_id: string; source: string }>(data, 'SELECT workspace_id, source FROM skill_review_inputs'))
        .toEqual([{ workspace_id: workspace.id, source: 'w0-consent' }]);
    } finally { await fixture.close(); }
  });

  it('imports a project skill with the workspace origin and validates every input', async () => {
    const fixture = await hostFixture(rust);
    try {
      const { host, workspace } = fixture;
      const imported = await host.importSkill({ kind: 'workspace', workspaceId: workspace.id, name: 'deploy' });
      expect(imported).toMatchObject({ packageId: 'deploy', state: 'quarantined' });
      expect(imported.report.revisions.find(item => item.packageId === 'deploy')).toMatchObject({ origin: 'workspace' });
      await expect(host.importSkill({ kind: 'workspace', workspaceId: workspace.id, name: 'missing' })).rejects.toThrow(/no skill "missing"/);
      await expect(host.importSkill({ kind: 'workspace', workspaceId: workspace.id, name: '../etc' })).rejects.toThrow(/Invalid skill name/);
      await expect(host.importSkill({ kind: 'folder', path: 'relative/path' })).rejects.toThrow(/full path/);
      await expect(host.importSkill({ kind: 'folder', path: fixture.data })).rejects.toThrow(/outside the Extalia data folder/);
      await expect(host.inspectSkill('skr_nothex')).rejects.toThrow(/Invalid skill revision/);
      await expect(host.approveSkill({ revisionId: imported.revisionId!, treeSha256: 'A'.repeat(64), permissionDigest: 'b'.repeat(64) })).rejects.toThrow(/Invalid package hash/);
      await expect(host.deactivateSkill('deploy')).rejects.toThrow(/no longer exists|not active|refused/);
      await expect(host.inspectSkill(`skr_${'0'.repeat(64)}`)).rejects.toThrow(/no longer exists/);
    } finally { await fixture.close(); }
  });

  it.skipIf(!posix)('refuses links, hidden entries and missing SKILL.md before or at the daemon', async () => {
    const fixture = await hostFixture(rust);
    try {
      const { host } = fixture;
      const base = await temp();
      const linked = await writePackage(base, 'linked');
      await symlink('/etc/hosts', path.join(linked, 'hosts'));
      await expect(host.importSkill({ kind: 'folder', path: linked })).rejects.toThrow(/symbolic link/);
      const hidden = await writePackage(base, 'hidden', { '.env': 'TOKEN=1' });
      await expect(host.importSkill({ kind: 'folder', path: hidden })).rejects.toThrow(/hidden files/);
      const empty = path.join(base, 'no-skill');
      await mkdir(empty);
      await writeFile(path.join(empty, 'README.md'), 'readme');
      await expect(host.importSkill({ kind: 'folder', path: empty })).rejects.toThrow(/no SKILL.md|missing_skill_md|invalid/i);
      expect((await host.skillRegistry()).revisions).toEqual([]);
    } finally { await fixture.close(); }
  });
});

describe('package copy into the import inbox', () => {
  it('copies regular files with their executable bit and stops at the caps', async () => {
    const base = await temp();
    const source = await writePackage(base, 'tools', { 'scripts/run.sh': '#!/bin/sh\necho hi\n' });
    const target = path.join(base, 'copy');
    await copyPackage(source, target);
    expect((await readdir(target)).sort()).toEqual(['SKILL.md', 'scripts']);
    const big = await writePackage(base, 'big', { 'data.md': 'x'.repeat(1024 * 1024 + 1) });
    await expect(copyPackage(big, path.join(base, 'copy-big'))).rejects.toThrow(/larger than 1 MB/);
    await expect(copyPackage(path.join(base, 'missing'), path.join(base, 'copy-missing'))).rejects.toThrow(/does not exist/);
  });
});

/** A fake daemon connection with active revisions, for the model catalog path. */
function fakeDaemon(
  revisions: SkillRevisionSummary[], files: Record<string, string>, ops: readonly DaemonOp[] = SKILL_REGISTRY_OPS,
  extra: Partial<Record<DaemonOp, (params: Record<string, unknown>) => unknown>> = {},
) {
  const calls: { op: string; params: unknown }[] = [];
  let down = false;
  const client = {
    capabilities: ops,
    async request(op: string, params: Record<string, unknown>) {
      calls.push({ op, params });
      if (down) throw new DaemonUnavailableError('crashed');
      if (op === 'skill.list') return { revisions, indexGeneration: 1 };
      if (op === 'skill.review') return { revisionId: params.revisionId, decision: params.decision, state: params.decision === 'accept' ? 'validated' : 'quarantined', stateReason: params.decision === 'accept' ? 'review-accepted' : 'review-rejected', reviewId: 7 };
      if (op === 'skill.read') {
        const revision = revisions.find(item => item.revisionId === params.revisionId);
        if (!revision?.active) throw new DaemonRequestError('denied', 'not_active');
        return { revisionId: revision.revisionId, packageId: revision.packageId, path: 'SKILL.md', size: 1, sha256: 'f'.repeat(64), content: files[revision.packageId]! };
      }
      const handler = extra[op as DaemonOp];
      if (handler) return handler(params);
      throw new Error(`unexpected ${op}`);
    },
  } as unknown as DaemonClient;
  const sidecar = { connect: async () => { if (down) throw new DaemonUnavailableError('crashed'); return client; } } as unknown as DaemonSidecar;
  return { sidecar, calls, fail: () => { down = true; } };
}

const summary = (packageId: string, state: SkillRevisionSummary['state'], active: boolean, origin: SkillRevisionSummary['origin'] = 'imported'): SkillRevisionSummary => ({
  packageId, revisionId: `skr_${'0'.repeat(64)}`, origin,
  version: '1.0.0', treeSha256: 'a'.repeat(64), skillMdSha256: 'b'.repeat(64), state, riskClass: 'declarative', manifestInferred: true, permissionDigest: 'c'.repeat(64),
  permissions: [], active, createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z',
});

describe('model catalog from active registry revisions', () => {
  it('offers only active non-built-in revisions, read through the daemon, and fails closed on reload', async () => {
    const active = { ...summary('release-notes', 'active', true), revisionId: `skr_${'1'.repeat(64)}` };
    const approved = { ...summary('changelog', 'approved', false), revisionId: `skr_${'2'.repeat(64)}` };
    const quarantined = { ...summary('deploy', 'quarantined', false, 'workspace'), revisionId: `skr_${'3'.repeat(64)}` };
    const daemon = fakeDaemon([active, approved, quarantined], { 'release-notes': SKILL('release-notes', 'Draft release notes') });
    const registry = new SkillRegistry({ daemon: daemon.sidecar, dataDirectory: await temp(), profile: 'default', workspaceRoot: () => { throw new Error('none'); } });
    const skills = await registry.activeSkills();
    expect(skills).toMatchObject([{ name: 'release-notes', source: 'imported', revisionId: active.revisionId, description: 'Draft release notes' }]);
    expect(daemon.calls.filter(call => call.op === 'skill.read')).toEqual([{ op: 'skill.read', params: { revisionId: active.revisionId, path: 'SKILL.md' } }]);
    // Cached by revision id (content-addressed): the next turn lists but does not re-read.
    await registry.activeSkills();
    expect(daemon.calls.filter(call => call.op === 'skill.read')).toHaveLength(1);

    const tools = createSkillTools(withBuiltinSkills(skills), { reload: skill => registry.reload(skill) });
    const tool = findTool(tools, 'skill_read');
    expect(tool.description).toContain('- release-notes (imported, untrusted): Draft release notes');
    for (const skill of BUILTIN_SKILLS) expect(tool.description).toContain(`- ${skill.name}: `);
    expect(tool.description).not.toContain('changelog');
    expect(tool.description).not.toContain('deploy');
    const read = await runTool(tools, 'skill_read', { name: 'release-notes' });
    expect(read.output).toContain('<skill-content>');
    expect(read.output).toContain('Collect merged changes');

    // Deactivated after the catalog was built: the read is refused, not served from the cache.
    active.active = false;
    const refused = await runTool(tools, 'skill_read', { name: 'release-notes' });
    expect(refused.ok).toBe(false);
    expect(refused.output).toMatch(/no longer available/);
    // Built-in skills never depend on the daemon.
    daemon.fail();
    const builtin = await runTool(tools, 'skill_read', { name: BUILTIN_SKILLS[0]!.name });
    expect(builtin.ok).toBe(true);
    await expect(registry.activeSkills()).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  it('treats a daemon without the skill operations as not serving the registry', async () => {
    const daemon = fakeDaemon([], {}, ['skill.list']);
    const registry = new SkillRegistry({ daemon: daemon.sidecar, dataDirectory: await temp(), profile: 'default', workspaceRoot: () => '' });
    expect(await registry.report()).toMatchObject({ mode: 'registry', status: 'unavailable', unavailableReason: 'not-served' });
    await expect(registry.activeSkills()).rejects.toThrow();
    await expect(registry.inspect(`skr_${'1'.repeat(64)}`)).rejects.toThrow(/does not serve the skill registry/);
  });

  it('records a review as the local user with the digest shown when the daemon serves it (core schema 4)', async () => {
    const daemon = fakeDaemon([], {}, [...SKILL_REGISTRY_OPS, 'skill.review']);
    const registry = new SkillRegistry({ daemon: daemon.sidecar, dataDirectory: await temp(), profile: 'default', workspaceRoot: () => '' });
    expect(await registry.report()).toMatchObject({ status: 'ready', review: true });
    const revisionId = `skr_${'1'.repeat(64)}`;
    const accepted = await registry.review({ revisionId, treeSha256: 'a'.repeat(64), decision: 'accept', note: 'Checked the finding.', principal: 'model:x' });
    expect(accepted).toMatchObject({ revisionId, state: 'validated', stateReason: 'review-accepted' });
    expect(daemon.calls.find(call => call.op === 'skill.review')!.params).toEqual({ revisionId, treeSha256: 'a'.repeat(64), decision: 'accept', note: 'Checked the finding.', principal: 'user:local' });
    expect(await registry.review({ revisionId, treeSha256: 'a'.repeat(64), decision: 'reject' })).toMatchObject({ state: 'quarantined', stateReason: 'review-rejected' });
  });

  it('reports a review the daemon does not serve as not available yet, without sending it', async () => {
    const daemon = fakeDaemon([], {});
    const registry = new SkillRegistry({ daemon: daemon.sidecar, dataDirectory: await temp(), profile: 'default', workspaceRoot: () => '' });
    expect(await registry.report()).toMatchObject({ status: 'ready', review: false });
    await expect(registry.review({ revisionId: `skr_${'1'.repeat(64)}`, treeSha256: 'a'.repeat(64), decision: 'reject', note: 'Too broad.' })).rejects.toThrow(/not available yet/);
    expect(daemon.calls.some(call => call.op === 'skill.review')).toBe(false);
  });
});

describe('scanner status and consent review inputs', () => {
  const ready = { scannerId: 'skillspector', pinned: true, pin: '0123abcd+sha256:feed', version: '1.0.0', policyVersion: 'extalia.skill-policy.v1', status: 'ready' };
  const unavailable = { scannerId: 'unavailable', pinned: false, policyVersion: 'extalia.skill-policy.v1', status: 'unavailable' };

  it('takes the scanner from skill.scanner and never infers it from revision states', async () => {
    // An active revision would once have been taken as evidence of a pinned scanner.
    const active = summary('release-notes', 'active', true);
    const options = (daemon: ReturnType<typeof fakeDaemon>) => ({ daemon: daemon.sidecar, dataDirectory: '/unused', profile: 'default', workspaceRoot: () => '' });
    const older = new SkillRegistry(options(fakeDaemon([active], {})));
    const report = await older.report();
    expect(report).toMatchObject({ status: 'ready', scanner: 'unpinned' });
    expect(report).not.toHaveProperty('inspector');

    const none = fakeDaemon([active], {}, [...SKILL_REGISTRY_OPS, 'skill.scanner'], { 'skill.scanner': () => unavailable });
    expect(await new SkillRegistry(options(none)).report()).toMatchObject({ status: 'ready', scanner: 'unpinned', inspector: unavailable });
    expect(none.calls.find(call => call.op === 'skill.scanner')!.params).toEqual({});

    const pinned = fakeDaemon([], {}, [...SKILL_REGISTRY_OPS, 'skill.scanner'], { 'skill.scanner': () => ready });
    expect(await new SkillRegistry(options(pinned)).report()).toMatchObject({ scanner: 'pinned', inspector: ready });

    // Unpinned, or a contradictory report, is never shown as pinned.
    for (const reported of [{ ...unavailable, scannerId: 'skillspector', status: 'unpinned' }, { ...ready, pinned: false }]) {
      const daemon = fakeDaemon([], {}, [...SKILL_REGISTRY_OPS, 'skill.scanner'], { 'skill.scanner': () => reported });
      expect(await new SkillRegistry(options(daemon)).report()).toMatchObject({ scanner: 'unpinned', inspector: reported });
    }

    const log: string[] = [];
    const refusing = fakeDaemon([], {}, [...SKILL_REGISTRY_OPS, 'skill.scanner'], { 'skill.scanner': () => { throw new DaemonRequestError('internal'); } });
    const refused = await new SkillRegistry({ ...options(refusing), log: line => { log.push(line); } }).report();
    expect(refused).toMatchObject({ status: 'ready', scanner: 'unpinned' });
    expect(refused).not.toHaveProperty('inspector');
    expect(log.join('\n')).toMatch(/did not report its skill scanner \(internal\)/);
  });

  it('passes only workspaces whose W0 consent allowed exactly this SKILL.md, and only once', async () => {
    const sha = 'b'.repeat(64);
    const revision = { ...summary('deploy', 'quarantined', false, 'workspace'), skillMdSha256: sha };
    const stored: { path: 'SKILL.md'; sha256: string; allowedAt: string; workspaceId: string }[] = [];
    const details = () => ({ revision, manifest: '{}', files: [], inspections: [], approvals: [], history: [], consent: [...stored] });
    const daemon = fakeDaemon([], {}, SKILL_REGISTRY_OPS, {
      'skill.inspect': params => {
        if (typeof params.workspaceId === 'string' && !stored.some(input => input.workspaceId === params.workspaceId)) {
          stored.push({ path: 'SKILL.md', sha256: sha, allowedAt: '2026-10-21T08:00:00.000Z', workspaceId: params.workspaceId });
        }
        return details();
      },
    });
    const consent: SkillConsentWorkspace[] = [
      { id: 'w_mh3p2k1x9f04c2a7', allowed: { deploy: sha } },
      { id: 'w_mh3p2k1x9f04c2a8', allowed: { deploy: 'c'.repeat(64) } },
      { id: 'w_mh3p2k1x9f04c2a9', allowed: { other: sha } },
      { id: 'legacy-workspace', allowed: { deploy: sha } },
      { id: '00000000-0000-4000-8000-0000000000aa', allowed: { deploy: sha } },
    ];
    const registry = new SkillRegistry({ daemon: daemon.sidecar, dataDirectory: '/unused', profile: 'default', workspaceRoot: () => '', consentWorkspaces: async () => consent });
    const first = await registry.inspect(revision.revisionId);
    const inspects = () => daemon.calls.filter(call => call.op === 'skill.inspect').map(call => call.params);
    expect(inspects()).toEqual([
      { revisionId: revision.revisionId },
      { revisionId: revision.revisionId, workspaceId: 'w_mh3p2k1x9f04c2a7' },
      { revisionId: revision.revisionId, workspaceId: '00000000-0000-4000-8000-0000000000aa' },
    ]);
    expect(first.consent.map(input => input.workspaceId)).toEqual(['w_mh3p2k1x9f04c2a7', '00000000-0000-4000-8000-0000000000aa']);
    await registry.inspect(revision.revisionId);
    expect(inspects()).toHaveLength(4);

    // A refusal of the review input leaves the details as they were.
    const log: string[] = [];
    const strict = fakeDaemon([], {}, SKILL_REGISTRY_OPS, {
      'skill.inspect': params => { if (params.workspaceId) throw new DaemonRequestError('invalid_request'); return { ...details(), consent: [] }; },
    });
    const older = new SkillRegistry({ daemon: strict.sidecar, dataDirectory: '/unused', profile: 'default', workspaceRoot: () => '', consentWorkspaces: async () => consent, log: line => { log.push(line); } });
    expect((await older.inspect(revision.revisionId)).consent).toEqual([]);
    expect(log.join('\n')).toMatch(/not recorded as review input/);
    // Unreadable consent never blocks the details.
    const broken = new SkillRegistry({ daemon: strict.sidecar, dataDirectory: '/unused', profile: 'default', workspaceRoot: () => '', consentWorkspaces: async () => { throw new Error('disk'); } });
    expect((await broken.inspect(revision.revisionId)).revision.packageId).toBe('deploy');
  });
});
