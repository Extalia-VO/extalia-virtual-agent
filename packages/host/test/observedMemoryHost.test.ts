import { skillStoragePaths } from '../src/skillStorage.js';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), runtimes = new Set<AgentHostRuntime>(), stores = new Set<string>();
async function unlock(folder: string): Promise<void> {
  const info = await lstat(folder).catch(() => undefined); if (!info || info.isSymbolicLink()) return;
  await chmod(folder, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const file of await readdir(folder)) await unlock(path.join(folder, file));
}
afterEach(async () => { for (const runtime of runtimes) await runtime.close(); runtimes.clear(); for (const store of stores) await unlock(store); stores.clear(); });
const nativeId = '11111111-1111-4111-8111-111111111111';
const row = (value: unknown) => `${JSON.stringify(value)}\n`;
const message = (role: 'user' | 'assistant', text: string, timestamp: string) => row({ timestamp, type: 'response_item', payload: { type: 'message', role,
  ...(role === 'assistant' ? { channel: 'final' } : {}), content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
interface RequestBody { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] }
function response(text: string, tool?: { name: string; input: unknown }) {
  const delta = tool ? { tool_calls: [{ index: 0, id: 'curator-submission', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: text };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(enabled = true, holdCurator?: Promise<void>) {
  const root = await temp('extalia-observed-memory-'), home = path.join(root, 'home'), data = path.join(root, 'data'), project = path.join(root, 'project');
  await mkdir(project); const native = path.join(home, '.codex', 'sessions'); await mkdir(native, { recursive: true });
  const file = path.join(native, 'rollout-fixture.jsonl');
  await writeFile(file, row({ type: 'session_meta', payload: { id: nativeId, cwd: project, timestamp: '2026-01-01T00:00:00.000Z' } })
    + message('user', 'Old backlog must not trigger paid curation.', '2026-01-01T00:00:01.000Z') + message('assistant', 'Old history.', '2026-01-01T00:00:02.000Z'));
  const requests: RequestBody[] = [], signals: (AbortSignal | null | undefined)[] = [];
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 50,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_DAEMON_PATH: DAEMON_BINARY, PATH: '' },
    fetch: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RequestBody; requests.push(body);
      if (body.messages.at(-1)?.role === 'tool') return response('Submitted attributed learning.');
      signals.push(init?.signal); await holdCurator;
      const prompt = body.messages.find(item => item.role === 'user')?.content ?? '';
      expect(prompt).toContain('Observed episode'); expect(prompt).toContain('not prove task completion');
      const evidence = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { id: string; content: string }[];
      expect(evidence.every(item => item.content.includes('UNTRUSTED OBSERVED CLAIM'))).toBe(true);
      return response('', { name: 'submit_learning', input: { title: 'Parser decision from observed work',
        lesson: 'The observed Codex transcript reports that parser input is normalized before duplicates are checked; retain the first row and limit batches to 73. This is an attributed report, not independent verification.',
        evidenceIds: evidence.map(item => item.id), skill: { name: 'observed-parser-review', description: 'Review observed parser decisions with attribution',
          instructions: 'Read the attributed parser decision, verify the current project behavior and test it before relying on reported outcomes.' } } });
    }, daemon: { log: () => {} } };
  let runtime = await createAgentHost(options); runtimes.add(runtime); stores.add(skillStoragePaths(data).root);
  const connection = (await runtime.host.saveConnection({ name: 'Fixture curator', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1',
    model: 'fixture-model', credential: { kind: 'none' }, features: { history: true, memory: 'extalia', skills: 'extalia' } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Fixture project', projectLocation: project, connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' } })).workspaces[0]!;
  const scan = await runtime.host.scanImports(['codex']);
  const observed = (await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id])).sessions.find(item => item.observation?.nativeSessionId === nativeId)!;
  const before = await runtime.host.listVaultProfiles!();
  const profiles = await runtime.host.saveVaultProfile!({ name: 'Fixture observed profile', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: false,
    automaticLearning: { enabled: true, skills: true, notes: true, observed: enabled }, expectedRevision: before.revision });
  const profile = profiles.profiles.find(item => item.workspaceIds.includes(workspace.id))!;
  return { root, home, data, project, file, requests, signals, workspace, profile, observed,
    get runtime() { return runtime; }, get host() { return runtime.host; },
    append: () => appendFile(file, message('user', 'parser', '2026-01-01T00:00:03.000Z')
      + message('assistant', 'Parser: normalize input first, retain the first duplicate, and keep the batch limit at 73. Agent reports tests passed; this is not independently verified.', '2026-01-01T00:00:04.000Z')),
    async restart() { await runtime.close(); runtimes.delete(runtime); runtime = await createAgentHost(options); runtimes.add(runtime); },
  };
}

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('observed memory through the real temporary host and Rust owner', () => {
  it('captures new work once, recalls after restart, curates attributed notes and inactive skills, and reviews context in handover', async () => {
    const f = await fixture();
    expect((await f.host.observedMemorySearch!(f.workspace.id, { query: 'backlog' })).hits).toEqual([]);
    expect(f.requests).toEqual([]); expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    await f.append();
    await vi.waitFor(async () => expect((await f.host.observedMemorySearch!(f.workspace.id, { query: 'parser' })).hits).toHaveLength(1), { timeout: 10000 });
    const first = (await f.host.observedMemorySearch!(f.workspace.id, { query: 'parser' })).hits[0]!;
    const page = await f.host.observedMemoryRead!(f.workspace.id, { sessionId: first.sessionId, episodeId: first.episode.id, revision: first.episode.revision });
    expect(page.episode.trust).toBe('untrusted-observed'); expect(page.entries.some(entry => entry.text.includes('73'))).toBe(true);
    expect(f.requests).toEqual([]);
    const queue = await f.host.learningSchedule!(), job = queue.jobs.find(item => item.kind === 'learning')!;
    expect(job).toBeDefined();
    await f.host.changeLearningSchedule!(job.id, queue.revision, 'run-now');
    await vi.waitFor(async () => expect((await f.host.learningSchedule!()).jobs.some(item => item.state === 'completed')).toBe(true), { timeout: 10000 });
    await vi.waitFor(() => expect(f.runtime.isBusy()).toBe(false), { timeout: 10000 });
    const notes = await readdir(path.join(f.profile.root, 'Learning', f.workspace.id)); expect(notes).toHaveLength(1);
    const note = await readFile(path.join(f.profile.root, 'Learning', f.workspace.id, notes[0]!), 'utf8');
    expect(note).toContain('UNTRUSTED OBSERVED CLAIM'); expect(note).toContain('not independent verification');
    const registry = await f.host.skillRegistry(); expect(registry.revisions).toHaveLength(1);
    expect(registry.revisions[0]!.state).not.toBe('active');
    const calls = f.requests.length;
    await f.restart();
    const retained = (await f.host.observedMemorySearch!(f.workspace.id, { query: 'parser' })).hits;
    expect(retained.map(hit => hit.episode.id)).toEqual([first.episode.id]); expect(f.requests).toHaveLength(calls);
    await f.host.nativeMemoryWrite!(f.workspace.id, { name: 'parser', content: '# parser\nRetain the first duplicate; batch size 73.', expectedRevision: null });
    const preview = await f.host.previewHandover!(f.observed.id, { target: { kind: 'manual', label: 'Reviewed fixture receiver' } });
    expect(preview.packet).toContain('Workspace');
    const chain = await f.host.sessionContinuity!(f.observed.id), snapshot = chain.snapshots.at(-1)!;
    expect(snapshot.workspaceContext?.profileId).toBe(f.profile.id);
    const archive = await f.host.readContinuity!(f.observed.id, { snapshotId: snapshot.id, offset: 0, limit: 1 });
    const context = JSON.parse(archive.entries[0]!.text);
    expect(context.type).toBe('workspace-context');
    expect(context.sources.find((source: { kind: string }) => source.kind === 'memory').items[0].text).toContain('73');
    expect(context.sources.find((source: { kind: string }) => source.kind === 'observed').items[0].text).toMatch(/parser/i);
    expect(context.sources.find((source: { kind: string }) => source.kind === 'knowledge').items[0].text).toContain('observed');
    expect(f.requests).toHaveLength(calls);
    const native = await f.host.continueSession({ kind: 'observed', id: f.observed.id }, f.workspace.id);
    await f.host.previewHandover!(native.id, { target: { kind: 'manual', label: 'Native reviewed receiver' } });
    const nativeChain = await f.host.sessionContinuity!(native.id), nativeSnapshot = nativeChain.snapshots.at(-1)!;
    expect(nativeSnapshot.sourceId).toBe('extalia-native'); expect(nativeSnapshot.workspaceContext?.contributors).toHaveLength(1);
    const profiles = await f.host.listVaultProfiles!();
    await f.host.saveVaultProfile!({ id: f.profile.id, name: 'Renamed fixture profile', vaultRoot: null, workspaceIds: [f.workspace.id], minutesEnabled: false,
      automaticLearning: { enabled: true, skills: true, notes: true, observed: true }, expectedRevision: profiles.revision });
    await expect(f.host.readContinuity!(native.id, { snapshotId: nativeSnapshot.id, offset: 0, limit: 1 })).resolves.toMatchObject({ entries: expect.any(Array) });
    await f.host.setObservation(f.observed.id, false);
    await expect(f.host.readContinuity!(native.id, { snapshotId: nativeSnapshot.id, offset: 0, limit: 1 })).rejects.toThrow(/contributor|context|authorized/);
    await expect(f.host.observedMemoryRead!(f.workspace.id, { sessionId: first.sessionId, episodeId: first.episode.id, revision: first.episode.revision })).rejects.toThrow();
  });

  it('keeps opt-out sources unsearchable without curator calls, then refuses stale access after disabling consent', async () => {
    const f = await fixture(false); await f.append();
    await vi.waitFor(async () => expect((await f.host.observationSession(f.observed.id)).messages.some(message => message.content.includes('batch limit'))).toBe(true), { timeout: 10000 });
    expect((await f.host.observedMemorySearch!(f.workspace.id, { query: 'parser' })).hits).toEqual([]);
    expect(f.requests).toEqual([]);
    const catalog = await f.host.listVaultProfiles!();
    await f.host.saveVaultProfile!({ id: f.profile.id, name: f.profile.name, vaultRoot: null, workspaceIds: [f.workspace.id], minutesEnabled: false,
      automaticLearning: { enabled: true, skills: true, notes: true, observed: true }, expectedRevision: catalog.revision });
    expect((await f.host.observedMemorySearch!(f.workspace.id, { query: 'parser' })).hits).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('cancels and drains active curation when new real observed foreground work arrives', async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(true, hold); await f.append();
    await vi.waitFor(async () => expect((await f.host.learningSchedule!()).jobs.some(item => item.kind === 'learning')).toBe(true), { timeout: 10000 });
    const queue = await f.host.learningSchedule!(), job = queue.jobs.find(item => item.kind === 'learning')!;
    await f.host.changeLearningSchedule!(job.id, queue.revision, 'run-now');
    try {
      await vi.waitFor(() => expect(f.requests).toHaveLength(1), { timeout: 10000 });
      await appendFile(f.file, message('user', 'New foreground work must take priority.', '2026-01-01T00:00:05.000Z'));
      await vi.waitFor(() => expect(f.signals[0]?.aborted).toBe(true), { timeout: 10000 });
      expect(f.runtime.isBusy()).toBe(true); // Abort does not pretend an ignoring provider settled.
    } finally { release(); }
    await vi.waitFor(() => expect(f.runtime.isBusy()).toBe(false), { timeout: 10000 });
    expect(await readdir(path.join(f.profile.root, 'Learning', f.workspace.id)).catch(() => [])).toEqual([]);
    expect((await f.host.skillRegistry()).revisions).toEqual([]);
  });
});
