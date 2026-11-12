import { createAgentHost } from '../src/service.js';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExtaliaEvent } from '@extalia/protocol';
import { type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const temp = useTempDirs();
const runtimes: AgentHostRuntime[] = [];
const importedSkillStores: string[] = [];
afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.close();
  while (importedSkillStores.length) await unlockStore(importedSkillStores.pop()!);
});
/** Imported registry objects are deliberately immutable; unlock only after the host closes for temp cleanup. */
async function unlockStore(directory: string): Promise<void> {
  const info = await lstat(directory).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory)) await unlockStore(path.join(directory, entry));
  } else await chmod(directory, 0o600);
}
interface Body { model: string; messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] }
type Reply = { text: string } | { tool: string; args: Record<string, unknown> };
const curator = (body: Body) => body.messages[0]?.content?.startsWith('You are a bounded post-task Skills curator.') ?? false;
function response(reply: Reply, call: number) {
  const delta = 'tool' in reply ? { tool_calls: [{ index: 0, id: `call-${call}`, function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] } : { content: reply.text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool' in reply ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(options: { enabled?: boolean; history?: boolean; skills?: boolean; isolated?: boolean; holdCurator?: Promise<void>; holdSource?: Promise<void> } = {}) {
  const root = await temp('extalia-automatic-learning-'), data = path.join(root, 'data'), home = path.join(root, 'home'), project = path.join(root, 'project');
  if (options.skills) importedSkillStores.push(path.join(data, 'profiles', 'default', 'skills'));
  await mkdir(home); await mkdir(project); await writeFile(path.join(project, 'parser.txt'), 'Validate input before saving parsed data.');
  const requests: Body[] = [], events: ExtaliaEvent[] = [], curatorSignals: (AbortSignal | null | undefined)[] = [], readPrompts = new Set<string>();
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_HERMES_BIN: path.join(root, 'missing'), PATH: '' },
    fetch: async (url, init) => {
      if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
      const body = JSON.parse(String(init?.body)) as Body; requests.push(body);
      const call = requests.length;
      if (curator(body)) {
        curatorSignals.push(init?.signal);
        if (body.messages.at(-1)?.role === 'tool') return response({ text: 'Learning findings submitted.' }, call);
        await options.holdCurator;
        const prompt = body.messages.find(item => item.role === 'user')!.content!;
        const evidence = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { id: string }[];
        return response({ tool: 'submit_learning', args: { title: 'Validate parser input', lesson: 'Validate input before saving parsed data and report validation failures.', evidenceIds: evidence.map(item => item.id),
          ...(options.skills ? { skill: { name: 'validate-before-saving', description: 'Validate before saving', instructions: 'Validate input before saving and report failures.' } } : {}),
        } }, call);
      }
      const prompt = body.messages.filter(item => item.role === 'user').at(-1)?.content ?? '';
      if (prompt.startsWith('Hold')) await options.holdSource;
      if (prompt.startsWith('Read') && !readPrompts.has(prompt)) {
        readPrompts.add(prompt); return response({ tool: 'read_file', args: { path: 'parser.txt' } }, call);
      }
      return response({ text: 'Source task completed.' }, call);
    },
  });
  runtimes.push(runtime);
  const host = runtime.host; host.subscribe(event => events.push(event));
  const connection = (await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: options.skills ? 'extalia' : 'off', history: options.history ?? true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections[0]!;
  const workspace = (await host.saveWorkspace({ name: 'Fixture', projectLocation: project, connectionId: connection.id, ...(options.isolated ? { crossWorkspaceAccess: 'isolated' } : {}), permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  let otherSession: { id: string } | undefined;
  if (options.isolated) {
    const otherProject = path.join(root, 'other-project'); await mkdir(otherProject);
    const saved = await host.saveConnection({ name: 'Other profile connection', preset: 'custom', api: 'openai-chat', baseUrl: 'https://other.example/v1', model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true } });
    const otherConnection = saved.connections.find(item => item.name === 'Other profile connection')!;
    const otherWorkspace = (await host.saveWorkspace({ name: 'Other project', projectLocation: otherProject, connectionId: otherConnection.id, permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces.find(item => item.id !== workspace.id)!;
    otherSession = await host.createSession(otherWorkspace.id);
  }
  const before = await host.listVaultProfiles!();
  const catalog = await host.saveVaultProfile!({ name: 'Learning fixture', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: false,
    automaticLearning: { enabled: options.enabled ?? true, skills: options.skills ?? false, notes: true }, expectedRevision: before.revision });
  const profile = catalog.profiles.find(item => item.workspaceIds.includes(workspace.id))!;
  const session = await host.createSession(workspace.id);
  return { root, data, runtime, host, requests, curatorSignals, events, session, otherSession, workspace, profile };
}
const idle = async (runtime: AgentHostRuntime) => { await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 5_000, interval: 5 }); };
const noteFiles = async (root: string, workspace: string) => readdir(path.join(root, 'Learning', workspace)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });

async function runNow(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await f.host.learningSchedule!();
  const job = snapshot.jobs.find(item => item.state === 'scheduled')!;
  expect(job).toBeDefined();
  return f.host.changeLearningSchedule!(job.id, snapshot.revision, 'run-now');
}
const settledLearning = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await vi.waitFor(async () => expect((await f.host.learningSchedule!()).jobs.some(job => job.state === 'completed' || job.state === 'failed')).toBe(true), { timeout: 5_000, interval: 5 });
  await idle(f.runtime);
};

describe.skipIf(process.platform === 'win32')('saved profile automatic learning through the Native host', () => {
  it.skipIf(!HAS_DAEMON)('completes the source before the countdown and runs a real curator only in the assigned profile', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser and report its validation order.'); await idle(f.runtime);
    expect(f.requests.some(curator)).toBe(false);
    expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
    const schedule = await f.host.learningSchedule!();
    expect(schedule.jobs).toHaveLength(1);
    expect(schedule.jobs[0]).toMatchObject({ state: 'scheduled', workspaceId: f.workspace.id, sessionId: f.session.id, profileId: f.profile.id, profileName: f.profile.name });
    expect(Date.parse(schedule.jobs[0]!.dueAt) - Date.now()).toBeGreaterThan(55_000);
    expect((await f.host.getState()).sessions.find(item => item.id === f.session.id)?.running).toBe(false);
    expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(1);
    await runNow(f); await settledLearning(f);
    expect((await f.host.learningSchedule!()).jobs[0]?.state).toBe('completed');
    const completedAt = f.events.findIndex(event => event.agentId === 'primary' && event.body.type === 'turn.completed');
    const curatorAt = f.events.findIndex(event => event.body.type === 'subagent.spawned');
    expect(curatorAt).toBeGreaterThan(completedAt);
    const worker = f.requests.filter(curator);
    expect(worker).toHaveLength(2);
    expect(worker.every(body => body.model === 'fixture-model')).toBe(true);
    expect(worker[0]!.tools?.map(item => item.function.name)).toContain('submit_learning');
    expect(worker[0]!.tools?.some(item => /write|command|delegat|manage|skill_propose/.test(item.function.name))).toBe(false);
    const spawns = f.events.filter(event => event.body.type === 'subagent.spawned'); expect(spawns).toHaveLength(1);
    const agentId = spawns[0]!.body.type === 'subagent.spawned' ? spawns[0]!.body.subagentId : '';
    expect(f.events.some(event => event.agentId === agentId && event.body.type === 'agent.state' && event.body.activity === 'knowledge')).toBe(true);
    const files = await noteFiles(f.profile.root, f.workspace.id); expect(files).toHaveLength(1);
    const note = await readFile(path.join(f.profile.root, 'Learning', f.workspace.id, files[0]!), 'utf8');
    expect(note).toContain(`profile: "${f.profile.id}"`); expect(note).toContain(`session: "${f.session.id}"`);
    expect(note).toContain('Validate input before saving parsed data.'); expect(note).toContain('## Current-turn evidence');
    expect(await noteFiles(path.join(f.data, 'vaults', 'default'), f.workspace.id)).toEqual([]);
    expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(1);
    expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'automatic_learning' && event.body.ok)).toBe(true);
  });

  it.skipIf(!HAS_DAEMON)('snoozes without starting Rust work and rejects an action with a stale revision', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser before snoozing.'); await idle(f.runtime);
    const initial = await f.host.learningSchedule!();
    const job = initial.jobs[0]!;
    const snoozed = await f.host.changeLearningSchedule!(job.id, initial.revision, 'snooze');
    expect(snoozed.jobs[0]).toMatchObject({ id: job.id, state: 'scheduled', profileId: f.profile.id });
    expect(Date.parse(snoozed.jobs[0]!.dueAt) - Date.now()).toBeGreaterThan(595_000);
    expect(snoozed.revision).not.toBe(initial.revision);
    await expect(f.host.changeLearningSchedule!(job.id, initial.revision, 'run-now')).rejects.toThrow(/changed|Refresh/i);
    expect(f.runtime.isBusy()).toBe(false);
    expect(f.requests.some(curator)).toBe(false);
    expect(f.events.some(event => event.body.type === 'subagent.spawned')).toBe(false);
    expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('defers an unstarted job for new foreground work and keeps its source identity', async () => {
    const release = deferred(), f = await fixture({ holdSource: release.promise });
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser before the next prompt.'); await idle(f.runtime);
      const original = (await f.host.learningSchedule!()).jobs[0]!;
      await f.host.sendPrompt(f.session.id, 'Hold while I review the parser.');
      await vi.waitFor(() => expect(f.requests.some(body => body.messages.some(message => message.content === 'Hold while I review the parser.'))).toBe(true), { timeout: 5_000, interval: 5 });
      const deferredJob = (await f.host.learningSchedule!()).jobs[0]!;
      expect(deferredJob).toMatchObject({ id: original.id, sessionId: original.sessionId, profileId: original.profileId, state: 'scheduled', reason: 'busy', waitingForIdle: true });
      expect(f.requests.some(curator)).toBe(false);
      expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
      const releasedAt = Date.now(); release.resolve(); await idle(f.runtime);
      await vi.waitFor(async () => {
        const restarted = (await f.host.learningSchedule!()).jobs[0]!;
        expect(restarted.waitingForIdle).toBe(false);
        expect(Date.parse(restarted.dueAt)).toBeGreaterThanOrEqual(releasedAt + 60_000);
      }, { timeout: 5_000, interval: 5 });
      await runNow(f); await settledLearning(f);
      expect(f.requests.filter(curator)).toHaveLength(2);
      expect((await f.host.learningSchedule!()).jobs).toHaveLength(1);
      expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
      expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(2);
    } finally { release.resolve(); }
  });

  it.skipIf(!HAS_DAEMON).each(['folder', 'profile'] as const)('invalidates pending source evidence when the %s changes without retargeting it', async change => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser before changing its destination.'); await idle(f.runtime);
    const scheduled = await f.host.learningSchedule!();
    const catalog = await f.host.listVaultProfiles!();
    const destination = path.join(f.root, 'new-vault'); await mkdir(destination);
    const next = await f.host.saveVaultProfile!({ ...(change === 'folder' ? { id: f.profile.id } : {}),
      name: change === 'folder' ? f.profile.name : 'Different profile', vaultRoot: destination, workspaceIds: [f.workspace.id],
      minutesEnabled: false, automaticLearning: { enabled: true, skills: false, notes: true }, expectedRevision: catalog.revision });
    expect(next.profiles.find(item => item.workspaceIds.includes(f.workspace.id))?.root).toBe(await realpath(destination));
    const cancelled = (await f.host.learningSchedule!()).jobs.find(job => job.id === scheduled.jobs[0]!.id)!;
    expect(cancelled).toMatchObject({ state: 'cancelled', reason: 'changed', profileId: f.profile.id });
    await expect(f.host.changeLearningSchedule!(cancelled.id, scheduled.revision, 'run-now')).rejects.toThrow(/changed|Refresh/i);
    expect(f.requests.some(curator)).toBe(false);
    expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
    expect(await noteFiles(destination, f.workspace.id)).toEqual([]);
  });

  it.skipIf(!HAS_DAEMON)('owns active background learning independently and drains the physical provider before host shutdown', async () => {
    const release = deferred(), f = await fixture({ holdCurator: release.promise });
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser before background learning.'); await idle(f.runtime);
      await runNow(f);
      await vi.waitFor(() => expect(f.requests.some(curator)).toBe(true), { timeout: 5_000, interval: 5 });
      expect(f.runtime.isBusy()).toBe(true);
      expect((await f.host.learningSchedule!()).jobs[0]?.state).toBe('running');
      expect((await f.host.getState()).sessions.find(item => item.id === f.session.id)?.running).toBe(false);
      expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(1);
      const catalog = await f.host.listVaultProfiles!();
      await expect(f.host.saveVaultProfile!({ id: f.profile.id, name: f.profile.name, vaultRoot: null, workspaceIds: [f.workspace.id],
        minutesEnabled: false, automaticLearning: { enabled: false, skills: false, notes: false }, expectedRevision: catalog.revision })).rejects.toThrow(/learning|settle/i);
      expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
      closing = f.runtime.close().then(() => { closed = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(closed).toBe(false);
      expect(f.runtime.isBusy()).toBe(true);
      release.resolve(); await closing;
      expect(closed).toBe(true);
      expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
    } finally { release.resolve(); await closing; }
  });

  it.skipIf(!HAS_DAEMON).each([false, true])('preempts a curator and drains its physical provider before same-profile foreground work (isolated: %s)', async isolated => {
    const release = deferred(), f = await fixture({ isolated, holdCurator: release.promise });
    let sending: Promise<unknown> | undefined;
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser before learning.'); await idle(f.runtime);
      await runNow(f);
      await vi.waitFor(() => expect(f.requests.some(curator)).toBe(true), { timeout: 5_000, interval: 5 });
      let returned = false;
      sending = f.host.sendPrompt(f.session.id, 'Thanks.').then(result => { returned = true; return result; });
      await vi.waitFor(() => expect(f.curatorSignals[0]?.aborted).toBe(true), { timeout: 5_000, interval: 5 });
      expect(returned).toBe(false);
      expect(f.requests.some(body => body.messages.at(-1)?.content === 'Thanks.')).toBe(false);
      expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(1);
      expect(f.runtime.isBusy()).toBe(true);
      expect((await f.host.learningSchedule!()).jobs).toHaveLength(1);
      release.resolve(); await sending; await idle(f.runtime);
      expect((await f.host.learningSchedule!()).jobs[0]).toMatchObject({ state: 'cancelled', reason: 'busy' });
      expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(2);
      expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
    } finally { release.resolve(); await sending; }
  });

  it.skipIf(!HAS_DAEMON)('saves isolated-profile learning while a different profile prompt remains physically active', async () => {
    const release = deferred(), f = await fixture({ isolated: true, holdSource: release.promise });
    const foreignPrompt = 'Hold unrelated profile work and its private decision.';
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser before learning independently.'); await idle(f.runtime);
      await f.host.sendPrompt(f.otherSession!.id, foreignPrompt);
      await vi.waitFor(() => expect(f.requests.some(body => body.messages.at(-1)?.content === foreignPrompt)).toBe(true), { timeout: 5_000, interval: 5 });
      await runNow(f);
      await vi.waitFor(async () => expect((await f.host.learningSchedule!()).jobs[0]?.state).toBe('completed'), { timeout: 5_000, interval: 5 });
      expect((await f.host.getState()).sessions.find(item => item.id === f.otherSession!.id)?.running).toBe(true);
      expect(f.curatorSignals.every(signal => !signal?.aborted)).toBe(true);
      const files = await noteFiles(f.profile.root, f.workspace.id); expect(files).toHaveLength(1);
      const note = await readFile(path.join(f.profile.root, 'Learning', f.workspace.id, files[0]!), 'utf8');
      expect(note).toContain(`profile: "${f.profile.id}"`);
      expect(note).toContain('Validate input before saving parsed data.');
      expect(note).not.toContain(foreignPrompt);
      expect(await noteFiles(path.join(f.data, 'vaults', 'default'), f.workspace.id)).toEqual([]);
      expect(f.events.filter(event => event.sessionId === f.otherSession!.id && event.body.type === 'turn.completed')).toEqual([]);
    } finally { release.resolve(); await idle(f.runtime); }
  });

  it.skipIf(!HAS_DAEMON).each(['same', 'other'] as const)('isolated learning respects only the %s-profile paused pending queue', async scope => {
    const f = await fixture({ isolated: true });
    const queueSession = scope === 'same' ? f.session.id : f.otherSession!.id;
    const text = `Paused ${scope}-profile draft must never be submitted by learning.`;
    const clearDraft = async () => {
      const queue = await f.host.promptQueueStatus!(queueSession);
      const item = queue.items.find(item => item.text === text && item.state === 'pending');
      if (item) await f.host.changePromptQueue!(queueSession, { revision: queue.revision, action: 'delete', itemId: item.id });
    };
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser before checking profile queue ownership.'); await idle(f.runtime);
      const initial = await f.host.promptQueueStatus!(queueSession);
      await f.host.changePromptQueue!(queueSession, { revision: initial.revision, action: 'add', text });
      expect(await f.host.promptQueueStatus!(queueSession)).toMatchObject({ paused: true, items: [expect.objectContaining({ text, state: 'pending' })] });
      await runNow(f);
      if (scope === 'same') {
        await vi.waitFor(async () => expect((await f.host.learningSchedule!()).jobs[0]).toMatchObject({ state: 'scheduled', waitingForIdle: true, reason: 'busy' }), { timeout: 5_000, interval: 5 });
        expect(f.requests.some(curator)).toBe(false);
        expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
        await clearDraft(); await runNow(f);
      }
      await settledLearning(f);
      expect((await f.host.learningSchedule!()).jobs[0]?.state).toBe('completed');
      expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
      if (scope === 'other') expect(await f.host.promptQueueStatus!(queueSession)).toMatchObject({ paused: true, items: [expect.objectContaining({ text, state: 'pending' })] });
      expect(f.events.some(event => event.body.type === 'prompt.submitted' && event.body.text === text)).toBe(false);
    } finally { await clearDraft(); }
  });

  it.skipIf(!HAS_DAEMON)('keeps an isolated curator active while another profile starts and leaves its generated skill inactive', async () => {
    const release = deferred(), f = await fixture({ isolated: true, skills: true, holdCurator: release.promise });
    let sending: Promise<unknown> | undefined;
    try {
      await f.host.sendPrompt(f.session.id, 'Read the parser and learn its validation sequence independently.'); await idle(f.runtime);
      await runNow(f);
      await vi.waitFor(() => expect(f.requests.some(curator)).toBe(true), { timeout: 5_000, interval: 5 });
      let returned = false;
      sending = f.host.sendPrompt(f.otherSession!.id, 'Finish unrelated profile work.').then(result => { returned = true; return result; });
      await vi.waitFor(() => expect(returned).toBe(true), { timeout: 5_000, interval: 5 });
      await sending;
      await vi.waitFor(() => expect(f.events.some(event => event.sessionId === f.otherSession!.id && event.body.type === 'turn.completed')).toBe(true), { timeout: 5_000, interval: 5 });
      expect(f.curatorSignals[0]?.aborted).toBe(false);
      expect((await f.host.learningSchedule!()).jobs[0]?.state).toBe('running');
      release.resolve(); await settledLearning(f);
      const learned = (await f.host.learningSchedule!()).jobs[0]!;
      expect(learned.state).toBe('completed');
      expect(learned.result?.skill).toMatchObject({ kind: 'skill-candidate', profileId: f.profile.id, workspaceId: f.workspace.id, sessionId: f.session.id, activationPerformed: false });
      expect(learned.result?.skill?.state).not.toBe('active');
      expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
      const registry = await f.host.skillRegistry();
      expect(registry.revisions).toEqual(expect.arrayContaining([expect.objectContaining({ revisionId: learned.result!.skill!.revisionId, state: learned.result!.skill!.state })]));
    } finally { release.resolve(); await sending; }
  });

  it.skipIf(!HAS_DAEMON)('keeps a genuine new skill receipt visible when the later Rust note export fails', async () => {
    const f = await fixture({ skills: true });
    await f.host.sendPrompt(f.session.id, 'Read the parser and learn its validation sequence.'); await idle(f.runtime);
    const job = (await f.host.learningSchedule!()).jobs[0]!;
    const folder = path.join(f.profile.root, 'Learning', f.workspace.id);
    await mkdir(folder, { recursive: true });
    const existingNote = path.join(folder, `${job.id}.md`);
    await writeFile(existingNote, 'Unrelated existing note that must not be overwritten.');
    await runNow(f); await settledLearning(f);
    const completed = (await f.host.learningSchedule!()).jobs.find(item => item.id === job.id)!;
    expect(completed.state).toBe('failed');
    const notice = completed.result?.skill;
    expect(notice).toMatchObject({ kind: 'skill-candidate', profileId: f.profile.id, workspaceId: f.workspace.id,
      sessionId: f.session.id, runId: job.id, change: 'new', partial: true, activationPerformed: false });
    const registry = await f.host.skillRegistry();
    expect(registry).toMatchObject({ mode: 'registry', status: 'ready' });
    expect(registry.revisions).toEqual(expect.arrayContaining([expect.objectContaining({ packageId: notice!.packageId, revisionId: notice!.revisionId, state: notice!.state })]));
    expect(notice!.state).not.toBe('active');
    expect(await readFile(existingNote, 'utf8')).toBe('Unrelated existing note that must not be overwritten.');
    expect(f.events.some(event => event.body.type === 'tool.completed' && event.body.tool === 'automatic_learning' && !event.body.ok)).toBe(true);
  });

  it.each(['profile-off', 'plan', 'paused-team', 'history-off', 'trivial'] as const)('skips %s source work without invoking a curator or saving a note', async mode => {
    const f = await fixture({ enabled: mode !== 'profile-off', history: mode !== 'history-off' });
    if (mode === 'plan') await f.host.setSessionOptions(f.session.id, { permissionMode: 'plan' });
    if (mode === 'paused-team') await f.host.saveSessionTeam(f.session.id, { enabled: false, allowedModels: ['fixture-model'], members: [{ id: 'paused-member', name: 'Reviewer', role: 'Review', models: ['fixture-model'] }] });
    await f.host.sendPrompt(f.session.id, mode === 'trivial' ? 'Hello.' : 'Read the parser and explain it.'); await idle(f.runtime);
    expect(f.requests.some(curator)).toBe(false);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    expect(f.events.some(event => event.body.type === 'subagent.spawned')).toBe(false);
    expect(await noteFiles(f.profile.root, f.workspace.id)).toEqual([]);
    expect(f.events.filter(event => event.agentId === 'primary' && event.body.type === 'turn.completed')).toHaveLength(1);
  });

  it.skipIf(!HAS_DAEMON)('never replays successful older-turn evidence into learning for a later trivial turn', async () => {
    const f = await fixture();
    await f.host.sendPrompt(f.session.id, 'Read the parser and explain validation.'); await idle(f.runtime);
    await runNow(f); await settledLearning(f);
    expect(f.requests.filter(curator)).toHaveLength(2); expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
    await f.host.sendPrompt(f.session.id, 'Thanks.'); await idle(f.runtime);
    expect(f.requests.filter(curator)).toHaveLength(2); expect(await noteFiles(f.profile.root, f.workspace.id)).toHaveLength(1);
    expect((await f.host.learningSchedule!()).jobs).toHaveLength(1);
    expect((await f.host.learningSchedule!()).jobs[0]?.state).toBe('completed');
    const lastLead = f.requests.filter(body => !curator(body)).at(-1)!;
    expect(lastLead.messages.some(message => message.role === 'tool' && message.content?.includes('Validate input before saving parsed data.'))).toBe(true);
  });
});
