import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTeam } from '@extalia/core';
import type { KnowledgeLinkPage, KnowledgeNoteResult, LearningScheduleJob } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import type { NativeMeetingMinutes } from '@extalia/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';
import { learningObservedFixture } from './learningObservedFixture.js';
import { LearningQueueAdmissions } from '../src/learningQueue.js';
import { VaultProfiles } from '../src/vaultProfiles.js';

const temp = useTempDirs(), runtimes: AgentHostRuntime[] = [];
// Durable learning publication currently requires the Rust POSIX directory-handle backend.
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
interface Body { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] }
interface Request { body: Body; meeting: boolean; projectBuild: boolean; prompt: string; url: string; signal?: AbortSignal | null }
const planningRequest = (body: Body) => body.messages[0]?.content?.startsWith('You split software work into a team of helper agents') ?? false;
function response(text: string, read = false) {
  const delta = read ? { tool_calls: [{ index: 0, id: 'read-parser', function: { name: 'read_file', arguments: JSON.stringify({ path: 'parser.txt' }) } }] } : { content: text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: read ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const idle = async (runtime: AgentHostRuntime) => { await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 5 }); };
function projectResponse(prompt: string) {
  const sources = JSON.parse(prompt.split('\n')[1]!) as { evidence: { evidenceId: string; text: string }[] }[];
  const topics = [{ key: 'input-validation', title: 'Input validation', citations: sources.map(source => {
    const selected = source.evidence.find(item => item.text.includes('Validate ')) ?? source.evidence[0];
    if (!selected) throw new Error('The test source has no offered evidence to select.');
    return { evidenceId: selected.evidenceId };
  }) }];
  const delta = { tool_calls: [{ index: 0, id: 'submit-project-topics', function: {
    name: 'submit_project_topics', arguments: JSON.stringify({ topics }),
  } }] };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}


