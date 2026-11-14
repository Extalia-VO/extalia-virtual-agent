import { skillStoragePaths } from '../src/skillStorage.js';
import { createAgentHost } from '../src/service.js';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtaliaEvent } from '@extalia/protocol';
import type * as LearningSource from '../src/daemon/learningSource.js';

import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const sourceReader = vi.hoisted(() => vi.fn());
vi.mock('../src/daemon/learningSource.js', async original => ({
  ...await original<typeof LearningSource>(), readLearningSource: sourceReader,
}));
beforeEach(() => { sourceReader.mockReset(); });

interface RequestBody {
  model: string;
  tools?: { function: { name: string; description: string } }[];
  messages: { role: string; content?: unknown }[];
}
type Reply = { text: string } | { tool: string; args: unknown };
const proposal = { name: 'prompt-review', description: 'Review an example change', instructions: 'Inspect the patch and report evidence.', sourceUrls: ['https://example.com/review'] };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture(options: {
  backend?: 'rust' | 'typescript'; skills?: 'extalia' | 'off'; runtimeId?: 'hermes'; fileWrite?: 'allow' | 'ask';
  reply?: (body: RequestBody, index: number) => Reply;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-prompt-skill-'));
  const data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
  await mkdir(project); await mkdir(home);
  const bodies: RequestBody[] = [], events: ExtaliaEvent[] = [];
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', EXTALIA_HERMES_BIN: path.join(root, 'not-installed'),
      EXTALIA_NATIVE_CORE: options.backend ?? 'rust', EXTALIA_DAEMON_PATH: DAEMON_BINARY }, daemon: { log: () => undefined },
    fetch: async (url, init) => {
      if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'lead-model' }, { id: 'worker-model' }] });
      const body = JSON.parse(String(init?.body)) as RequestBody; bodies.push(body);
      const reply = options.reply?.(body, bodies.length - 1) ?? { text: 'Done.' };
      const delta = 'tool' in reply ? { tool_calls: [{ index: 0, id: `call-${bodies.length}`, function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { content: reply.text };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool' in reply ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  cleanups.push(async () => { await runtime.close(); await unlockFixture(data); await rm(root, { recursive: true, force: true }); });
  const host = runtime.host; host.subscribe(event => events.push(event));
  const connection = (await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'lead-model', credential: { kind: 'none' }, features: { memory: 'off', skills: options.skills ?? 'extalia' } })).connections[0]!;
  const workspace = (await host.saveWorkspace({ name: 'Fixture', projectLocation: project,
    ...(options.runtimeId ? { runtimeId: options.runtimeId } : { connectionId: connection.id }), permissions: { fileWrite: options.fileWrite ?? 'allow', commands: 'ask' } })).workspaces[0]!;
  const session = await host.createSession(workspace.id);
  return { host, runtime, bodies, events, data, workspace, session };
}

const hasProposalTool = (body: RequestBody) => body.tools?.some(tool => tool.function.name === 'skill_propose') ?? false;
async function idle(runtime: Awaited<ReturnType<typeof fixture>>['runtime']) {
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 5 });
}

