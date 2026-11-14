import { appendFile, chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GLOBAL_OBSERVE_WORKSPACE_ID, type LearningScheduleJob } from '@extalia/platform';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { skillStoragePaths } from '../src/skillStorage.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), runtimes = new Set<AgentHostRuntime>(), stores = new Set<string>();
async function unlock(folder: string): Promise<void> {
  const info = await lstat(folder).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  await chmod(folder, info.isDirectory() ? 0o700 : 0o600);
  if (info.isDirectory()) for (const file of await readdir(folder)) await unlock(path.join(folder, file));
}
afterEach(async () => {
  for (const runtime of runtimes) await runtime.close(); runtimes.clear();
  for (const store of stores) await unlock(store); stores.clear();
});

const nativeId = '22222222-2222-4222-8222-222222222222';
const row = (value: unknown) => `${JSON.stringify(value)}\n`;
const message = (role: 'user' | 'assistant', text: string, timestamp: string) => row({ timestamp, type: 'response_item', payload: {
  type: 'message', role, ...(role === 'assistant' ? { channel: 'final' } : {}),
  content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
} });
interface RequestBody { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] }
function response(input: unknown) {
  const delta = { tool_calls: [{ index: 0, id: 'global-learning-submission', function: { name: 'submit_learning', arguments: JSON.stringify(input) } }] };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture({ observed = true, connections = 1, history = true, ambiguousWorkspace = false } = {}) {
  const root = await temp('extalia-global-observe-'), home = path.join(root, 'home'), data = path.join(root, 'data'), project = path.join(root, 'unregistered-project');
  await mkdir(project);
  await writeFile(path.join(project, 'private-project-note.txt'), 'Unregistered project filesystem contents must not enter global learning.');
  const native = path.join(home, '.codex', 'sessions'); await mkdir(native, { recursive: true });
  const file = path.join(native, 'rollout-global-fixture.jsonl');
  await writeFile(file, row({ type: 'session_meta', payload: { id: nativeId, cwd: project, timestamp: '2026-01-01T00:00:00.000Z' } })
    + message('user', 'Old backlog is not new work.', '2026-01-01T00:00:01.000Z')
    + message('assistant', 'Historical response.', '2026-01-01T00:00:02.000Z'));
  const requests: RequestBody[] = [];
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    observationIntervalMs: 50, modelDiscovery: async () => ['fixture-model'],
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_DAEMON_PATH: DAEMON_BINARY, PATH: '' }, daemon: { log: () => {} },
    fetch: async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as RequestBody; requests.push(body);
      const prompt = body.messages.find(item => item.role === 'user')?.content ?? '';
      expect(prompt).toContain('Observed episode');
      const evidence = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as { id: string; content: string }[];
      expect(evidence.every(item => item.content.includes('UNTRUSTED OBSERVED CLAIM'))).toBe(true);
      return response({ title: 'Observed normalization procedure',
        lesson: 'The observed source reports normalization before duplicate checks and preservation of the first matching row. This remains an attributed report, not independent verification.',
        evidenceIds: evidence.map(item => item.id),
        skill: { name: 'review-normalization-order', description: 'Use when reviewing normalization and duplicate handling in a data pipeline.',
          instructions: '## When to Use\nReview data pipelines with normalization and duplicate handling.\n\n## Procedure\nRead the current specification, identify normalization order, and compare the duplicate policy.\n\n## Pitfalls\nObserved reports can be stale; do not infer execution success.\n\n## Verification\nCheck current source and tests before accepting the reported behavior.' },
      });
    },
  };
  let runtime = await createAgentHost(options); runtimes.add(runtime); stores.add(skillStoragePaths(data).root);
  for (let index = 0; index < connections; index++) await runtime.host.saveConnection({ name: `Fixture curator ${index + 1}`, preset: 'custom',
    api: 'openai-chat', baseUrl: `https://model-${index + 1}.example/v1`, model: 'fixture-model', credential: { kind: 'none' },
    features: { history, memory: 'off', skills: 'extalia' } });
  if (ambiguousWorkspace) {
    const connection = (await runtime.host.getState()).connections[0]!;
    for (const name of ['First overlapping project', 'Second overlapping project']) await runtime.host.saveWorkspace({
      name, projectLocation: project, connectionId: connection.id, permissions: { fileWrite: 'ask', commands: 'ask' },
    });
  }
  const scan = await runtime.host.scanImports(['codex']);
  const watched = (await runtime.host.observeImports(scan.scanId, [scan.sessions[0]!.id])).sessions.find(item => item.observation?.nativeSessionId === nativeId)!;
  const before = await runtime.host.listVaultProfiles!();
  const saved = await runtime.host.saveVaultProfile!({ id: before.defaultProfileId, name: 'Default', vaultRoot: null,
    workspaceIds: before.workspaces.filter(item => item.profileId === before.defaultProfileId).map(item => item.id), minutesEnabled: false,
    automaticLearning: { enabled: true, notes: true, skills: true, observed }, expectedRevision: before.revision });
  const profile = saved.profiles.find(item => item.id === saved.defaultProfileId)!;
  const waitForJob = async (state?: LearningScheduleJob['state']) => {
    let job: LearningScheduleJob | undefined;
    await vi.waitFor(async () => {
      job = (await runtime.host.learningSchedule!()).jobs.find(item => item.sessionId === watched.id);
      expect(job).toBeDefined();
      if (state) expect(job!.state).toBe(state);
    }, { timeout: 10_000, interval: 10 });
    return job!;
  };
  return { root, data, project, requests, watched, profile, waitForJob,
    get runtime() { return runtime; }, get host() { return runtime.host; },
    append: () => appendFile(file, message('user', 'Preserve the normalization decision from this task.', '2026-01-01T00:00:03.000Z')
      + message('assistant', 'The source reports normalizing input before duplicate detection and retaining the first row. Validation remains unverified.', '2026-01-01T00:00:04.000Z')),
    async runNow() {
      const snapshot = await runtime.host.learningSchedule!();
      const job = snapshot.jobs.find(item => item.sessionId === watched.id)!;
      await runtime.host.changeLearningSchedule!(job.id, snapshot.revision, 'run-now');
    },
    async waitForObserved() {
      await vi.waitFor(async () => expect((await runtime.host.observationSession(watched.id)).messages.some(item => item.content.includes('Validation remains unverified'))).toBe(true), { timeout: 10_000, interval: 10 });
      await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 10_000, interval: 10 });
    },
    async restart() { await runtime.close(); runtimes.delete(runtime); runtime = await createAgentHost(options); runtimes.add(runtime); },
  };
}

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('global Observe learning through a real temporary host and Rust owner', () => {
  it('curates an explicitly unbound source into the default vault and inactive user skill without a workspace grant', async () => {
    const f = await fixture();
    expect((await f.host.observedWorkspaceLink!(f.watched.id)).mode).toBe('unbound');
    expect((await f.host.getState()).workspaces).toEqual([]);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    expect(f.requests).toEqual([]);
    await f.append();
    expect(await f.waitForJob('scheduled')).toMatchObject({ workspaceId: GLOBAL_OBSERVE_WORKSPACE_ID, profileId: f.profile.id, kind: 'learning' });
    await f.runNow();
    const completed = await f.waitForJob('completed');
    await vi.waitFor(() => expect(f.runtime.isBusy()).toBe(false), { timeout: 10_000, interval: 10 });
    expect(f.requests).toHaveLength(1);
    expect(JSON.stringify(f.requests)).not.toContain('Unregistered project filesystem contents');
    expect(f.requests[0]!.tools?.some(item => !/^(?:submit_learning|knowledge_[a-z_]+|skill_(?:list|search|read))$/.test(item.function.name))).toBe(false);
    const folder = path.join(f.profile.root, 'Learning', GLOBAL_OBSERVE_WORKSPACE_ID);
    const notes = await readdir(folder); expect(notes).toHaveLength(1);
    expect(completed.result?.knowledge).toEqual({ status: 'saved', path: path.join('Learning', GLOBAL_OBSERVE_WORKSPACE_ID, notes[0]!), indexed: true });
    const note = await readFile(path.join(folder, notes[0]!), 'utf8');
    expect(note).toContain('UNTRUSTED OBSERVED CLAIM');
    expect(note).toContain('not independent verification');
    expect(note).toContain(`workspace: "${GLOBAL_OBSERVE_WORKSPACE_ID}"`);
    const registry = await f.host.skillRegistry();
    expect(registry.revisions).toHaveLength(1);
    expect(registry.revisions[0]!.state).not.toBe('active');
    expect(completed.result?.skill).toMatchObject({ workspaceId: GLOBAL_OBSERVE_WORKSPACE_ID, profileId: f.profile.id, activationPerformed: false });
    expect((await f.host.getState()).workspaces).toEqual([]);
    expect((await f.host.getState()).sessions.find(item => item.id === f.watched.id)?.workspaceId).toBe('');
    await f.restart();
    expect(f.requests).toHaveLength(1);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    expect(await readdir(folder)).toEqual(notes);
    expect((await f.host.skillRegistry()).revisions).toHaveLength(1);
  });

  it('honors default-profile Observe opt-out without paid calls or note creation', async () => {
    const f = await fixture({ observed: false });
    await f.append(); await f.waitForObserved();
    expect(f.requests).toEqual([]);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    expect(await readdir(path.join(f.profile.root, 'Learning', GLOBAL_OBSERVE_WORKSPACE_ID)).catch(() => [])).toEqual([]);
    expect((await f.host.skillRegistry()).revisions).toEqual([]);
  });

  it.each([{ connections: 2, history: true }, { connections: 1, history: false }])('shows a connection problem when default routing is unavailable (%j)', async options => {
    const f = await fixture(options); await f.append(); await f.waitForJob('scheduled'); await f.runNow();
    expect(await f.waitForJob('failed')).toMatchObject({ result: { problem: 'connection' }, workspaceId: GLOBAL_OBSERVE_WORKSPACE_ID });
    expect(f.requests).toEqual([]);
    expect(await readdir(path.join(f.profile.root, 'Learning', GLOBAL_OBSERVE_WORKSPACE_ID)).catch(() => [])).toEqual([]);
  });

  it('never redirects an ambiguous physical workspace match into the global profile', async () => {
    const f = await fixture({ ambiguousWorkspace: true });
    expect((await f.host.observedWorkspaceLink!(f.watched.id)).mode).toBe('ambiguous');
    await f.append(); await f.waitForObserved();
    expect(f.requests).toEqual([]);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
  });
});
