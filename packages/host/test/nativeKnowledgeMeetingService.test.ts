import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTeam } from '@extalia/core';
import type { LearningScheduleJob } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import type { NativeMeetingMinutes } from '@extalia/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { DAEMON_BINARY } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';
import { learningObservedFixture } from './learningObservedFixture.js';

const temp = useTempDirs(), runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
interface Body { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] }
interface Request { body: Body; meeting: boolean; prompt: string; url: string; signal?: AbortSignal | null }
const planningRequest = (body: Body) => body.messages[0]?.content?.startsWith('You split software work into a team of helper agents') ?? false;
function response(text: string, read = false) {
  const delta = read ? { tool_calls: [{ index: 0, id: 'read-parser', function: { name: 'read_file', arguments: JSON.stringify({ path: 'parser.txt' }) } }] } : { content: text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: read ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const idle = async (runtime: AgentHostRuntime) => { await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 5 }); };

async function fixture(options: { lead?(prompt: string): Promise<void>; sourceReply?(prompt: string): string; meeting?(): Promise<void>; workerSkills?: 'off' | 'extalia'; isolated?: boolean; sharedConnection?: boolean; exportFailure?: boolean } = {}) {
  const root = await temp('extalia-knowledge-meeting-'), data = path.join(root, 'data'), home = path.join(root, 'home');
  const project = path.join(root, 'project'), otherProject = path.join(root, 'other-project');
  await Promise.all([home, project, otherProject].map(folder => mkdir(folder)));
  await writeFile(path.join(project, 'parser.txt'), 'Validate input before saving parsed data.');
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
      requests.push({ body, meeting, prompt, url, signal: init?.signal });
      if (meeting) await options.meeting?.(); else await options.lead?.(prompt);
      if (planningRequest(body)) return response(JSON.stringify({ members: [{ role: 'Reviewer', task: 'Review the project plan', model: 'fixture-model' }] }));
      if (!meeting && prompt.startsWith('Read') && !readPrompts.has(prompt)) { readPrompts.add(prompt); return response('', true); }
      return response(meeting ? `Actual reviewer finding ${requests.filter(request => request.meeting).length}.` : options.sourceReply?.(prompt) ?? 'Source task completed.');
    },
    onMeetingMinutes: async (minutes, context) => {
      if (options.exportFailure) throw new Error('The test vault refused this export.');
      const folder = path.join(vaultRoot, 'Meetings', context.workspaceId);
      await mkdir(folder, { recursive: true });
      const file = path.join(folder, `${minutes.meetingId}.md`);
      await writeFile(file, `${context.sessionId}\n${minutes.contributions.map(contribution => contribution.text).join('\n')}\n`, 'utf8');
      exports.push({ minutes, ...context, path: file });
      return file;
    },
  });
  runtimes.push(runtime);
  const host = runtime.host; host.subscribe(event => events.push(event));
  const connection = (await host.saveConnection({ name: 'Fixture lead', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: options.workerSkills ? 'extalia' : 'off', history: true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections[0]!;
  const workspace = (await host.saveWorkspace({ name: 'Source project', projectLocation: project, connectionId: connection.id, ...(options.isolated ? { crossWorkspaceAccess: 'isolated' } : {}), permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const otherConnection = options.isolated && !options.sharedConnection ? (await host.saveConnection({ name: 'Other profile connection', preset: 'custom', api: 'openai-chat', baseUrl: 'https://other.example/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } })).connections.find(item => item.name === 'Other profile connection')! : connection;
  const otherWorkspace = (await host.saveWorkspace({ name: 'Other project', projectLocation: otherProject, connectionId: otherConnection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.id !== workspace.id)!;
  const before = await host.listVaultProfiles!();
  const catalog = await host.saveVaultProfile!({ name: 'Knowledge fixture', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: true,
    automaticLearning: { enabled: true, skills: false, notes: true }, expectedRevision: before.revision });
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
  const job = async () => (await host.learningSchedule!()).jobs.filter(item => item.kind === 'knowledge-meeting' && item.workspaceId === workspace.id).at(-1);
  const waitForJob = async (state: LearningScheduleJob['state'], waitingForIdle?: boolean) => {
    let found: LearningScheduleJob | undefined;
    await vi.waitFor(async () => { found = await job(); expect(found?.state).toBe(state); if (waitingForIdle !== undefined) expect(found?.waitingForIdle === true).toBe(waitingForIdle); }, { timeout: 5_000, interval: 5 });
    return found!;
  };
  const action = async (action: 'run-now' | 'snooze') => {
    const snapshot = await host.learningSchedule!();
    const current = snapshot.jobs.filter(item => item.kind === 'knowledge-meeting' && item.workspaceId === workspace.id).at(-1)!;
    return host.changeLearningSchedule!(current.id, snapshot.revision, action);
  };
  return { runtime, host, requests, events, exports, session, workspace, otherSession, otherWorkspace, profile, team, job, waitForJob, action };
}

describe('native knowledge meetings through the deferred host scheduler', () => {
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
        expect(f.requests.filter(request => request.meeting)).toHaveLength(2);
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
      expect(f.requests.filter(request => request.meeting)).toHaveLength(2);
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
    expect(workers).toHaveLength(2);
    expect(f.exports).toHaveLength(1);
    for (const projection of [workers, f.events.slice(meetingStart), f.exports.map(saved => saved.minutes)]) {
      const text = JSON.stringify(projection);
      expect(text).not.toContain('synthetic-prompt-credential-');
      expect(text).not.toContain('synthetic-answer-credential-');
      expect(text).not.toContain('Earlier unrelated user evidence.');
      expect(text).not.toContain('Earlier unrelated assistant evidence.');
      expect(text).toContain('[redacted]');
      expect(text).toContain('Current user decision: validate before saving.');
      expect(text).toContain('Current assistant decision: reject invalid input.');
    }
  });

  it('runs two real rounds after a file-backed source and saves minutes in the original session and project', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser and record the validation decision.'); await idle(f.runtime);
    const queued = await f.waitForJob('scheduled', false);
    expect(Date.parse(queued.dueAt) - Date.now()).toBeGreaterThan(55_000);
    expect((await f.host.learningSchedule!()).jobs.map(job => job.kind)).toEqual(['learning', 'knowledge-meeting']);
    expect(f.requests.some(request => request.meeting)).toBe(false);
    await f.action('run-now');
    const job = await f.waitForJob('completed'); await idle(f.runtime);
    expect(job).toMatchObject({ workspaceId: f.workspace.id, sessionId: f.session.id, profileId: f.profile.id, result: { meeting: { outcome: 'completed', knowledge: 'saved' } } });
    expect(f.requests.filter(request => !request.meeting)).toHaveLength(2);
    const workers = f.requests.filter(request => request.meeting); expect(workers).toHaveLength(2);
    expect(workers[0]!.prompt).toContain('Read the parser and record the validation decision.');
    expect(workers[1]!.prompt).toContain('Actual reviewer finding 1.');
    expect(workers.every(request => !request.body.tools?.some(tool => /write|command|delegat|manage/.test(tool.function.name)))).toBe(true);
    expect(f.exports).toHaveLength(1);
    const saved = f.exports[0]!;
    expect(saved).toMatchObject({ sessionId: f.session.id, workspaceId: f.workspace.id, minutes: { outcome: 'completed', contributions: [expect.objectContaining({ round: 1 }), expect.objectContaining({ round: 2 })] } });
    expect(saved.path.startsWith(path.join(f.profile.root, 'Meetings', f.workspace.id))).toBe(true);
    expect(await readFile(saved.path, 'utf8')).toContain('Actual reviewer finding 2.');
    expect(job.result?.meeting?.notePath).toBe(saved.path);
    const leadDone = f.events.findIndex(event => event.sessionId === f.session.id && event.agentId === 'primary' && event.body.type === 'turn.completed');
    expect(f.events.findIndex(event => event.body.type === 'meeting.started')).toBeGreaterThan(leadDone);
    expect(f.events.filter(event => event.body.type === 'prompt.submitted')).toHaveLength(1);
    expect(f.events.filter(event => event.body.type === 'meeting.completed').every(event => event.sessionId === f.session.id)).toBe(true);
  });

  it('records a completed text-only discussion separately from a failed note export', async () => {
    const f = await fixture({ exportFailure: true });
    await f.host.sendPrompt(f.session.id, 'Record our decision to validate before saving.'); await idle(f.runtime);
    expect((await f.host.learningSchedule!()).jobs).toHaveLength(1);
    await f.action('run-now');
    const job = await f.waitForJob('failed'); await idle(f.runtime);
    expect(job.result?.meeting).toMatchObject({ outcome: 'completed', knowledge: 'failed' });
    expect(job.result?.meeting?.notePath).toBeUndefined();
    expect(f.requests.filter(request => request.meeting)).toHaveLength(2);
    expect(f.exports).toEqual([]);
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
      expect(await readFile(f.exports[0]!.path, 'utf8')).toContain('Actual reviewer finding 2.');
      expect(f.requests.filter(request => request.meeting)).toHaveLength(2);
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
        await clearDraft(); await f.action('run-now');
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
      expect(f.requests.filter(request => request.meeting)).toHaveLength(2);
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

  it.each(['off', 'extalia'] as const)('prepares both rounds from the worker connection with skills %s and current saved authority', async skills => {
    const f = await fixture({ workerSkills: skills });
    await f.host.sendPrompt(f.session.id, 'Finish the security review.'); await idle(f.runtime); await f.waitForJob('scheduled', false);
    await f.action('run-now'); await f.waitForJob('completed'); await idle(f.runtime);
    const workers = f.requests.filter(request => request.meeting); expect(workers).toHaveLength(2);
    expect(workers.every(request => request.url.startsWith('https://worker.example/'))).toBe(true);
    const receipts = f.events.filter(event => event.agentId === 'reviewer-one' && event.body.type === 'skills.loaded');
    for (const worker of workers) {
      expect(worker.body.messages[0]!.content).not.toContain('# Bounded prompt routine');
      expect(worker.body.tools?.some(tool => tool.function.name.startsWith('memory_'))).toBe(false);
      expect(worker.body.tools?.some(tool => /write|command|delegat|manage/.test(tool.function.name))).toBe(false);
      if (skills === 'extalia') expect(worker.body.messages[0]!.content).toContain('# Recall workspace memory');
      else expect(worker.body.messages[0]!.content).not.toContain('<extalia-loaded-skills>');
    }
    expect(receipts).toHaveLength(skills === 'extalia' ? 2 : 0);
    expect(f.exports).toHaveLength(1);
  });
});
