import { skillStoragePaths } from '../src/skillStorage.js';
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
interface Body { messages: { role: string; content?: string }[] }
const reply = (call: number, tool?: string, args?: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta: tool
  ? { tool_calls: [{ index: 0, id: `call-${call}`, function: { name: tool, arguments: JSON.stringify(args) } }] }
  : { content: 'Completed the requested test task.' }, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
async function unlock(directory: string): Promise<void> {
  const stat = await lstat(directory).catch(() => undefined);
  if (!stat || stat.isSymbolicLink()) return;
  await chmod(directory, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) for (const name of await readdir(directory)) await unlock(path.join(directory, name));
}

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('shared skills and isolated project context through Native', () => {
  it('adds and updates one library from isolated workspaces without sharing their Knowledge, memory or files', async () => {
    const root = await temp('extalia-shared-skills-'), data = path.join(root, 'data'), home = path.join(root, 'home');
    await mkdir(home);
    const projectA = path.join(root, 'alpha'), projectB = path.join(root, 'beta');
    const requests: Body[] = [];
    for (const project of [projectA, projectB]) await mkdir(project);
    await writeFile(path.join(projectA, 'private.txt'), 'ALPHA_PRIVATE_FILE_BODY');
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory', EXTALIA_DAEMON_PATH: DAEMON_BINARY, EXTALIA_NATIVE_CORE: 'typescript', EXTALIA_HERMES_BIN: path.join(root, 'not-installed'), PATH: '' },
      knowledge: { watcher: false }, daemon: { log: () => undefined }, fetch: async (url, init) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
        const body = JSON.parse(String(init?.body)) as Body; requests.push(body);
        const prompt = body.messages.filter(m => m.role === 'user').at(-1)?.content ?? '';
        const results = body.messages.filter(m => m.role === 'tool');
        if (prompt.startsWith('CREATE') || prompt.startsWith('UPDATE')) return results.length ? reply(requests.length)
          : reply(requests.length, 'skill_propose', { name: 'shared-input-validation', description: 'Validate input before publishing',
            instructions: prompt.startsWith('UPDATE') ? 'Validate every input before publishing. A dry run validates without writing.' : 'Validate every input before publishing.' });
        if (prompt.startsWith('CHECK')) {
          const actions = [
            ['knowledge_search', { query: 'Project' }], ['knowledge_read', { path: 'Project.md' }],
            ['memory_read', { name: 'private-note' }], ['read_file', { path: path.join(projectA, 'private.txt') }],
          ] as const;
          const action = actions[results.length]; return action ? reply(requests.length, action[0], action[1]) : reply(requests.length);
        }
        return reply(requests.length);
      } });
    try {
      const host = runtime.host;
      const connection = (await host.saveConnection({ name: 'Fixture', preset: 'custom', api: 'openai-chat', baseUrl: 'https://example.com/v1', model: 'fixture-model',
        credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'extalia', history: true }, orchestration: { enabled: false, maxDelegations: 0, tiers: {} } })).connections[0]!;
      const workspaces = [];
      for (const [name, project, marker] of [['Alpha', projectA, 'ALPHA_PRIVATE_KNOWLEDGE'], ['Beta', projectB, 'BETA_PROJECT_KNOWLEDGE']] as const) {
        const saved = await host.saveWorkspace({ name, projectLocation: project, connectionId: connection.id, crossWorkspaceAccess: 'isolated', permissions: { fileWrite: 'allow', commands: 'ask' } });
        const workspace = saved.workspaces.find(w => w.name === name)!; workspaces.push(workspace);
        const vault = path.join(root, `${name}-vault`); await mkdir(vault); await writeFile(path.join(vault, 'Project.md'), `# Project\n${marker}\n`);
        await host.workspaceKnowledge!(workspace.id, 'setKnowledgeVaultRoot', [vault]); await host.workspaceKnowledge!(workspace.id, 'syncKnowledge', []);
        await host.nativeMemoryWrite!(workspace.id, { name: 'private-note', content: name === 'Alpha' ? 'ALPHA_PRIVATE_MEMORY' : 'BETA_PROJECT_MEMORY', expectedRevision: null });
      }
      const [alpha, beta] = workspaces;
      const idle = () => vi.waitFor(() => expect(runtime.isBusy()).toBe(false), { timeout: 10_000, interval: 10 });
      const first = await host.createSession(alpha!.id); await host.sendPrompt(first.id, 'CREATE a reusable input validation candidate.', { learnSkill: true }); await idle();
      const original = (await host.skillRegistry()).revisions.find(r => r.packageId === 'shared-input-validation')!; expect(original).toBeDefined();
      const originalPath = path.join(skillStoragePaths(data).objects, original.treeSha256, 'SKILL.md'); const originalText = await readFile(originalPath, 'utf8');
      const second = await host.createSession(beta!.id); await host.sendPrompt(second.id, 'UPDATE the reusable validation candidate with dry-run instructions.', { learnSkill: true }); await idle();
      const revisions = (await host.skillRegistry()).revisions.filter(r => r.packageId === original.packageId);
      expect(revisions).toHaveLength(2); expect(revisions.every(r => !r.active && r.state === 'quarantined')).toBe(true);
      const updated = revisions.find(r => r.revisionId !== original.revisionId)!;
      expect(await readFile(path.join(skillStoragePaths(data).objects, updated.treeSha256, 'SKILL.md'), 'utf8')).toContain('dry run');
      expect(await readFile(originalPath, 'utf8')).toBe(originalText);
      const profileA = (await host.listVaultProfiles!()).workspaces.find(w => w.id === alpha!.id)!.profileId;
      const profileB = (await host.listVaultProfiles!()).workspaces.find(w => w.id === beta!.id)!.profileId;
      expect(profileA).not.toBe(profileB);
      const start = requests.length, check = await host.createSession(beta!.id);
      await host.sendPrompt(check.id, 'CHECK this project Knowledge, memory and file boundary.'); await idle();
      const turn = requests.slice(start), finalResults = turn.at(-1)!.messages.filter(m => m.role === 'tool').map(m => String(m.content));
      expect(finalResults).toHaveLength(4);
      expect(finalResults[1]).toContain('BETA_PROJECT_KNOWLEDGE'); expect(finalResults[2]).toContain('BETA_PROJECT_MEMORY');
      expect(finalResults.join('\n')).not.toMatch(/ALPHA_PRIVATE_(?:KNOWLEDGE|MEMORY|FILE_BODY)/);
      expect(finalResults[3]).toMatch(/Error|outside|isolated|not permitted|denied|another workspace/i);
      expect(turn.map(b => b.messages[0]?.content ?? '').join('\n')).not.toContain('ALPHA_PRIVATE_MEMORY');
      expect((await host.skillRegistry()).revisions.filter(r => r.packageId === original.packageId)).toHaveLength(2);
    } finally { await runtime.close(); await unlock(data); }
  });
});