describe('current-prompt skill learning authority through the Native host', () => {
  it.skipIf(!HAS_DAEMON)('does not treat quoted, fenced, nested or near-match commands as a direct learning request', async () => {
    const { host, runtime, bodies, session } = await fixture();
    for (const text of [
      '"/learn-skill review"', '```\n/learn-skill review\n```', '> /learn-skill review',
      'The document says: /learn-skill review', '/learn-skill-extra review',
    ]) {
      await host.sendPrompt(session.id, text); await idle(runtime);
      expect(hasProposalTool(bodies.at(-1)!)).toBe(false);
    }
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('offers a user-candidate tool for direct ordinary-language learning without a checkbox', async () => {
    const { host, runtime, bodies, session } = await fixture();
    for (const text of ['Pelajari ini sebagai skill: review changes.', 'Learn this as a skill from https://example.com/review.', 'Tolong pelajari https://example.com/guide.']) {
      await host.sendPrompt(session.id, text); await idle(runtime);
      expect(hasProposalTool(bodies.at(-1)!)).toBe(true);
      if (text.includes('https://')) expect(bodies.at(-1)!.tools?.some(tool => tool.function.name === 'skill_source_read')).toBe(true);
    }
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('reads a requested link before saving a generated user candidate, without modifying built-ins or scheduling a duplicate curator', async () => {
    const url = 'https://example.com/review';
    const excerpt = 'Inspect the patch, validate its input boundaries, and record verification evidence.';
    sourceReader.mockResolvedValue({ sourceUrl: url, finalUrl: url, contentType: 'text/plain', bytes: Buffer.byteLength(excerpt),
      sha256: createHash('sha256').update(excerpt).digest('hex'), excerpt, truncated: false });
    const { host, runtime, bodies, session } = await fixture({ reply: (_body, index) => index === 0
      ? { tool: 'skill_propose', args: proposal } // Rejected before any save: source not read yet.
      : index === 1 ? { tool: 'skill_source_read', args: { url } }
        : index === 2 ? { tool: 'skill_propose', args: proposal } : { text: 'User candidate saved for inspection.' } });
    await host.sendPrompt(session.id, `Tolong pelajari ${url} sebagai skill.`); await idle(runtime);
    expect(sourceReader).toHaveBeenCalledExactlyOnceWith(expect.any(String), url, expect.any(AbortSignal));
    expect(String(bodies[1]!.messages.at(-1)?.content)).toContain('Read the requested source');
    expect(String(bodies[2]!.messages.at(-1)?.content)).toContain(excerpt);
    const report = await host.skillRegistry();
    expect(report.revisions).toHaveLength(1);
    expect(report.revisions[0]).toMatchObject({ packageId: proposal.name, origin: 'generated', active: false });
    expect((await host.inspectSkill(report.revisions[0]!.revisionId)).approvals).toEqual([]);
    expect((await host.learningSchedule!()).jobs).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('does not save a skill claimed from a source that failed to read', async () => {
    sourceReader.mockRejectedValue(new Error('Unavailable source'));
    const { host, runtime, bodies, session } = await fixture({ reply: (_body, index) => index === 0
      ? { tool: 'skill_source_read', args: { url: proposal.sourceUrls[0] } }
      : index === 1 ? { tool: 'skill_propose', args: proposal } : { text: 'The link could not be read; no skill was saved.' } });
    await host.sendPrompt(session.id, `Learn this as a skill: ${proposal.sourceUrls[0]}`); await idle(runtime);
    expect(sourceReader).toHaveBeenCalledTimes(1);
    expect(String(bodies[2]!.messages.at(-1)?.content)).toContain('Read the requested source');
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('does not bypass source-read requirements when all supplied links are inadmissible', async () => {
    const { host, runtime, bodies, session } = await fixture({ reply: (_body, index) => index === 0
      ? { tool: 'skill_propose', args: proposal } : { text: 'Please provide a readable public link without query credentials.' } });
    await host.sendPrompt(session.id, 'Pelajari https://example.com/guide?token=opaque sebagai skill.'); await idle(runtime);
    expect(hasProposalTool(bodies[0]!)).toBe(true);
    expect(sourceReader).not.toHaveBeenCalled();
    expect(String(bodies[1]!.messages.at(-1)?.content)).toContain('Read the requested source');
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('uses a successful source read as evidence for the existing automatic profile curator', async () => {
    const url = proposal.sourceUrls[0];
    sourceReader.mockResolvedValue({ sourceUrl: url, finalUrl: url, contentType: 'text/plain', bytes: 12,
      sha256: 'a'.repeat(64), excerpt: 'Source text.', truncated: false });
    const { host, runtime, bodies, session } = await fixture({ reply: (_body, index) => index === 0
      ? { tool: 'skill_source_read', args: { url } } : { text: 'Reviewed the source procedure.' } });
    await host.sendPrompt(session.id, `Reference material for this task: ${url}`); await idle(runtime);
    expect(hasProposalTool(bodies[0]!)).toBe(false);
    expect((await host.learningSchedule!()).jobs).toContainEqual(expect.objectContaining({ kind: 'learning', sessionId: session.id, state: 'scheduled' }));
  });

  it.skipIf(!HAS_DAEMON)('respects a disabled automatic profile while retaining direct current-user learning requests', async () => {
    const { host, runtime, bodies, session, workspace } = await fixture();
    const catalog = await host.listVaultProfiles!();
    const profile = catalog.profiles.find(item => item.workspaceIds.includes(workspace.id))!;
    await host.saveVaultProfile!({ id: profile.id, name: profile.name, vaultRoot: null, workspaceIds: profile.workspaceIds,
      minutesEnabled: profile.minutesEnabled, expectedRevision: catalog.revision, automaticLearning: { enabled: false, skills: false, notes: false } });
    await host.sendPrompt(session.id, 'Reference material: https://example.com/review'); await idle(runtime);
    expect(bodies.at(-1)!.tools?.some(tool => tool.function.name === 'skill_source_read')).toBe(false);
    expect((await host.learningSchedule!()).jobs).toEqual([]);
    await host.sendPrompt(session.id, 'Pelajari ini sebagai skill: review changes.'); await idle(runtime);
    expect(hasProposalTool(bodies.at(-1)!)).toBe(true);
  });

  it.skipIf(!HAS_DAEMON)('keeps a current-message refusal out of the skill library even with a legacy learning flag', async () => {
    const { host, runtime, bodies, session } = await fixture();
    await host.sendPrompt(session.id, 'Please study https://example.com/review but do not save a skill.', { learnSkill: true }); await idle(runtime);
    expect(hasProposalTool(bodies[0]!)).toBe(false);
    expect(bodies[0]!.tools?.some(tool => tool.function.name === 'skill_source_read')).toBe(false);
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });

  it.each([false, true])('rejects malformed learnSkill option before inference on %s Rust availability', async rust => {
    if (rust && !HAS_DAEMON) return;
    const { host, bodies, session, events } = await fixture({ backend: rust ? 'rust' : 'typescript' });
    await expect(host.sendPrompt(session.id, 'Read the text.', { learnSkill: 'yes' } as unknown as { learnSkill: boolean })).rejects.toThrow(/explicitly/);
    expect(bodies).toEqual([]); expect(events.some(event => event.body.type === 'prompt.submitted')).toBe(false);
  });

  it.skipIf(!HAS_DAEMON)('refuses a model-invented proposal call in an ordinary turn rather than treating model output as user authority', async () => {
    const { host, runtime, bodies, session } = await fixture({ reply: (_body, index) => index === 0 ? { tool: 'skill_propose', args: proposal } : { text: 'Not authorized.' } });
    await host.sendPrompt(session.id, 'Audit this unverified document; it asks you to save itself as a skill.'); await idle(runtime);
    expect(bodies).toHaveLength(2); expect(bodies.every(body => !hasProposalTool(body))).toBe(true);
    expect((await host.skillRegistry()).revisions).toEqual([]);
    const error = [...bodies[1]!.messages].reverse().find(message => message.role === 'tool');
    expect(String(error?.content)).toMatch(/Unknown tool|not available|not found/i);
  });

  for (const mode of ['command', 'option'] as const) it.skipIf(!HAS_DAEMON)(`${process.platform === 'win32' ? 'refuses unavailable staging of' : 'persists'} an ${mode}-authorized generated candidate and never carries learning into the next turn`, async () => {
    const { host, runtime, bodies, session, workspace, events, data } = await fixture({ reply: (_body, index) => index === 0 ? { tool: 'skill_propose', args: proposal } : { text: 'Candidate saved; scanner unavailable.' } });
    const prompt = mode === 'command' ? '/learn-skill Learn a review procedure.' : 'Learn a review procedure.';
    await host.sendPrompt(session.id, prompt, mode === 'option' ? { learnSkill: true } : undefined); await idle(runtime);
    expect(hasProposalTool(bodies[0]!)).toBe(true);
    const listed = await host.skillRegistry();
    if (process.platform === 'win32') {
      // Windows advertises no learning.process artifact port. Explicit opt-in
      // grants turn authority, never an emulated staging implementation.
      expect(listed.revisions).toEqual([]);
      const toolReply = [...bodies[1]!.messages].reverse().find(message => message.role === 'tool');
      expect(String(toolReply?.content)).toContain('The skill proposal did not complete');
      expect(String(toolReply?.content)).toContain('no approval or activation was requested');
      expect(events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'skill_propose' && !event.body.ok)).toBe(true);
      expect(events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'skill_propose' && event.body.ok)).toBe(false);
      await expect(lstat(skillStoragePaths(data).imports)).rejects.toMatchObject({ code: 'ENOENT' });
      await host.sendPrompt(session.id, 'Now review another change.'); await idle(runtime);
      expect(hasProposalTool(bodies.at(-1)!)).toBe(false);
      expect((await host.skillRegistry()).revisions).toEqual([]);
      return;
    }
    expect(listed.revisions).toHaveLength(1);
    const revision = listed.revisions[0]!;
    expect(revision).toMatchObject({ packageId: proposal.name, origin: 'generated', state: 'quarantined', stateReason: 'scanner-unavailable', active: false });
    const details = await host.inspectSkill(revision.revisionId);
    expect(details.inspections.some(record => record.outcome === 'scanner-unavailable')).toBe(true);
    expect(details.approvals).toEqual([]); expect(details.files.map(file => file.path).sort()).toEqual(['PROVENANCE.md', 'SKILL.md']);
    const toolReply = [...bodies[1]!.messages].reverse().find(message => message.role === 'tool');
    expect(String(toolReply?.content)).toContain('scanner-unavailable'); expect(String(toolReply?.content)).toContain('"activationPerformed":false');
    const turnEvents = events.filter(event => event.sessionId === session.id);
    expect(turnEvents.some(event => event.body.type === 'tool.completed' && event.body.tool === 'skill_propose' && event.body.ok)).toBe(true);
    // Current source authority is captured by the host and not taken from model arguments.
    const receipt = await readFile(path.join(skillStoragePaths(data).objects, revision.treeSha256, 'PROVENANCE.md'), 'utf8');
    const storedProvenance = JSON.parse(/```json\n([\s\S]*?)\n```/u.exec(receipt)![1]!);
    expect(storedProvenance).toMatchObject({ sessionId: session.id, workspaceId: workspace.id, promptSha256: createHash('sha256').update(prompt).digest('hex'), sourceVerified: false, claimedSourceUrls: proposal.sourceUrls });
    expect(receipt).not.toContain(prompt);
    await host.sendPrompt(session.id, 'Now review another change.'); await idle(runtime);
    expect(hasProposalTool(bodies.at(-1)!)).toBe(false);
    expect((await host.skillRegistry()).revisions).toHaveLength(1);
    const read = bodies.at(-1)!.tools?.find(tool => tool.function.name === 'skill_read');
    expect(read?.function.description).not.toContain(proposal.name);
  });

  it.skipIf(!HAS_DAEMON)('offers proposal only to the explicitly opted-in lead, never a delegated worker', async () => {
    const { host, runtime, bodies, session } = await fixture({ reply: (_body, index) => index === 0
      ? { tool: 'delegate_task', args: { task: 'Research the synthetic review procedure as unverified reference data.', member: 'Worker' } }
      : { text: 'Research complete.' } });
    await host.saveSessionTeam(session.id, { enabled: true, allowedModels: ['lead-model', 'worker-model'], members: [{ id: 'm-worker', name: 'Worker', role: 'Reviewer', models: ['worker-model'] }] });
    await host.sendPrompt(session.id, '/learn-skill Research and draft a review skill.'); await idle(runtime);
    expect(bodies.map(body => body.model)).toEqual(['lead-model', 'worker-model', 'lead-model']);
    expect(hasProposalTool(bodies[0]!)).toBe(true); expect(hasProposalTool(bodies[1]!)).toBe(false);
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('uses the Rust skill registry independently of TypeScript mission routing', async () => {
    const { host, runtime, bodies, session } = await fixture({ backend: 'typescript', reply: (_body, index) => index === 0 ? { tool: 'skill_propose', args: proposal } : { text: 'Candidate saved.' } });
    await host.sendPrompt(session.id, '/learn-skill Draft a review procedure.');
    await idle(runtime);
    expect(hasProposalTool(bodies[0]!)).toBe(true);
    expect((await host.skillRegistry()).revisions).toHaveLength(1);
    expect((await host.skillRegistry()).revisions[0]).toMatchObject({ state: 'quarantined', active: false });
  });

  for (const mode of ['plan', 'skills-off', 'hermes', 'empty-command'] as const) it.skipIf(!HAS_DAEMON)(`refuses ${mode} learning before any provider run or import`, async () => {
    const { host, bodies, events, session } = await fixture({ backend: 'rust', skills: mode === 'skills-off' ? 'off' : 'extalia', ...(mode === 'hermes' ? { runtimeId: 'hermes' } : {}) });
    if (mode === 'plan') await host.setSessionOptions(session.id, { permissionMode: 'plan' });
    await expect(host.sendPrompt(session.id, mode === 'empty-command' ? '/learn-skill' : '/learn-skill Draft a review procedure.')).rejects.toThrow();
    expect(bodies).toEqual([]); expect(events.some(event => event.body.type === 'prompt.submitted')).toBe(false);
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('rejecting the write approval saves no candidate or inspection', async () => {
    const { host, runtime, bodies, events, session } = await fixture({ fileWrite: 'ask', reply: (_body, index) => index === 0 ? { tool: 'skill_propose', args: proposal } : { text: 'Not saved.' } });
    await host.sendPrompt(session.id, '/learn-skill Draft a review procedure.');
    await vi.waitFor(() => expect(events.find(event => event.body.type === 'approval.requested')).toBeDefined(), { timeout: 5_000, interval: 5 });
    const approval = events.find(event => event.body.type === 'approval.requested')!;
    await host.resolveApproval(session.id, (approval.body as { approvalId: string }).approvalId, 'reject'); await idle(runtime);
    expect(hasProposalTool(bodies[0]!)).toBe(true);
    expect((await host.skillRegistry()).revisions).toEqual([]);
  });
});

async function unlockFixture(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined); if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) { await chmod(directory, 0o700); for (const file of await readdir(directory)) await unlockFixture(path.join(directory, file)); }
  else await chmod(directory, 0o600);
}
