import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearningScheduleJob } from '@extalia/platform';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { useTempDirs } from './helpers.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const temp = useTempDirs(), runtimes: AgentHostRuntime[] = [];
afterEach(async () => { while (runtimes.length) await runtimes.pop()!.close(); });
interface Body { messages: { role: string; content?: string }[]; tools?: { function: { name: string } }[] }
interface Source { sourceId: string; path: string; evidence: { evidenceId: string; text: string }[] }
function response(delta: Record<string, unknown>, tool = false) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

async function fixture(options: { alias?: boolean; customVault?: boolean; fileWrite?: 'ask' | 'allow' } = {}) {
  const root = await temp('extalia-project-authority-');
  const data = path.join(root, 'data'), home = path.join(root, 'home'), primary = path.join(root, 'primary'), secondary = path.join(root, 'secondary');
  await Promise.all([home, primary, secondary].map(folder => mkdir(folder)));
  await writeFile(path.join(primary, 'primary.md'), '# Primary project\nRule: Primary project input must be validated before durable writes.\n');
  await writeFile(path.join(secondary, 'secondary.md'), '# Secondary folder\nRule: Secondary folder has a separate source context.\n');
  const requests: Body[] = [], sourceReceipts: Source[][] = [];
  const runtimeOptions: Parameters<typeof createAgentHost>[0] = {
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
    env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_DAEMON_PATH: DAEMON_BINARY,
      EXTALIA_HERMES_BIN: path.join(root, 'missing-runtime'), PATH: '' },
    daemon: { log: () => {} }, modelDiscovery: async () => ['fixture-model'],
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body; requests.push(body);
      if (body.tools?.some(tool => tool.function.name === 'submit_project_topics')) {
        const prompt = body.messages.find(message => message.role === 'user')!.content!;
        const sources = JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)) as Source[];
        sourceReceipts.push(sources);
        const source = sources.find(source => source.path === 'primary.md') ?? sources[0]!;
        const evidence = source.evidence.find(unit => unit.text.includes('Rule:'))!;
        return response({ tool_calls: [{ index: 0, id: 'submit-project-topic', function: { name: 'submit_project_topics', arguments: JSON.stringify({
          topics: [{ key: 'input-validation', title: 'Input validation', citations: [{ evidenceId: evidence.evidenceId }] }],
        }) } }] }, true);
      }
      return response({ content: 'The saved source session is ready.' });
    },
  };
  let runtime = await createAgentHost(runtimeOptions); runtimes.push(runtime);
  const connection = (await runtime.host.saveConnection({ name: 'Knowledge fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1',
    model: 'fixture-model', credential: { kind: 'none' }, features: { memory: 'off', skills: 'off', history: true },
    orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections[0]!;
  const workspace = (await runtime.host.saveWorkspace({ name: 'Primary project', projectLocation: primary, additionalProjectLocations: [secondary],
    connectionId: connection.id, crossWorkspaceAccess: 'isolated', permissions: { fileWrite: options.fileWrite ?? 'ask', commands: 'ask' } })).workspaces[0]!;
  let vault: string | undefined;
  if (options.customVault) {
    vault = path.join(primary, 'vault'); await mkdir(vault);
    const before = await runtime.host.listVaultProfiles!();
    await runtime.host.saveVaultProfile!({ id: workspace.profileId, name: 'Project vault', vaultRoot: vault, workspaceIds: [workspace.id],
      minutesEnabled: false, automaticLearning: { enabled: false, skills: false, notes: false }, expectedRevision: before.revision });
  }
  if (options.alias) {
    const alias = path.join(root, 'registered-alias'); await symlink(primary, alias);
    await runtime.close();
    // A legacy saved lexical alias is synthetic profile data. New folder saves
    // canonicalize roots; loading an existing profile must retain equivalent guards.
    const file = path.join(data, 'config', 'extalia.json');
    const config = JSON.parse(await readFile(file, 'utf8')) as { workspaces: { id: string; projectLocation: string }[] };
    config.workspaces.find(item => item.id === workspace.id)!.projectLocation = alias;
    await writeFile(file, JSON.stringify(config));
    runtime = await createAgentHost(runtimeOptions); runtimes.push(runtime);
  }
  const session = await runtime.host.createSession(workspace.id);
  await runtime.host.saveSessionTeam(session.id, { enabled: true, allowedModels: ['fixture-model'], members: [
    { id: 'knowledge-reviewer', name: 'Knowledge reviewer', role: 'Project curator', models: ['fixture-model'], access: 'read' },
  ] });
  await runtime.host.sendPrompt(session.id, 'Prepare this saved session.');
  await vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 10_000, interval: 5 });
  const runBuild = async () => {
    const pending = await runtime.host.requestKnowledgeUpdate!(workspace.id);
    const scheduled = pending.jobs.find(job => job.state === 'scheduled' && job.kind === 'knowledge-build')!;
    await runtime.host.changeLearningSchedule!(scheduled.id, pending.revision, 'run-now');
    let result: LearningScheduleJob | undefined;
    await vi.waitFor(async () => {
      result = (await runtime.host.learningSchedule!()).jobs.find(job => job.id === scheduled.id);
      expect(['completed', 'partial', 'failed', 'cancelled']).toContain(result?.state);
    }, { timeout: 10_000, interval: 5 });
    return result!;
  };
  return { runtime, host: runtime.host, workspace, session, primary: workspace.projectLocation!, secondary: workspace.additionalProjectLocations![0]!, vault, requests, sourceReceipts, runBuild };
}

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('project Knowledge source and destination authority', () => {
  it('builds the selected workspace primary source root even when its routing session selected another registered folder', async () => {
    const h = await fixture();
    await h.host.setSessionProjectRoot!(h.session.id, { workspaceId: h.workspace.id, projectLocation: h.secondary });
    const result = await h.runBuild();
    expect(result).toMatchObject({ state: 'completed', result: { project: { status: 'saved', inventory: 1, read: 1, indexed: true } } });
    expect(h.sourceReceipts.flat().map(source => source.path)).toEqual(['primary.md']);
    expect(h.sourceReceipts.flat()[0]!.evidence.map(unit => unit.text).join('')).toContain('Primary project input');
    expect(JSON.stringify(h.sourceReceipts)).not.toContain('Secondary folder has a separate source context.');
    expect((await h.host.getState()).sessions.find(session => session.id === h.session.id)?.projectLocation).toBe(h.secondary);
  });

  it('refuses component writes into a custom vault beneath a canonical alias of an ask-permission project', async () => {
    const h = await fixture({ alias: true, customVault: true, fileWrite: 'ask' });
    const result = await h.runBuild();
    expect(result.state).toBe('failed'); expect(result.result?.project).toBeUndefined();
    expect(h.sourceReceipts).toEqual([]);
    expect(await readdir(h.vault!)).toEqual([]);
  });

  it('permits the same canonical-alias vault when the project explicitly allows note writes', async () => {
    const h = await fixture({ alias: true, customVault: true, fileWrite: 'allow' });
    const result = await h.runBuild();
    expect(result).toMatchObject({ state: 'completed', result: { project: { status: 'saved', indexed: true } } });
    expect(h.sourceReceipts.flat().some(source => source.path === 'primary.md')).toBe(true);
    expect(await readFile(path.join(h.vault!, result.result!.project!.overviewPath!), 'utf8')).toContain('[[');
  });
});
