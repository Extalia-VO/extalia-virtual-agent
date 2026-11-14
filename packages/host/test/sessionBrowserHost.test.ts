import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const at = '2026-11-01T00:00:00.000Z';
describe('host session browser transport surface', () => {
  it('pages imported and observed source folders without registering workspaces or changing persisted history', async () => {
    const root = await temp(); const home = path.join(root, 'home');
    const sourceDirectory = path.join(home, '.codex', 'sessions');
    await mkdir(sourceDirectory, { recursive: true });
    const sourcePath = path.join(sourceDirectory, 'rollout-fixture.jsonl');
    const projectPath = path.join(root, 'source-project');
    const source = [
      { type: 'session_meta', payload: { id: 'fixture-native', cwd: projectPath, timestamp: at } },
      { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Observed original title' }] } },
      { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Observed context marker' }] } },
    ].map(row => JSON.stringify(row)).join('\n');
    await writeFile(sourcePath, source);
    await utimes(sourcePath, new Date(at), new Date(at));
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), importHome: home,
      env: { EXTALIA_SECRET_STORE: 'memory' }, observationIntervalMs: 60_000 });
    try {
      const { host } = runtime;
      const originalWorkspaceIds = (await host.getState()).workspaces.map(row => row.id);
      const scan = await host.scanImports(['codex']);
      const candidate = scan.sessions.find(row => row.nativeSessionId === 'fixture-native')!;
      expect(scan.sessions.map(row => ({ title: row.title, nativeSessionId: row.nativeSessionId, supported: row.supported }))).toContainEqual(expect.objectContaining({ nativeSessionId: 'fixture-native' }));
      await host.observeImports(scan.scanId, [candidate.id]);
      await host.commitImports(scan.scanId, [candidate.id], 'imported');
      const importedClaude = await host.importPortable(JSON.stringify({ format: 'extalia.session.v1', title: 'Claude source title', importMode: 'imported',
        provenance: { sourceId: 'claude-code', sourceSessionId: 'fixture-claude', exportedAt: at },
        workspace: { slug: 'source-project', name: 'source-project', projectLocation: projectPath },
        messages: [{ index: 0, role: 'user', content: 'Claude context marker', createdAt: at }],
        startedAt: at, lastMessageAt: '2026-11-01T00:00:01.000Z' }));
      expect(importedClaude.plan.addCount).toBe(1);
      const full = await host.getState(); const compact = await host.getStateSummary!();
      expect(compact.library).toEqual([]);
      expect(compact.sessionBrowser).toMatchObject({ libraryTotal: full.library.length, observedTotal: full.sessions.filter(row => row.control === 'observed').length });
      expect(compact.sessions).toEqual(full.sessions);
      expect((await host.getStateSummary!()).sessionBrowser?.libraryRevision).toBe(compact.sessionBrowser?.libraryRevision);
      const observedGroups = await host.sessionBrowserGroups!({ collection: 'observed', section: 'projects' });
      expect(observedGroups.groups[0]).toMatchObject({ name: 'source-project', projectPath, sourceIds: ['codex'], count: 1 });
      const harnesses = await host.sessionBrowserGroups!({ collection: 'library', section: 'harnesses', limit: 1 });
      expect(harnesses.groups[0]).toMatchObject({ sourceId: 'claude-code', count: 1 });
      expect(harnesses.totalGroups).toBe(2);
      expect(harnesses.groups[0]?.runningCount).toBeUndefined();
      expect((await host.sessionBrowserGroups!({ collection: 'library', section: 'harnesses', cursor: harnesses.nextCursor })).groups[0]?.sourceId).toBe('codex');
      const importedGroups = await host.sessionBrowserGroups!({ collection: 'library', section: 'projects', harness: 'codex' });
      expect(importedGroups.groups[0]).toMatchObject({ name: 'source-project', projectPath, sourceIds: ['codex'], count: 1 });
      const page = await host.sessionBrowserSessions!({ collection: 'library', groupId: importedGroups.groups[0]!.id, harness: 'codex', limit: 1 });
      expect(page.sessions[0]?.title).toBe('Observed original title');
      expect('messages' in page.sessions[0]!).toBe(false);
      const original = await host.librarySession(page.sessions[0]!.id);
      expect(original.messages.some(message => message.content === 'Observed context marker')).toBe(true);
      await host.organizeLibrarySession(original.id, 'rename', 'Renamed source conversation');
      expect((await host.getStateSummary!()).sessionBrowser?.libraryRevision).not.toBe(compact.sessionBrowser?.libraryRevision);
      expect((await host.getState()).workspaces.map(row => row.id)).toEqual(originalWorkspaceIds);
      expect(await readFile(sourcePath, 'utf8')).toBe(source);
    } finally { await runtime.close(); }
  });
});
