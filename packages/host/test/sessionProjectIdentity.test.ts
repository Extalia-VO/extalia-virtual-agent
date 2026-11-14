import { mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionBrowserProject, type SessionSummary } from '@extalia/platform';
import { SessionProjectIdentities } from '../src/sessionProjectIdentity.js';
import { SessionBrowser } from '../src/sessionBrowser.js';
import { useTempDirs } from './helpers.js';
const temp = useTempDirs();
async function repository(root: string) {
  await mkdir(path.join(root, '.git/objects'), { recursive: true });
  await writeFile(path.join(root, '.git/HEAD'), 'ref: refs/heads/main\n');
}
async function worktree(main: string, root: string, name: string) {
  const git = path.join(main, '.git/worktrees', name);
  await mkdir(git, { recursive: true }); await mkdir(root, { recursive: true });
  await writeFile(path.join(root, '.git'), `gitdir: ${git}\n`);
  await writeFile(path.join(git, 'commondir'), '../..\n');
}
const key = (folder: string) => sessionBrowserProject(folder)!.id;

describe('read-only source project identities', () => {
  it('unites main checkout, nested folders and linked worktrees without merging distinct clones', async () => {
    const root = await temp(), main = path.join(root, 'primary/example'), one = path.join(root, 'worktrees/one/example'), two = path.join(root, 'worktrees/two/example'), other = path.join(root, 'unrelated/example');
    await repository(main); await repository(other); await worktree(main, one, 'one'); await worktree(main, two, 'two');
    const nested = path.join(main, 'src/components'); await mkdir(nested, { recursive: true });
    const identities = await new SessionProjectIdentities().resolve([main, nested, one, two, other]);
    expect(identities.get(key(main))).toEqual(identities.get(key(one)));
    expect(identities.get(key(main))).toEqual(identities.get(key(two)));
    expect(identities.get(key(main))).toEqual(identities.get(key(nested)));
    expect(identities.get(key(other))?.id).not.toBe(identities.get(key(main))?.id);
    expect(identities.get(key(main))).toMatchObject({ name: 'example', path: await realpath(main) });
  });
  it('uses a registered workspace root without Git, matches path boundaries and keeps source folders unchanged', async () => {
    const root = await temp(), project = path.join(root, 'project'), src = path.join(project, 'src'), docs = path.join(project, 'docs'), sibling = path.join(root, 'project-other');
    await Promise.all([src, docs, sibling].map(folder => mkdir(folder, { recursive: true })));
    const identities = await new SessionProjectIdentities().resolve([await realpath(src), docs, sibling], [{ id: 'workspace', name: 'Example', projectLocation: project }]);
    expect(identities.get(key(await realpath(src)))).toEqual({ id: key(await realpath(project)), name: 'project', path: await realpath(project) });
    expect(identities.get(key(docs))).toEqual(identities.get(key(await realpath(src))));
    expect(identities.has(key(sibling))).toBe(false);
  });
  it('does not execute malformed, oversized or symbolic-link Git markers', async () => {
    const root = await temp(), main = path.join(root, 'main'), bad = path.join(root, 'bad'), link = path.join(root, 'link');
    await repository(main); await mkdir(bad); await mkdir(link);
    await writeFile(path.join(bad, '.git'), `gitdir: ${'x'.repeat(5000)}`);
    await symlink(path.join(main, '.git'), path.join(link, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    const identities = await new SessionProjectIdentities().resolve([bad, link]);
    expect(identities.size).toBe(0);
  });
  it('returns one project with all three session rows and does not acknowledge unrelated unread output', async () => {
    const root = await temp(), main = path.join(root, 'main'), one = path.join(root, 'one'), two = path.join(root, 'two');
    await repository(main); await worktree(main, one, 'one'); await worktree(main, two, 'two');
    const sessions: SessionSummary[] = [main, one, two].map((projectPath, index) => ({ id: `session-${index}`, title: `Session ${index}`, workspaceId: '', connectionId: '', control: 'observed', createdAt: '2026-01-01T00:00:00Z', lastActiveAt: '2026-01-01T00:00:00Z', running: true, observation: { sourceId: 'codex', nativeSessionId: `native-${index}`, projectPath, watching: true, status: 'watching', unreadOutput: index === 2 } }));
    const browser = new SessionBrowser({ profileId: () => 'profile', metadata: collection => ({ collection, observed: sessions }) });
    const groups = await browser.groupsWithProjects({ collection: 'observed', section: 'projects', harness: 'codex' });
    expect(groups.groups).toHaveLength(1);
    expect(groups.groups[0]).toMatchObject({ count: 3, runningCount: 3, unreadCount: 1, projectPath: await realpath(main) });
    const rows = await browser.sessionsWithProjects({ collection: 'observed', groupId: groups.groups[0]!.id, harness: 'codex', limit: 2 });
    expect(rows.sessions).toHaveLength(2); expect(rows.nextCursor).toBeDefined();
    const rest = await browser.sessionsWithProjects({ collection: 'observed', groupId: groups.groups[0]!.id, harness: 'codex', cursor: rows.nextCursor });
    expect(rest.sessions).toHaveLength(1);
    expect(sessions.map(row => row.observation?.projectPath)).toEqual([main, one, two]);
    expect(sessions[2]?.observation?.unreadOutput).toBe(true);
  });
});