async function fixture(options: { lead?(prompt: string): Promise<void>; sourceReply?(prompt: string): string; meeting?(request: Request): Promise<string | void>; projectBuild?(request: Request): Promise<void>; workerSkills?: 'off' | 'extalia'; isolated?: boolean; sharedConnection?: boolean; exportFailure?: boolean; curatorSkills?: boolean; realExport?: boolean } = {}) {
  const root = await temp('extalia-knowledge-meeting-'), data = path.join(root, 'data'), home = path.join(root, 'home');
  const project = path.join(root, 'project'), otherProject = path.join(root, 'other-project');
  await Promise.all([home, project, otherProject].map(folder => mkdir(folder)));
  await writeFile(path.join(project, 'parser.txt'), 'Validate input before saving parsed data.');
  const sourceFile = path.join(project, 'knowledge.md');
  const sourceText = '---\ntitle: Input validation\nstatus: Confirmed Canon\n---\n\n# Input validation\n\nValidate input before durable writes and retain source citations.\n';
  await Promise.all([sourceFile, path.join(project, 'knowledge-copy.md')].map(file => writeFile(file, sourceText)));
  const requests: Request[] = [], events: ExtaliaEvent[] = [], exports: { minutes: NativeMeetingMinutes; sessionId: string; workspaceId: string; path: string }[] = [];
  const readPrompts = new Set<string>();
  let vaultRoot = '';
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_HERMES_BIN: path.join(root, 'missing'), PATH: '' },
    daemon: { log: () => {} }, modelDiscovery: async () => ['fixture-model'],
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Body;
      const meeting = body.messages[0]?.content?.startsWith('You are a worker agent helping') ?? false;
      const prompt = body.messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
      const projectBuild = body.tools?.some(tool => tool.function.name === 'submit_project_topics') ?? false;
      const request = { body, meeting, projectBuild, prompt, url, signal: init?.signal };
      requests.push(request);
      if (projectBuild) { await options.projectBuild?.(request); return projectResponse(prompt); }
      const meetingReply = meeting ? await options.meeting?.(request) : undefined;
      if (!meeting) await options.lead?.(prompt);
      if (planningRequest(body)) return response(JSON.stringify({ members: [{ role: 'Reviewer', task: 'Review the project plan', model: 'fixture-model' }] }));
      if (!meeting && prompt.startsWith('Read') && !readPrompts.has(prompt)) { readPrompts.add(prompt); return response('', true); }
      return response(meeting ? meetingReply ?? `Actual reviewer finding ${requests.filter(request => request.meeting).length}.` : options.sourceReply?.(prompt) ?? 'Source task completed.');
    },
    ...(!options.realExport ? { onMeetingMinutes: async (minutes: NativeMeetingMinutes, context: { sessionId: string; workspaceId: string }) => {
      if (options.exportFailure) throw new Error('The test vault refused this export.');
      const folder = path.join(vaultRoot, 'Meetings', context.workspaceId);
      await mkdir(folder, { recursive: true });
      const file = path.join(folder, `${minutes.meetingId}.md`);
      await writeFile(file, `${context.sessionId}\n${minutes.contributions.map(contribution => contribution.text).join('\n')}\n`, 'utf8');
      exports.push({ minutes, ...context, path: file });
      return file;
    } } : {}),
  });
  runtimes.push(runtime);
  const host = runtime.host; host.subscribe(event => events.push(event));
  const connection = (await host.saveConnection({ name: 'Fixture lead', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: options.workerSkills || options.curatorSkills ? 'extalia' : 'off', history: true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections[0]!;
  const workspace = (await host.saveWorkspace({ name: 'Source project', projectLocation: project, connectionId: connection.id, ...(options.isolated ? { crossWorkspaceAccess: 'isolated' } : {}), permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const otherConnection = options.isolated && !options.sharedConnection ? (await host.saveConnection({ name: 'Other profile connection', preset: 'custom', api: 'openai-chat', baseUrl: 'https://other.example/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } })).connections.find(item => item.name === 'Other profile connection')! : connection;
  const otherWorkspace = (await host.saveWorkspace({ name: 'Other project', projectLocation: otherProject, connectionId: otherConnection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.id !== workspace.id)!;
  const before = await host.listVaultProfiles!();
  const catalog = await host.saveVaultProfile!({ name: 'Knowledge fixture', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: true,
    automaticLearning: { enabled: true, skills: options.curatorSkills ?? false, notes: true }, expectedRevision: before.revision });
  const profile = catalog.profiles.find(item => item.workspaceIds.includes(workspace.id))!;
  vaultRoot = profile.root;
  const session = await host.createSession(workspace.id), otherSession = await host.createSession(otherWorkspace.id);
  let team: AgentTeam = { enabled: true, allowedModels: ['fixture-model'], members: [{ id: 'reviewer-one', name: 'Reviewer', role: 'Knowledge reviewer', models: ['fixture-model'], access: 'read' }] };
  if (options.workerSkills) {
    const saved = await host.saveConnection({ name: 'Fixture worker', preset: 'custom', api: 'openai-chat', baseUrl: 'https://worker.example/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: options.workerSkills, history: true } });
    const worker = saved.connections.find(item => item.name === 'Fixture worker')!;
    team = { ...team, connections: [{ connectionId: connection.id, allowedModels: ['fixture-model'] }, { connectionId: worker.id, allowedModels: ['fixture-model'] }],
      members: team.members.map(member => ({ ...member, connectionId: worker.id })) };
  }
  await host.saveSessionTeam(session.id, team);
  const job = async () => (await host.learningSchedule!()).jobs.filter(item => (item.kind === 'knowledge-meeting' || item.kind === 'knowledge-build') && item.workspaceId === workspace.id).at(-1);
  const waitForJob = async (state: LearningScheduleJob['state'], waitingForIdle?: boolean) => {
    let found: LearningScheduleJob | undefined;
    // First-use daemon indexing and durable minutes publication contend with the full suite.
    // Await the requested state; a running or failed meeting still cannot count as completed.
    await vi.waitFor(async () => { found = await job(); expect(found?.state).toBe(state); if (waitingForIdle !== undefined) expect(found?.waitingForIdle === true).toBe(waitingForIdle); }, { timeout: 10_000, interval: 5 });
    return found!;
  };
  const action = async (action: 'run-now' | 'snooze') => {
    const snapshot = await host.learningSchedule!();
    const current = snapshot.jobs.filter(item => (item.kind === 'knowledge-meeting' || item.kind === 'knowledge-build') && item.workspaceId === workspace.id).at(-1)!;
    return host.changeLearningSchedule!(current.id, snapshot.revision, action);
  };
  return { runtime, host, requests, events, exports, project, sourceFile, session, workspace, otherSession, otherWorkspace, profile, team, job, waitForJob, action };
}

describe('native knowledge meetings through the deferred host scheduler', () => {
  it('queues one Knowledge owner without a redundant curator when skills are disabled', async () => {
    const f = await fixture();
    const capture = vi.spyOn(LearningQueueAdmissions.prototype, 'native');
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser and retain its verified decision.'); await idle(f.runtime);
      expect((await f.host.learningSchedule!()).jobs.map(job => job.kind)).toEqual(['knowledge-meeting']);
      expect(capture).not.toHaveBeenCalled();
      await f.action('run-now'); await f.waitForJob('completed'); await idle(f.runtime);
      expect(f.exports).toHaveLength(1);
    } finally { capture.mockRestore(); }
  });

  it('schedules an explicit project build after ten seconds and coalesces repeated requests', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Record the verified parser decision.'); await idle(f.runtime);
    const first = await f.host.requestKnowledgeUpdate!(f.workspace.id);
    const queued = first.jobs.filter(job => job.state === 'scheduled');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'knowledge-build', delaySeconds: 10, sessionId: f.session.id, waitingForIdle: false });
    expect(Date.parse(queued[0]!.dueAt) - Date.now()).toBeGreaterThan(9_000);
    expect(Date.parse(queued[0]!.dueAt) - Date.now()).toBeLessThanOrEqual(10_000);
    const second = await f.host.requestKnowledgeUpdate!(f.workspace.id);
    const repeated = second.jobs.filter(job => job.state === 'scheduled');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ id: queued[0]!.id, dueAt: queued[0]!.dueAt });
    expect(f.requests.filter(request => request.meeting || request.projectBuild)).toHaveLength(0);
    expect(f.events.some(event => event.body.type === 'file.read' && event.body.path.endsWith('knowledge.md'))).toBe(false);
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('publishes source-grounded linked Knowledge with the real daemon and reuses unchanged output', async () => {
    const f = await fixture({ realExport: true, isolated: true });
    await f.host.sendPrompt(f.session.id, 'Record the verified parser decision.'); await idle(f.runtime);
    await f.host.requestKnowledgeUpdate!(f.workspace.id); await f.action('run-now');
    const completed = await f.waitForJob('completed'); await idle(f.runtime);
    expect(completed.result?.project).toMatchObject({ status: 'saved', inventory: 2, read: 2, unique: 1, deduplicated: 1,
      topics: 1, modelRequests: 1, synthesizedSources: 1, conflicts: 0, indexed: true });
    expect(completed.result?.meeting).toBeUndefined();
    const base = `Projects/${f.workspace.id}/Knowledge`, folder = path.join(f.profile.root, base);
    const overview = await readFile(path.join(folder, 'Overview.md'), 'utf8');
    expect(overview).toContain('[[Projects/');
    expect(overview).toContain('2 Markdown sources were read; 1 unique source contents');
    const topic = await readFile(path.join(folder, 'Topics', 'input-validation.md'), 'utf8');
    expect(topic.split('Validate input before durable writes and retain source citations.')).toHaveLength(2);
    expect(topic).toContain('[[Projects/');
    const overviewNote = await f.host.workspaceKnowledge!(f.workspace.id, 'knowledgeNode', [{ path: `${base}/Overview.md` }]) as KnowledgeNoteResult | null;
    expect(overviewNote).not.toBeNull();
    const links = await f.host.workspaceKnowledge!(f.workspace.id, 'knowledgeLinks', [overviewNote!.node.nodeId]) as KnowledgeLinkPage;
    expect(links.links.length).toBeGreaterThan(0);
    expect(links.links.every(link => link.status === 'resolved')).toBe(true);
    const before = (await readdir(folder, { recursive: true })).sort();
    await f.host.requestKnowledgeUpdate!(f.workspace.id); await f.action('run-now');
    const unchanged = await f.waitForJob('completed'); await idle(f.runtime);
    expect(unchanged.result?.project).toMatchObject({ status: 'unchanged', created: 0, updated: 0, modelRequests: 0, indexed: true });
    expect(unchanged.result!.project!.unchanged).toBeGreaterThan(0);
    expect((await readdir(folder, { recursive: true })).sort()).toEqual(before);
    expect(f.requests.filter(request => request.projectBuild)).toHaveLength(1);
    expect(f.requests.filter(request => request.meeting)).toHaveLength(0);
    expect(f.exports).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('reuses a running project build when the manual action is clicked again', async () => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ realExport: true, projectBuild: async () => { entered.resolve(); await release.promise; } });
    await f.host.sendPrompt(f.session.id, 'Record the source decision.'); await idle(f.runtime);
    try {
      const first = await f.host.requestKnowledgeUpdate!(f.workspace.id);
      const original = first.jobs.find(job => job.kind === 'knowledge-build')!;
      await f.action('run-now'); await entered.promise;
      const second = await f.host.requestKnowledgeUpdate!(f.workspace.id);
      const builds = second.jobs.filter(job => job.kind === 'knowledge-build' && (job.state === 'scheduled' || job.state === 'running'));
      expect(builds).toHaveLength(1);
      expect(builds[0]).toMatchObject({ id: original.id, state: 'running' });
      expect(f.requests.filter(request => request.projectBuild)).toHaveLength(1);
      release.resolve();
      expect((await f.waitForJob('completed')).result?.project).toMatchObject({ status: 'saved', indexed: true });
      expect(f.requests.filter(request => request.projectBuild)).toHaveLength(1);
    } finally { release.resolve(); await idle(f.runtime); }
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('allows an explicit project build with automatic learning and minutes disabled', async () => {
    const f = await fixture({ realExport: true });
    await f.host.sendPrompt(f.session.id, 'Record the verified parser decision.'); await idle(f.runtime);
    const catalog = await f.host.listVaultProfiles!();
    await f.host.saveVaultProfile!({ id: f.profile.id, name: f.profile.name, vaultRoot: null, workspaceIds: [f.workspace.id],
      minutesEnabled: false, automaticLearning: { enabled: false, skills: false, notes: false }, expectedRevision: catalog.revision });
    await f.host.requestKnowledgeUpdate!(f.workspace.id); await f.action('run-now');
    expect((await f.waitForJob('completed')).result?.project).toMatchObject({ status: 'saved', read: 2, topics: 1, indexed: true });
    expect(f.exports).toEqual([]);
    expect(f.requests.filter(request => request.meeting)).toHaveLength(0);
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('uses only idle roster members while the same member works in another isolated project', async () => {
    const entered = deferred(), release = deferred(), sourceEntered = deferred(), sourceRelease = deferred();
    const f = await fixture({ realExport: true, isolated: true, lead: async prompt => {
      if (prompt === 'Hold the shared reviewer busy.') { entered.resolve(); await release.promise; }
      if (prompt === 'Hold the source review.') { sourceEntered.resolve(); await sourceRelease.promise; }
    } });
    await f.host.saveSessionTeam(f.session.id, { ...f.team, members: [...f.team.members,
      { id: 'reviewer-idle', name: 'Idle reviewer', role: 'Analyst', models: ['fixture-model'], access: 'read' },
    ] });
    await f.host.saveSessionTeam(f.otherSession.id, f.team);
    await f.host.sendPrompt(f.session.id, 'Record the verified parser decision.'); await idle(f.runtime);
    try {
      await f.host.sendPrompt(f.otherSession.id, 'Hold the shared reviewer busy.'); await entered.promise;
      await f.host.sendPrompt(f.session.id, 'Hold the source review.'); await sourceEntered.promise;
      const snapshot = await f.host.requestKnowledgeUpdate!(f.workspace.id);
      const manual = snapshot.jobs.find(job => job.state === 'scheduled')!;
      sourceRelease.resolve(); await f.waitForJob('scheduled', false);
      expect((await f.job())?.id).toBe(manual.id);
      await f.action('run-now');
      expect((await f.waitForJob('completed')).result?.project).toMatchObject({ status: 'saved', indexed: true });
      const extraction = f.events.filter(event => event.body.type === 'tool.started' && event.body.tool === 'project_knowledge_extract');
      expect(extraction.map(event => event.agentId)).toEqual(['reviewer-idle']);
      expect(f.exports).toEqual([]);
      expect((await f.host.getState()).sessions.find(session => session.id === f.otherSession.id)?.running).toBe(true);
    } finally { sourceRelease.resolve(); release.resolve(); await idle(f.runtime); }
  });

  it('keeps ordinary note curation when effective minutes consent is unavailable', async () => {
    const f = await fixture();
    const resolve = VaultProfiles.prototype.resolve;
    const destination = vi.spyOn(VaultProfiles.prototype, 'resolve').mockImplementation(function (this: VaultProfiles, workspaceId, options) {
      if (options?.purpose !== 'learning') return Promise.reject(new Error('Minutes consent does not match this custom vault.'));
      return resolve.call(this, workspaceId, options);
    });
    const capture = vi.spyOn(LearningQueueAdmissions.prototype, 'native').mockRejectedValueOnce(new Error('Fixture capture unavailable.'));
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser and preserve its findings.'); await idle(f.runtime);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]![0].policy).toMatchObject({ notes: true, skills: false });
      expect(await f.job()).toBeUndefined();
    } finally { destination.mockRestore(); capture.mockRestore(); }
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32').each([false, true])('preserves a busy-source manual request and reads fresh files after foreground work settles (automatic: %s)', async automatic => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ realExport: true, lead: async prompt => {
      if (prompt === 'Hold while checking the updated decision.') { entered.resolve(); await release.promise; }
    }, sourceReply: prompt => prompt === 'Hold while checking the updated decision.' ? 'Latest completed decision: validate every input before durable writes.' : 'Previous source outcome.' });
    await f.host.sendPrompt(f.session.id, 'Record the previous decision.'); await idle(f.runtime);
    const catalog = await f.host.listVaultProfiles!();
    await f.host.saveVaultProfile!({ id: f.profile.id, name: f.profile.name, vaultRoot: null, workspaceIds: [f.workspace.id],
      minutesEnabled: true, automaticLearning: { enabled: automatic, skills: false, notes: automatic }, expectedRevision: catalog.revision });
    try {
      await f.host.sendPrompt(f.session.id, 'Hold while checking the updated decision.'); await entered.promise;
      await writeFile(f.sourceFile, '# Updated validation\n\nValidate every input before durable writes; this is the latest source decision.\n');
      const snapshot = await f.host.requestKnowledgeUpdate!(f.workspace.id);
      const manual = snapshot.jobs.find(job => job.state === 'scheduled')!;
      expect(manual).toMatchObject({ kind: 'knowledge-build', delaySeconds: 10, waitingForIdle: true });
      expect(f.requests.filter(request => request.meeting || request.projectBuild)).toHaveLength(0);
      expect(f.events.some(event => event.body.type === 'file.read' && event.body.path === 'knowledge.md')).toBe(false);
      release.resolve(); await idle(f.runtime);
      expect((await f.job())?.id).toBe(manual.id);
      await f.action('run-now'); await f.waitForJob('completed'); await idle(f.runtime);
      expect(f.requests.filter(request => request.projectBuild)).toHaveLength(1);
      expect(f.requests.find(request => request.projectBuild)?.prompt).toContain('Validate every input before durable writes; this is the latest source decision.');
      expect(f.events.some(event => event.body.type === 'file.read' && event.body.path === 'knowledge.md')).toBe(true);
      expect((await f.job())?.result?.project).toMatchObject({ status: 'saved', read: 2, indexed: true });
      expect(f.exports).toEqual([]);
    } finally { release.resolve(); await idle(f.runtime); }
  });

  it('refuses a manual update with no saved Native team session', async () => {
    const f = await fixture();
    await expect(f.host.requestKnowledgeUpdate!(f.otherWorkspace.id)).rejects.toThrow(/Native session/);
    expect(f.requests.filter(request => request.meeting)).toHaveLength(0);
  });

  it('keeps the independent Knowledge meeting when durable curator admission is full', async () => {
    const f = await fixture({ curatorSkills: true });
    const capture = vi.spyOn(LearningQueueAdmissions.prototype, 'native').mockRejectedValueOnce(new Error('learning_journal_capacity'));
    try {
      await f.host.sendPrompt(f.session.id, 'Record the parser validation decision.');
      await idle(f.runtime);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]![0].policy).toMatchObject({ notes: false, skills: true });
      await f.waitForJob('scheduled', false);
      expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'automatic_learning' && event.body.ok === false)).toBe(true);
      await f.action('run-now');
      await f.waitForJob('completed'); await idle(f.runtime);
      expect(f.exports).toHaveLength(1);
      expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
    } finally { capture.mockRestore(); }
  });

  it('does not queue an independent meeting when capture failure also revokes learning consent', async () => {
    const f = await fixture({ curatorSkills: true });
    const policyFor = VaultProfiles.prototype.policyFor;
    let revoked = false;
    const policy = vi.spyOn(VaultProfiles.prototype, 'policyFor').mockImplementation(async function (this: VaultProfiles, workspaceId?: string) {
      const current = await policyFor.call(this, workspaceId);
      return revoked ? { ...current, revision: `${current.revision}-revoked`, policy: { enabled: false, skills: false, notes: false } } : current;
    });
    const capture = vi.spyOn(LearningQueueAdmissions.prototype, 'native').mockImplementationOnce(async () => {
      revoked = true;
      throw new Error('The learning source or consent changed.');
    });
    try {
      await f.host.sendPrompt(f.session.id, 'Record the parser validation decision.'); await idle(f.runtime);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(await f.job()).toBeUndefined();
      expect(f.exports).toEqual([]);
      expect(f.requests.filter(request => request.meeting)).toEqual([]);
      expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'automatic_learning' && event.body.ok === false)).toBe(true);
    } finally { capture.mockRestore(); policy.mockRestore(); }
  });

  it.each(['same', 'foreign'] as const)('isolated Knowledge meetings wait only for %s-profile Native work on a shared connection', async scope => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ isolated: true, lead: async prompt => { if (prompt === 'Hold Native profile work.') { entered.resolve(); await release.promise; } } });
    const target = scope === 'same' ? f.session.id : f.otherSession.id;
    try {
      await f.host.sendPrompt(f.session.id, 'Record the project decision before profile concurrency.'); await idle(f.runtime); await f.waitForJob('scheduled');
      await f.host.sendPrompt(target, 'Hold Native profile work.'); await entered.promise;
      await f.action('run-now');
      if (scope === 'foreign') {
        await f.waitForJob('completed');
        expect(f.exports).toHaveLength(1);
        expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
        expect((await f.host.getState()).sessions.find(item => item.id === target)?.running).toBe(true);
      } else {
        expect(await f.waitForJob('scheduled', true)).toMatchObject({ reason: 'busy' });
        expect(f.requests.some(request => request.meeting)).toBe(false);
      }
    } finally { release.resolve(); await idle(f.runtime); }
  });

  it.each(['same', 'foreign', 'unbound', 'ambiguous', 'invalid'] as const)('isolated Knowledge meetings check %s observed ownership and preserve other queued prompts', async scope => {
    const f = await fixture({ isolated: true });
    const unregistered = path.join(path.dirname(f.workspace.projectLocation!), 'unregistered-project'); await mkdir(unregistered);
    if (scope === 'ambiguous') await f.host.saveWorkspace({ name: 'Overlapping project', projectLocation: f.otherWorkspace.projectLocation!, connectionId: f.otherWorkspace.providerProfileId, permissions: { fileWrite: 'ask', commands: 'ask' } });
    const project = scope === 'same' ? f.workspace.projectLocation! : scope === 'unbound' ? unregistered : f.otherWorkspace.projectLocation!;
    const observed = await learningObservedFixture(f.runtime, project);
    if (scope === 'invalid') {
      const link = await f.host.observedWorkspaceLink!(observed.sessionId);
      await f.host.setObservedWorkspaceLink!(observed.sessionId, { revision: link.revision, workspaceId: f.otherWorkspace.id });
      await observed.changeProject(unregistered);
    }
    const expectedLink = scope === 'ambiguous' || scope === 'invalid' || scope === 'unbound' ? scope : 'automatic';
    await vi.waitFor(async () => expect((await f.host.observedWorkspaceLink!(observed.sessionId)).mode).toBe(expectedLink), { timeout: 5_000, interval: 5 });
    const queue = await f.host.promptQueueStatus!(observed.sessionId);
    await f.host.changePromptQueue!(observed.sessionId, { revision: queue.revision, action: 'add', text: 'Keep the observed project draft paused.' });
    await f.host.sendPrompt(f.session.id, 'Record the project decision while another app works.'); await idle(f.runtime);
    await f.waitForJob('scheduled'); await f.action('run-now');
    if (scope === 'foreign' || scope === 'unbound') {
      await f.waitForJob('completed');
      expect(f.exports).toHaveLength(1);
      expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
      expect(JSON.stringify(f.requests.filter(request => request.meeting))).not.toContain('foreign project research');
    } else {
      expect(await f.waitForJob('scheduled', true)).toMatchObject({ reason: 'busy' });
      expect(f.requests.some(request => request.meeting)).toBe(false);
      expect(f.exports).toEqual([]);
    }
    expect((await f.host.getState()).sessions.find(item => item.id === observed.sessionId)?.running).toBe(true);
    expect(await f.host.promptQueueStatus!(observed.sessionId)).toMatchObject({ paused: true, items: [expect.objectContaining({ state: 'pending' })] });
  });
  it('queues only redacted current-turn prompt and assistant decisions, excluding prior conversation', async () => {
    const promptCredential = 'synthetic-prompt-credential-'.repeat(60);
    const answerCredential = 'synthetic-answer-credential-'.repeat(60);
    const priorPrompt = 'Earlier unrelated user evidence.';
    const f = await fixture({ sourceReply: prompt => prompt === priorPrompt
      ? 'Earlier unrelated assistant evidence.'
      : `Current assistant decision: reject invalid input. api_key=${answerCredential}` });
    await f.host.sendPrompt(f.session.id, priorPrompt); await idle(f.runtime);
    await f.host.sendPrompt(f.session.id, `Current user decision: validate before saving. Authorization: Bearer ${promptCredential}`);
    await idle(f.runtime); await f.waitForJob('scheduled', false);
    const meetingStart = f.events.length;
    await f.action('run-now'); await f.waitForJob('completed'); await idle(f.runtime);
    const workers = f.requests.filter(request => request.meeting);
    expect(workers).toHaveLength(1);
    expect(f.exports).toHaveLength(1);
    const exported = f.exports[0]!;
    const persistedMeeting = (await f.host.sessionEvents(f.session.id)).filter(event => event.body.type === 'meeting.started'
      && event.body.meetingId === exported.minutes.meetingId);
    expect(persistedMeeting).toHaveLength(1);
    expect(persistedMeeting[0]).toMatchObject({ sessionId: f.session.id, body: { meetingId: exported.minutes.meetingId } });
    expect(exported).toMatchObject({ sessionId: f.session.id, workspaceId: f.workspace.id,
      minutes: { topic: 'Project knowledge review' } });
    for (const projection of [workers, f.events.slice(meetingStart), persistedMeeting, f.exports.map(saved => saved.minutes)]) {
      const text = JSON.stringify(projection);
      expect(text).not.toContain('synthetic-prompt-credential-');
      expect(text).not.toContain('synthetic-answer-credential-');
      expect(text).not.toContain('Earlier unrelated user evidence.');
      expect(text).not.toContain('Earlier unrelated assistant evidence.');
    }
    for (const projection of [workers, f.events.slice(meetingStart), persistedMeeting]) {
      const text = JSON.stringify(projection);
      expect(text).toContain('[redacted]');
      expect(text).toContain('Current user decision: validate before saving.');
      expect(text).toContain('Current assistant decision: reject invalid input.');
    }
  });

  it.each([false, true])('preserves a mid-turn user reversal in the Knowledge meeting when the final answer omits it (isolated: %s)', async isolated => {
    const initial = 'Record the retention decision: keep raw audit logs indefinitely.';
    const correction = 'Correction: retain raw audit logs for seven days, then delete them. Indefinite retention is no longer permitted.';
    const answer = 'The requested review is complete.';
    const entered = deferred(), release = deferred();
    const f = await fixture({ isolated, sourceReply: () => answer, lead: async prompt => {
      if (prompt === initial) { entered.resolve(); await release.promise; }
    } });
    try {
      await f.host.sendPrompt(f.session.id, initial);
      await entered.promise;
      let queue = await f.host.promptQueueStatus!(f.session.id);
      expect(queue.canSteer).toBe(true);
      queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'add', text: correction });
      queue = await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'steer', itemId: queue.items[0]!.id });
      expect(queue.items[0]?.state).toBe('sent');
      expect(f.requests.filter(request => !request.meeting).map(request => request.prompt)).toEqual([initial]);
    } finally { release.resolve(); }
    await idle(f.runtime);
    expect(f.requests.filter(request => !request.meeting).map(request => request.prompt)).toEqual([initial, correction]);
    const sourceEvents = await f.host.sessionEvents(f.session.id);
    expect(sourceEvents.filter(event => event.body.type === 'prompt.submitted')).toHaveLength(1);
    expect(sourceEvents.filter(event => event.body.type === 'user.intervention').map(event => event.body)).toEqual([
      { type: 'user.intervention', action: 'steer', text: correction },
    ]);
    expect(sourceEvents.filter(event => event.body.type === 'turn.completed')).toHaveLength(1);
    await f.waitForJob('scheduled', false);
    await f.action('run-now'); await f.waitForJob('completed'); await idle(f.runtime);
    const workers = f.requests.filter(request => request.meeting);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.prompt).toContain(`initial user claim: ${initial}`);
    expect(workers[0]!.prompt).toContain(`latest user correction: ${correction}`);
    expect(workers[0]!.prompt).toContain(`assistant claim: ${answer}`);
    expect(f.exports).toHaveLength(1);
    expect(f.exports[0]).toMatchObject({ sessionId: f.session.id, workspaceId: f.workspace.id });
  });

  it('runs one bounded review after a file-backed source and saves minutes in the original session and project', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser and record the validation decision.'); await idle(f.runtime);
    const queued = await f.waitForJob('scheduled', false);
    expect(Date.parse(queued.dueAt) - Date.now()).toBeGreaterThan(55_000);
    expect((await f.host.learningSchedule!()).jobs.map(job => job.kind)).toEqual(['knowledge-meeting']);
    expect(f.requests.some(request => request.meeting)).toBe(false);
    await f.action('run-now');
    const job = await f.waitForJob('completed'); await idle(f.runtime);
    // Minutes use the fixture writer; indexing still requires its explicitly selected daemon.
    expect(job).toMatchObject({ workspaceId: f.workspace.id, sessionId: f.session.id, profileId: f.profile.id, result: { meeting: { outcome: 'completed', knowledge: 'saved', indexed: HAS_DAEMON } } });
    expect(f.requests.filter(request => !request.meeting)).toHaveLength(2);
    const workers = f.requests.filter(request => request.meeting); expect(workers).toHaveLength(1);
    expect(workers[0]!.prompt).toContain('Read the parser and record the validation decision.');
    expect(workers.every(request => !request.body.tools?.some(tool => !/^(?:knowledge_[a-z_]+|skill_(?:list|search|read))$/.test(tool.function.name)))).toBe(true);
    expect(f.exports).toHaveLength(1);
    const saved = f.exports[0]!;
    expect(saved).toMatchObject({ sessionId: f.session.id, workspaceId: f.workspace.id, minutes: { outcome: 'completed', contributions: [expect.objectContaining({ round: 1 })] } });
    expect(saved.path.startsWith(path.join(f.profile.root, 'Meetings', f.workspace.id))).toBe(true);
    expect(await readFile(saved.path, 'utf8')).toContain('Actual reviewer finding 1.');
    expect(job.result?.meeting?.notePath).toBe(saved.path);
    const leadDone = f.events.findIndex(event => event.sessionId === f.session.id && event.agentId === 'primary' && event.body.type === 'turn.completed');
    expect(f.events.findIndex(event => event.body.type === 'meeting.started')).toBeGreaterThan(leadDone);
    expect(f.events.filter(event => event.body.type === 'prompt.submitted')).toHaveLength(1);
    expect(f.events.filter(event => event.body.type === 'meeting.completed').every(event => event.sessionId === f.session.id)).toBe(true);
  });

  it('preserves saved meeting minutes and reports an unconfirmed index refresh', async () => {
    const f = await fixture();
    const workspaceKnowledge = f.host.workspaceKnowledge!;
    const knowledge = vi.spyOn(f.host, 'workspaceKnowledge').mockImplementation(async (...args) => {
      if (args[1] === 'syncKnowledge') throw new Error('The fixture index is unavailable.');
      return workspaceKnowledge(...args);
    });
    await f.host.sendPrompt(f.session.id, 'Record the validated project decision.'); await idle(f.runtime);
    await f.waitForJob('scheduled', false); await f.action('run-now');
    const job = await f.waitForJob('completed'); await idle(f.runtime);
    expect(f.exports).toHaveLength(1);
    const saved = f.exports[0]!;
    expect(await readFile(saved.path, 'utf8')).toContain('Actual reviewer finding 1.');
    expect(job.result?.meeting).toMatchObject({ outcome: 'completed', knowledge: 'saved', notePath: saved.path, indexed: false });
    expect(knowledge).toHaveBeenCalledWith(f.workspace.id, 'syncKnowledge', ['incremental']);
  });

  it('records a completed text-only discussion separately from a failed note export', async () => {
    const f = await fixture({ exportFailure: true });
    await f.host.sendPrompt(f.session.id, 'Record our decision to validate before saving.'); await idle(f.runtime);
    expect((await f.host.learningSchedule!()).jobs.map(job => job.kind)).toEqual(['knowledge-meeting']);
    await f.action('run-now');
    const job = await f.waitForJob('failed'); await idle(f.runtime);
    expect(job.result?.meeting).toMatchObject({ outcome: 'completed', knowledge: 'failed' });
    expect(job.result?.meeting?.notePath).toBeUndefined();
    expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
    expect(f.exports).toEqual([]);
  });

  it('preserves saved actual contributions as partial when another participant fails', async () => {
    // Concurrent participant preparation does not guarantee provider-entry order.
    const f = await fixture({ meeting: async request => {
      const system = request.body.messages[0]?.content ?? '';
      if (system.includes("You are Reviewer, the team's Knowledge reviewer.")) throw new Error('Synthetic first reviewer failure.');
      expect(system).toContain("You are Second reviewer, the team's Analyst.");
      return 'Actual reviewer finding 2.';
    } });
    await f.host.saveSessionTeam(f.session.id, { ...f.team, members: [...f.team.members,
      { id: 'reviewer-two', name: 'Second reviewer', role: 'Analyst', models: ['fixture-model'], access: 'read' },
    ] });
    await f.host.sendPrompt(f.session.id, 'Record the verified normalization decision.'); await idle(f.runtime);
    await f.waitForJob('scheduled'); await f.action('run-now');
    const job = await f.waitForJob('partial'); await idle(f.runtime);
    expect(job.result?.meeting).toMatchObject({ outcome: 'failed', knowledge: 'saved', notePath: expect.any(String) });
    expect(f.exports).toHaveLength(1);
    expect(f.exports[0]!.minutes.contributions).toHaveLength(1);
    expect(f.exports[0]!.minutes.contributions[0]).toMatchObject({ agentId: 'reviewer-two', round: 1 });
    expect(await readFile(f.exports[0]!.path, 'utf8')).toContain('Actual reviewer finding 2.');
    expect(f.requests.filter(request => request.meeting)).toHaveLength(2);
  });

  it('restarts the full snooze only after new foreground work settles and keeps the newest source', async () => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ lead: async prompt => { if (prompt === 'Hold foreground work.') { entered.resolve(); await release.promise; } } });
    try {
      await f.host.sendPrompt(f.session.id, 'Finish the first task.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
      await f.action('snooze'); const prior = await f.waitForJob('scheduled', false);
      expect(Date.parse(prior.dueAt) - Date.now()).toBeGreaterThan(595_000);
      await f.host.sendPrompt(f.session.id, 'Hold foreground work.'); await entered.promise;
      const held = await f.waitForJob('scheduled', true);
      expect(held).toMatchObject({ id: prior.id, reason: 'busy' });
      expect(f.requests.some(request => request.meeting)).toBe(false);
      const releasedAt = Date.now(); release.resolve(); await idle(f.runtime);
      const restarted = await f.waitForJob('scheduled', false);
      expect(restarted.id).not.toBe(prior.id);
      expect(Date.parse(restarted.dueAt)).toBeGreaterThanOrEqual(releasedAt + 600_000);
      expect(Date.parse(restarted.dueAt)).toBeGreaterThan(Date.parse(prior.dueAt));
      expect(f.requests.some(request => request.meeting)).toBe(false);
      await f.action('run-now'); await f.waitForJob('completed');
    } finally { release.resolve(); }
  });

  it.each([false, true])('drains an abort-ignoring meeting before a same-profile human memory write enters (isolated: %s)', async isolated => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ isolated, meeting: async () => { entered.resolve(); await release.promise; } });
    try {
      await f.host.sendPrompt(f.session.id, 'Record the current project decision.');
      await idle(f.runtime); await f.waitForJob('scheduled', false);
      await f.action('run-now'); await entered.promise;
      let settled = false;
      const writing = f.host.nativeMemoryWrite!(f.workspace.id, { name: 'confirmed-decision', content: 'Human-confirmed note.', expectedRevision: null })
        .then(result => { settled = true; return result; });
      await vi.waitFor(() => expect(f.requests.find(request => request.meeting)?.signal?.aborted).toBe(true));
      expect(settled).toBe(false);
      release.resolve();
      expect(await writing).toMatchObject({ status: 'saved' });
      await f.waitForJob('cancelled'); await idle(f.runtime);
      expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
      expect(await f.host.nativeMemoryRead!(f.workspace.id, 'confirmed-decision')).toMatchObject({ status: 'found', note: { text: 'Human-confirmed note.' } });
    } finally { release.resolve(); }
  });

  it.each([false, true])('saves an isolated-profile Knowledge meeting while a different profile prompt remains physically active (shared connection: %s)', async sharedConnection => {
    const entered = deferred(), release = deferred();
    const foreignPrompt = 'Hold unrelated profile work.';
    const f = await fixture({ isolated: true, sharedConnection, lead: async prompt => { if (prompt === foreignPrompt) { entered.resolve(); await release.promise; } } });
    try {
      await f.host.sendPrompt(f.session.id, 'Record the source project validation decision.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
      await f.host.sendPrompt(f.otherSession.id, foreignPrompt); await entered.promise;
      await f.action('run-now');
      const completed = await f.waitForJob('completed');
      expect(completed.result?.meeting).toMatchObject({ outcome: 'completed', knowledge: 'saved' });
      expect((await f.host.getState()).sessions.find(item => item.id === f.otherSession.id)?.running).toBe(true);
      expect(f.exports).toHaveLength(1);
      expect(f.exports[0]!.path.startsWith(path.join(f.profile.root, 'Meetings', f.workspace.id))).toBe(true);
      expect(await readFile(f.exports[0]!.path, 'utf8')).toContain('Actual reviewer finding 1.');
      expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
      expect(f.requests.filter(request => request.meeting).every(request => !request.signal?.aborted)).toBe(true);
      expect(JSON.stringify(f.requests.filter(request => request.meeting))).not.toContain(foreignPrompt);
      expect(f.events.filter(event => event.sessionId === f.otherSession.id && event.body.type === 'turn.completed')).toEqual([]);
    } finally { release.resolve(); await idle(f.runtime); }
  });

  it.each(['same', 'other'] as const)('isolated Knowledge meetings respect only the %s-profile paused pending queue', async scope => {
    const f = await fixture({ isolated: true });
    const queueSession = scope === 'same' ? f.session.id : f.otherSession.id;
    const text = `Paused ${scope}-profile draft must never be submitted by a meeting.`;
    const clearDraft = async () => {
      const queue = await f.host.promptQueueStatus!(queueSession);
      const item = queue.items.find(item => item.text === text && item.state === 'pending');
      if (item) await f.host.changePromptQueue!(queueSession, { revision: queue.revision, action: 'delete', itemId: item.id });
    };
    try {
      await f.host.sendPrompt(f.session.id, 'Record the validation decision before checking profile queue ownership.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
      const initial = await f.host.promptQueueStatus!(queueSession);
      await f.host.changePromptQueue!(queueSession, { revision: initial.revision, action: 'add', text });
      expect(await f.host.promptQueueStatus!(queueSession)).toMatchObject({ paused: true, items: [expect.objectContaining({ text, state: 'pending' })] });
      await f.action('run-now');
      if (scope === 'same') {
        expect(await f.waitForJob('scheduled', true)).toMatchObject({ reason: 'busy' });
        expect(f.requests.some(request => request.meeting)).toBe(false);
        expect(f.exports).toEqual([]);
        // The earlier run-now intent becomes eligible when its blocking draft is removed.
        await clearDraft();
      }
      await f.waitForJob('completed'); await idle(f.runtime);
      expect(f.exports).toHaveLength(1);
      if (scope === 'other') expect(await f.host.promptQueueStatus!(queueSession)).toMatchObject({ paused: true, items: [expect.objectContaining({ text, state: 'pending' })] });
      expect(f.events.some(event => event.body.type === 'prompt.submitted' && event.body.text === text)).toBe(false);
    } finally { await clearDraft(); }
  });

  it.each(['prompt', 'planning', 'memory'] as const)('keeps an isolated Knowledge meeting active when another profile starts %s', async mode => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ isolated: true, meeting: async () => { entered.resolve(); await release.promise; } });
    let next: Promise<unknown> | undefined;
    try {
      await f.host.sendPrompt(f.session.id, 'Record the source project decision.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
      await f.action('run-now'); await entered.promise;
      const meetingRequest = f.requests.find(request => request.meeting)!;
      let returned = false;
      const pending = mode === 'prompt' ? f.host.sendPrompt(f.otherSession.id, 'Finish another profile task.')
        : mode === 'planning' ? f.host.planTeam(f.otherWorkspace.id, { count: 1, goal: 'Plan the other project.', allowedModels: ['fixture-model'] }, f.otherSession.id)
          : f.host.nativeMemoryWrite!(f.otherWorkspace.id, { name: 'other-decision', content: 'Other profile private note.', expectedRevision: null });
      next = pending.then(result => { returned = true; return result; });
      await vi.waitFor(() => expect(returned).toBe(true), { timeout: 5_000, interval: 5 });
      const result = await next;
      if (mode === 'planning') expect(result).toMatchObject({ source: 'model' });
      if (mode === 'memory') expect(result).toMatchObject({ status: 'saved' });
      expect(meetingRequest.signal?.aborted).toBe(false);
      expect((await f.job())?.state).toBe('running');
      expect(f.exports).toEqual([]);
      release.resolve(); await f.waitForJob('completed'); await idle(f.runtime);
      expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
      expect(f.exports).toHaveLength(1);
      expect(JSON.stringify(f.requests.filter(request => request.meeting))).not.toContain('Other profile private note.');
    } finally { release.resolve(); await next; }
  });

  it('keeps Run now behind a busy prompt and its queued successor', async () => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ lead: async prompt => { if (prompt === 'Hold foreground work.') { entered.resolve(); await release.promise; } } });
    try {
      await f.host.sendPrompt(f.session.id, 'Finish the first task.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
      await f.host.sendPrompt(f.session.id, 'Hold foreground work.'); await entered.promise;
      const queue = await f.host.promptQueueStatus!(f.session.id);
      await f.host.changePromptQueue!(f.session.id, { revision: queue.revision, action: 'add', text: 'Run the queued successor.', start: true });
      await f.action('run-now'); await f.waitForJob('scheduled', true);
      expect(f.requests.some(request => request.meeting)).toBe(false);
      release.resolve();
      await vi.waitFor(async () => expect((await f.host.promptQueueStatus!(f.session.id)).items[0]?.state).toBe('sent'), { timeout: 5_000, interval: 5 });
      await idle(f.runtime); await f.waitForJob('scheduled', false);
      expect(f.requests.some(request => request.prompt === 'Run the queued successor.')).toBe(true);
      expect(f.requests.some(request => request.meeting)).toBe(false);
      await f.action('run-now'); await f.waitForJob('completed');
      expect(f.requests.findIndex(request => request.meeting)).toBeGreaterThan(f.requests.findIndex(request => request.prompt === 'Run the queued successor.'));
    } finally { release.resolve(); }
  });

  it.each(['prompt', 'planning'] as const)('physically drains an abort-ignoring meeting before another project starts %s', async mode => {
    const entered = deferred(), release = deferred();
    const f = await fixture({ meeting: async () => { entered.resolve(); await release.promise; } });
    let next: Promise<unknown> | undefined;
    try {
      await f.host.sendPrompt(f.session.id, 'Finish the source task.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
      await f.action('run-now'); await entered.promise;
      const meetingRequest = f.requests.find(request => request.meeting)!;
      let returned = false;
      const pending = mode === 'prompt'
        ? f.host.sendPrompt(f.otherSession.id, 'New task in another project.')
        : f.host.planTeam(f.otherWorkspace.id, { count: 1, goal: 'Plan the other project.', allowedModels: ['fixture-model'] }, f.otherSession.id);
      next = pending.then(result => { returned = true; return result; });
      await vi.waitFor(() => expect(meetingRequest.signal?.aborted).toBe(true), { timeout: 5_000, interval: 5 });
      expect(returned).toBe(false); expect(f.runtime.isBusy()).toBe(true);
      expect(f.requests.some(request => request.prompt === 'New task in another project.' || planningRequest(request.body))).toBe(false);
      expect(f.events.some(event => event.body.type === 'meeting.completed')).toBe(false);
      release.resolve(); const result = await next; await idle(f.runtime);
      if (mode === 'planning') expect(result).toMatchObject({ source: 'model', members: [expect.objectContaining({ role: 'Reviewer', models: ['fixture-model'] })] });
      expect(f.requests.some(request => request.prompt === 'New task in another project.' || planningRequest(request.body))).toBe(true);
      expect(f.requests.filter(request => request.meeting)).toHaveLength(1);
      expect(f.exports).toEqual([]);
      expect(f.events.some(event => event.body.type === 'meeting.completed' && event.body.outcome === 'cancelled')).toBe(true);
      const job = await f.waitForJob('cancelled');
      expect(job).toMatchObject({ workspaceId: f.workspace.id, sessionId: f.session.id, reason: 'busy', result: { meeting: { outcome: 'cancelled', knowledge: 'failed' } } });
      expect(job.result?.meeting?.notePath).toBeUndefined();
    } finally { release.resolve(); await next; }
  });

  it.each(['move', 'team'] as const)('invalidates a pending meeting when its source %s changes', async change => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Finish the source task.'); await idle(f.runtime);
    const original = await f.waitForJob('scheduled', false);
    if (change === 'move') {
      const review = await f.host.previewSessionMove!(f.session.id, f.otherWorkspace.id);
      await f.host.moveSession!(f.session.id, { workspaceId: f.otherWorkspace.id, reviewId: review.reviewId });
    } else {
      await f.host.saveSessionTeam(f.session.id, { ...f.team, members: f.team.members.map(member => ({ ...member, role: 'Changed reviewer scope' })) });
    }
    if ((await f.job())?.state === 'scheduled') await f.action('run-now');
    const cancelled = await f.waitForJob('cancelled'); await idle(f.runtime);
    expect(cancelled).toMatchObject({ id: original.id, workspaceId: f.workspace.id, sessionId: f.session.id, reason: 'changed' });
    expect(f.requests.some(request => request.meeting)).toBe(false);
    expect(f.exports).toEqual([]);
  });

  it.each(['off', 'extalia'] as const)('uses the worker connection and indexed skill tools with skills %s without unrelated context injection', async skills => {
    const f = await fixture({ workerSkills: skills });
    await f.host.sendPrompt(f.session.id, 'Finish the security review.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
    await f.action('run-now'); await f.waitForJob('completed'); await idle(f.runtime);
    const workers = f.requests.filter(request => request.meeting); expect(workers).toHaveLength(1);
    expect(workers.every(request => request.url.startsWith('https://worker.example/'))).toBe(true);
    const receipts = f.events.filter(event => event.agentId === 'reviewer-one' && event.body.type === 'skills.loaded');
    for (const worker of workers) {
      expect(worker.body.messages[0]!.content).not.toContain('# Bounded prompt routine');
      expect(worker.body.tools?.some(tool => tool.function.name.startsWith('memory_'))).toBe(false);
      expect(worker.body.tools?.some(tool => !/^(?:knowledge_[a-z_]+|skill_(?:list|search|read))$/.test(tool.function.name))).toBe(false);
      expect(worker.body.messages[0]!.content).not.toContain('# Recall workspace memory');
      expect(worker.body.messages[0]!.content).not.toContain('<extalia-loaded-skills>');
    }
    expect(receipts).toEqual([]);
    expect(f.exports).toHaveLength(1);
  });
});
