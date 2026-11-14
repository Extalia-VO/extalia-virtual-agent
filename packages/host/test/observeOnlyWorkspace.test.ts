import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), runtimes = new Set<AgentHostRuntime>();
afterEach(async () => { for (const runtime of runtimes) await runtime.close(); runtimes.clear(); });
const permissions = { fileWrite: 'ask', commands: 'ask' } as const;
async function setup() {
  const root = await realpath(await temp('extalia-observe-only-')), home = path.join(root, 'home'), project = path.join(root, 'project'), extra = path.join(root, 'extra');
  await mkdir(project); await mkdir(extra);
  const fetch = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"The batch limit remains 73."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const options = { kind: 'bridge' as const, version: 'test', dataDirectory: path.join(root, 'data'), homeDirectory: home, importHome: home,
    observationIntervalMs: 30, env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_DAEMON_PATH: DAEMON_BINARY, PATH: '' }, fetch, daemon: { log: () => {} } };
  let runtime = await createAgentHost(options); runtimes.add(runtime);
  return { root, home, project, extra, fetch, get host() { return runtime.host; },
    async restart() { await runtime.close(); runtimes.delete(runtime); runtime = await createAgentHost(options); runtimes.add(runtime); } };
}
const connectionInput = { name: 'Fixture model', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model',
  credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia' } } as const;

describe('providerless Observe workspace setup and upgrade', () => {
  it('preserves providerless project identity through restart and explicit full setup', async () => {
    const f = await setup();
    const workspace = (await f.host.saveWorkspace({ mode: 'observe', name: 'Observed project', projectLocation: f.project,
      additionalProjectLocations: [f.extra], permissions })).workspaces[0]!;
    expect(workspace).toMatchObject({ mode: 'observe', projectLocation: f.project, additionalProjectLocations: [f.extra] });
    expect(workspace.providerProfileId).toBeUndefined();
    expect(await f.host.completeSetup('observe')).toMatchObject({ setupComplete: true, workflow: 'observe', connections: [] });
    await expect(f.host.createSession(workspace.id)).rejects.toThrow(/Enable full Extalia/);
    await expect(f.host.completeSetup('managed')).rejects.toThrow(/model connection/);
    await expect(f.host.saveWorkspace({ id: workspace.id, mode: 'managed', name: workspace.name, projectLocation: f.project, permissions })).rejects.toThrow(/model connection/);
    await expect(f.host.saveWorkspace({ mode: 'observe', name: 'Invalid runtime', projectLocation: f.project, runtimeId: 'hermes', permissions })).rejects.toThrow(/managed runtime/);
    await expect(f.host.saveWorkspace({ mode: 'invalid' as 'observe', name: 'Invalid mode', projectLocation: f.project, permissions })).rejects.toThrow(/observe-only/);
    await f.restart();
    expect((await f.host.getState()).workspaces[0]).toEqual(workspace);
    const connection = (await f.host.saveConnection(connectionInput)).connections[0]!;
    const curated = (await f.host.saveWorkspace({ id: workspace.id, mode: 'observe', name: workspace.name, projectLocation: f.project,
      connectionId: connection.id, permissions })).workspaces[0]!;
    expect(curated.providerProfileId).toBe(connection.id);
    await expect(f.host.createSession(workspace.id)).rejects.toThrow(/Enable full Extalia/);
    const preserved = (await f.host.saveWorkspace({ id: workspace.id, name: 'Renamed observed project', projectLocation: f.project, permissions })).workspaces[0]!;
    expect(preserved).toMatchObject({ mode: 'observe', providerProfileId: connection.id });
    const cleared = (await f.host.saveWorkspace({ id: workspace.id, name: preserved.name, projectLocation: f.project, connectionId: '', permissions })).workspaces[0]!;
    expect(cleared.providerProfileId).toBeUndefined();
    const upgraded = (await f.host.saveWorkspace({ id: workspace.id, mode: 'managed', name: preserved.name, projectLocation: f.project,
      connectionId: connection.id, permissions })).workspaces[0]!;
    expect(upgraded).toMatchObject({ id: workspace.id, profileId: workspace.profileId, mode: 'managed', createdAt: workspace.createdAt,
      projectLocation: f.project, additionalProjectLocations: [f.extra] });
    expect(await f.host.completeSetup('managed')).toMatchObject({ setupComplete: true, workflow: 'managed' });
    const session = await f.host.createSession(workspace.id);
    expect(session.workspaceId).toBe(workspace.id);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.skipIf(!HAS_DAEMON || process.platform === 'win32')('captures and recalls Observe evidence without a provider, then retains it on upgrade', async () => {
    const f = await setup(), nativeId = '22222222-2222-4222-8222-222222222222';
    const native = path.join(f.home, '.codex', 'sessions'); await mkdir(native, { recursive: true });
    const file = path.join(native, 'rollout-observe-only.jsonl'), row = (value: unknown) => `${JSON.stringify(value)}\n`;
    await writeFile(file, row({ type: 'session_meta', payload: { id: nativeId, cwd: f.project, timestamp: '2026-01-01T00:00:00.000Z' } }) + row({ timestamp: '2026-01-01T00:00:00.500Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Initial observed baseline.' }] } }));
    const workspace = (await f.host.saveWorkspace({ mode: 'observe', name: 'Observed project', projectLocation: f.project, permissions })).workspaces[0]!;
    await f.host.completeSetup('observe');
    const profiles = await f.host.listVaultProfiles!();
    const saved = await f.host.saveVaultProfile!({ name: 'Observed project notes', vaultRoot: null, workspaceIds: [workspace.id], minutesEnabled: false,
      automaticLearning: { enabled: true, skills: true, notes: true, observed: true }, expectedRevision: profiles.revision });
    const profile = saved.profiles.find(item => item.workspaceIds.includes(workspace.id))!;
    const scan = await f.host.scanImports(['codex']);
    const observed = (await f.host.observeImports(scan.scanId, [scan.sessions[0]!.id])).sessions.find(item => item.observation?.nativeSessionId === nativeId)!;
    expect(observed.workspaceId).toBe(workspace.id);
    await appendFile(file, row({ timestamp: '2026-01-01T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Retain the parser decision.' }] } })
      + row({ timestamp: '2026-01-01T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'Parser decision: normalize first; retain first duplicate; batch limit 73. Progress: parser review complete.' }] } }));
    await vi.waitFor(async () => expect((await f.host.observedMemorySearch!(workspace.id, { query: 'parser' })).hits).toHaveLength(1), { timeout: 10000 });
    const hit = (await f.host.observedMemorySearch!(workspace.id, { query: 'parser' })).hits[0]!;
    expect((await f.host.observedMemoryRead!(workspace.id, { sessionId: hit.sessionId, episodeId: hit.episode.id, revision: hit.episode.revision })).entries.some(item => item.text.includes('73'))).toBe(true);
    expect((await f.host.learningSchedule!()).jobs).toEqual([]);
    expect(f.fetch).not.toHaveBeenCalled();
    const preview = await f.host.previewHandover!(observed.id, { target: { kind: 'manual', label: 'Reviewed receiver' } });
    expect(preview.packet).toContain('73');
    const snapshot = (await f.host.sessionContinuity!(observed.id)).snapshots.at(-1)!;
    expect(snapshot.workspaceContext).toMatchObject({ workspaceId: workspace.id, profileId: profile.id });
    const archive = await f.host.readContinuity!(observed.id, { snapshotId: snapshot.id, offset: 0, limit: 1 });
    const context = JSON.parse(archive.entries[0]!.text) as { sources: { kind: string; items: { reference: string; text: string }[] }[] };
    expect(context.sources.find(item => item.kind === 'observed')?.items[0]?.reference).toBe(hit.episode.id);
    expect(snapshot.workspaceContext?.contributors).toContainEqual({ sessionId: observed.id, sourceId: 'codex', nativeSessionId: nativeId, boundary: hit.episode.scope.boundary });
    const sourceEvents = await f.host.sessionEvents(observed.id);
    await f.restart();
    expect((await f.host.observedMemorySearch!(workspace.id, { query: 'parser' })).hits[0]!.episode.id).toBe(hit.episode.id);
    const connection = (await f.host.saveConnection(connectionInput)).connections[0]!;
    await f.host.saveWorkspace({ id: workspace.id, mode: 'observe', name: workspace.name, projectLocation: f.project, connectionId: connection.id, permissions });
    expect((await f.host.handoverHarnesses!(observed.id)).harnesses.find(item => item.id === 'extalia')).toMatchObject({ create: 'unavailable' });
    await f.host.saveWorkspace({ id: workspace.id, mode: 'managed', name: workspace.name, projectLocation: f.project, connectionId: connection.id, permissions });
    await f.host.completeSetup('managed');
    expect((await f.host.handoverHarnesses!(observed.id)).harnesses.find(item => item.id === 'extalia')).toMatchObject({ create: 'ready' });
    expect((await f.host.listVaultProfiles!()).profiles.find(item => item.id === profile.id)?.workspaceIds).toContain(workspace.id);
    expect((await f.host.observedMemorySearch!(workspace.id, { query: 'parser' })).hits[0]!.episode.id).toBe(hit.episode.id);
    expect((await f.host.getState()).sessions.find(item => item.id === observed.id)).toMatchObject({ id: observed.id, workspaceId: workspace.id });
    expect(await f.host.sessionEvents(observed.id)).toEqual(sourceEvents);
    const session = await f.host.createSession(workspace.id);
    await f.host.sendPrompt(session.id, 'Recall the parser decision, keep batch limit 73.');
    await vi.waitFor(async () => expect((await f.host.getState()).sessions.find(item => item.id === session.id)?.running).toBe(false), { timeout: 10000 });
    expect(f.fetch).toHaveBeenCalled();
    expect((await f.host.sessionEvents(session.id)).some(item => item.body.type === 'model.completed' && item.body.text.includes('73'))).toBe(true);
  }, 30000);
});
