import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFileTools } from '../src/tools/files.js';
import { IntegrationQueue, WorktreeManager, type WorktreeOwner } from '../src/worktrees/index.js';
import { runTool, useTempDirs } from './helpers.js';

// Every repository here is a fresh `git init` in a temporary folder; no real repository is touched.
const tempDir = useTempDirs();
const PROCESS_TEST_TIMEOUT_MS = 60_000;
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();
const owner = (n: number): WorktreeOwner => ({ missionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, taskId: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}` });

async function fixture(options: { files?: Record<string, string>; dataInside?: boolean } = {}) {
  const root = await tempDir('extalia-worktrees-');
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  await mkdir(home, { recursive: true }); await mkdir(project, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, env, encoding: 'utf8' }).trim();
  git(project, 'init', '-q', '-b', 'main');
  for (const [file, content] of Object.entries({ 'README.md': 'base\n', 'shared.txt': 'one\ntwo\nthree\n', ...options.files })) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), content);
  }
  git(project, 'add', '-A'); git(project, 'commit', '-q', '-m', 'base');
  const data = options.dataInside ? path.join(project, '.extalia-data') : path.join(root, 'data');
  const active = new Set<string>();
  const open = async () => {
    const manager = await WorktreeManager.open({ directory: path.join(data, 'worktrees'), registryFile: path.join(data, 'state', 'worktrees.json'), git: { env }, isOwnerActive: item => active.has(item.missionId) });
    const queue = await IntegrationQueue.open(manager, { registryFile: path.join(data, 'state', 'integrations.json'), env });
    return { manager, queue };
  };
  return { root, project, data, env, git, active, open, ...(await open()) };
}

const pass = { command: 'node -e "process.exit(0)"', timeoutSeconds: 60 };

describe.skipIf(!hasGit)('worker worktrees (ADR 0028)', { timeout: PROCESS_TEST_TIMEOUT_MS }, () => {
  it('creates worktrees under the data folder on unique branches at a pinned base commit', async () => {
    const env = await fixture();
    const base = env.git(env.project, 'rev-parse', 'HEAD');
    const a = await env.manager.create({ workspaceRoot: env.project, owner: owner(1) });
    const b = await env.manager.create({ workspaceRoot: env.project, owner: owner(2) });
    expect(a.branch).not.toBe(b.branch);
    expect(a.branch).toMatch(/^extalia\/worker\/w-[0-9a-f]{12}$/);
    const worktreeFolder = await realpath(path.join(env.data, 'worktrees')), project = await realpath(env.project);
    for (const handle of [a, b]) {
      expect(path.dirname(handle.path)).toBe(worktreeFolder);
      expect(handle.path.startsWith(project)).toBe(false);
      expect(handle.repository).toBe(project);
      expect(handle).toMatchObject({ baseCommit: base, baseBranch: 'main', state: 'active', prefix: '' });
    }
    // The base stays pinned when the user's branch moves on.
    await writeFile(path.join(env.project, 'README.md'), 'moved\n');
    env.git(env.project, 'commit', '-q', '-am', 'user moves on');
    const c = await env.manager.create({ workspaceRoot: env.project, owner: owner(3) });
    expect(c.baseCommit).not.toBe(base);
    expect(await readFile(path.join(a.path, 'README.md'), 'utf8')).toBe('base\n');
    expect((await env.manager.status(a.id))).toMatchObject({ dirty: false, ahead: 0, behind: 1, merged: true });
    expect(env.manager.list().map(record => record.id)).toEqual([a.id, b.id, c.id]);
    // A workspace in a subfolder roots the tools in the same subfolder of the worktree.
    await mkdir(path.join(env.project, 'packages', 'app'), { recursive: true });
    await writeFile(path.join(env.project, 'packages', 'app', 'index.ts'), 'export {};\n');
    env.git(env.project, 'add', '-A'); env.git(env.project, 'commit', '-q', '-m', 'app');
    const sub = await env.manager.create({ workspaceRoot: path.join(env.project, 'packages', 'app'), owner: owner(4) });
    expect(sub.prefix).toBe('packages/app');
    expect(sub.root).toBe(path.join(sub.path, 'packages', 'app'));
  });

  it('roots worker file tools in the worktree: the main checkout cannot be written', async () => {
    const env = await fixture();
    // Windows needs a privilege to create symbolic links; the other escapes are checked everywhere.
    const links = process.platform !== 'win32';
    if (links) {
      await symlink(env.project, path.join(env.project, 'checkout-link'));
      env.git(env.project, 'add', '-A'); env.git(env.project, 'commit', '-q', '-m', 'link');
    }
    const handle = await env.manager.create({ workspaceRoot: env.project, owner: owner(1) });
    const tools = createFileTools(handle.root);
    const attempts = [
      path.join(env.project, 'escape.txt'), '../escape.txt', `../../project/escape.txt`, '.git', '.git/config', '.env', ...(links ? ['checkout-link/escape.txt'] : []),
    ];
    for (const target of attempts) {
      const outcome = await runTool(tools, 'write_file', { path: target, content: 'nope' });
      expect(outcome.ok, target).toBe(false);
    }
    expect((await runTool(tools, 'write_file', { path: 'feature.txt', content: 'worker\n' })).ok).toBe(true);
    expect((await runTool(tools, 'edit_file', { path: 'README.md', old_text: 'base', new_text: 'edited' })).ok).toBe(true);
    expect(existsSync(path.join(env.project, 'escape.txt'))).toBe(false);
    expect(existsSync(path.join(env.project, 'feature.txt'))).toBe(false);
    expect(await readFile(path.join(env.project, 'README.md'), 'utf8')).toBe('base\n');
    expect(env.git(env.project, 'status', '--porcelain')).toBe('');
    expect(await readFile(path.join(handle.path, 'feature.txt'), 'utf8')).toBe('worker\n');
    const status = await env.manager.status(handle.id);
    expect(status).toMatchObject({ dirty: true, changedPaths: 2, ahead: 0, merged: true });
  });

  it('refuses non-Git folders, empty repositories, submodules, LFS and a data folder inside the repository', async () => {
    const env = await fixture();
    const plain = path.join(env.root, 'plain');
    await mkdir(plain);
    await expect(env.manager.create({ workspaceRoot: plain, owner: owner(1) })).rejects.toMatchObject({ code: 'not_git' });
    const empty = path.join(env.root, 'empty');
    await mkdir(empty); env.git(empty, 'init', '-q');
    await expect(env.manager.create({ workspaceRoot: empty, owner: owner(1) })).rejects.toMatchObject({ code: 'not_found', message: expect.stringMatching(/first commit/) });
    const modules = await fixture({ files: { '.gitmodules': '[submodule "x"]\n\tpath = x\n\turl = ./x\n' } });
    await expect(modules.manager.create({ workspaceRoot: modules.project, owner: owner(1) })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/submodules/) });
    const lfs = await fixture({ files: { 'assets/.gitattributes': '*.psd filter=lfs diff=lfs merge=lfs -text\n' } });
    await expect(lfs.manager.create({ workspaceRoot: lfs.project, owner: owner(1) })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringMatching(/LFS/) });
    const inside = await fixture({ dataInside: true });
    await expect(inside.manager.create({ workspaceRoot: inside.project, owner: owner(1) })).rejects.toMatchObject({ code: 'location' });
    expect(existsSync(path.join(inside.data, 'worktrees'))).toBe(true);
    expect(inside.manager.list()).toEqual([]);
    // A worktree cannot be the source of another worktree.
    const handle = await env.manager.create({ workspaceRoot: env.project, owner: owner(2) });
    await expect(env.manager.create({ workspaceRoot: handle.path, owner: owner(3) })).rejects.toMatchObject({ code: 'location' });
  });

  it('integrates a released worker after its gate passes and the user approves the exact digest', async () => {
    const env = await fixture();
    const handle = await env.manager.create({ workspaceRoot: env.project, owner: owner(1) });
    await expect(env.queue.propose(handle.id, { gate: pass })).rejects.toMatchObject({ code: 'not_ready' });
    await writeFile(path.join(handle.root, 'feature.txt'), 'worker\n');
    const released = await env.manager.release(handle.id, 'Extalia worker: alpha');
    expect(released.state).toBe('released');
    const before = env.git(env.project, 'rev-parse', 'main');
    const proposal = await env.queue.propose(handle.id, { gate: { command: 'node -e "require(\'fs\').accessSync(\'feature.txt\')"' } });
    expect(proposal).toMatchObject({ status: 'ready', targetBranch: 'main', targetCommit: before, files: [{ path: 'feature.txt', added: 1, deleted: 0 }] });
    expect(proposal.diffDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(proposal.gate).toMatchObject({ exitCode: 0, ok: true, basis: 'verified_by_extalia' });
    expect(proposal.gate!.logDigest).toMatch(/^sha256:/);
    // Nothing reaches the user's branch before approval; a different digest is refused.
    expect(env.git(env.project, 'rev-parse', 'main')).toBe(before);
    await expect(env.queue.apply(proposal.id, { diffDigest: `sha256:${'0'.repeat(64)}` })).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    const applied = await env.queue.apply(proposal.id, { diffDigest: proposal.diffDigest! });
    expect(applied.status).toBe('applied');
    expect(env.git(env.project, 'rev-parse', 'main')).toBe(proposal.mergeCommit);
    // `main` is checked out in the project: it was fast-forwarded there, never reset.
    expect(await readFile(path.join(env.project, 'feature.txt'), 'utf8')).toBe('worker\n');
    expect(env.git(env.project, 'status', '--porcelain')).toBe('');
    expect(env.git(env.project, 'rev-parse', `${proposal.mergeCommit!}^1`)).toBe(before);
    expect(env.manager.get(handle.id).integratedAs).toBe(proposal.mergeCommit);
    // Integrated and clean: removal needs no confirmation and deletes the branch.
    await env.manager.remove(handle.id);
    expect(existsSync(handle.path)).toBe(false);
    expect(env.git(env.project, 'branch', '--list', handle.branch)).toBe('');
    expect(env.queue.list().map(item => item.status)).toEqual(['applied']);
  });

  it('detects a conflict between two workers before anything is merged', async () => {
    const env = await fixture();
    const [a, b] = await Promise.all([env.manager.create({ workspaceRoot: env.project, owner: owner(1) }), env.manager.create({ workspaceRoot: env.project, owner: owner(2) })]);
    // Two workers edit the same line in their own worktrees, in parallel.
    await Promise.all([
      runTool(createFileTools(a.root), 'edit_file', { path: 'shared.txt', old_text: 'two', new_text: 'two from A' }),
      runTool(createFileTools(b.root), 'edit_file', { path: 'shared.txt', old_text: 'two', new_text: 'two from B' }),
      runTool(createFileTools(b.root), 'write_file', { path: 'only-b.txt', content: 'b\n' }),
    ]);
    expect(await readFile(path.join(a.path, 'shared.txt'), 'utf8')).toContain('two from A');
    expect(await readFile(path.join(b.path, 'shared.txt'), 'utf8')).toContain('two from B');
    await env.manager.release(a.id, 'a'); await env.manager.release(b.id, 'b');
    const first = await env.queue.propose(a.id, { gate: pass });
    await env.queue.apply(first.id, { diffDigest: first.diffDigest! });
    const tip = env.git(env.project, 'rev-parse', 'main');
    const second = await env.queue.propose(b.id, { gate: pass });
    expect(second).toMatchObject({ status: 'conflict', conflicts: ['shared.txt'], targetCommit: tip });
    expect(second.mergeCommit).toBeUndefined();
    expect(second.gate).toBeUndefined();
    await expect(env.queue.apply(second.id, { diffDigest: `sha256:${'0'.repeat(64)}` })).rejects.toMatchObject({ code: 'not_ready' });
    expect(env.git(env.project, 'rev-parse', 'main')).toBe(tip);
    expect(await readFile(path.join(env.project, 'shared.txt'), 'utf8')).toBe('one\ntwo from A\nthree\n');
    expect(existsSync(path.join(env.project, 'only-b.txt'))).toBe(false);
    // The disposable integration worktree is gone; the conflicting worker keeps its work.
    expect(env.git(env.project, 'worktree', 'list').split('\n')).toHaveLength(3);
    await expect(env.manager.remove(b.id)).rejects.toMatchObject({ code: 'unmerged_changes' });
  });

  it('blocks integration when the test gate fails or is not configured', async () => {
    const env = await fixture();
    const handle = await env.manager.create({ workspaceRoot: env.project, owner: owner(1) });
    await writeFile(path.join(handle.root, 'broken.txt'), 'x\n');
    await env.manager.release(handle.id, 'worker');
    const before = env.git(env.project, 'rev-parse', 'main');
    const failed = await env.queue.propose(handle.id, { gate: { command: 'node -e "console.log(\'gate says no\'); process.exit(3)"', timeoutSeconds: 60 } });
    expect(failed).toMatchObject({ status: 'gate_failed', gate: { exitCode: 3, ok: false } });
    expect(failed.gate!.log).toContain('gate says no');
    await expect(env.queue.apply(failed.id, { diffDigest: failed.diffDigest! })).rejects.toMatchObject({ code: 'not_ready' });
    const ungated = await env.queue.propose(handle.id);
    expect(ungated.status).toBe('gate_missing');
    await expect(env.queue.apply(ungated.id, { diffDigest: ungated.diffDigest! })).rejects.toMatchObject({ code: 'not_ready' });
    expect(env.git(env.project, 'rev-parse', 'main')).toBe(before);
    expect(existsSync(path.join(env.project, 'broken.txt'))).toBe(false);
  });

  it('never moves a target that changed, never overwrites local changes and swaps refs that are not checked out', async () => {
    const env = await fixture();
    // Stale: the target moved after the proposal.
    const first = await env.manager.create({ workspaceRoot: env.project, owner: owner(1) });
    await writeFile(path.join(first.root, 'a.txt'), 'a\n');
    await env.manager.release(first.id, 'a');
    const stale = await env.queue.propose(first.id, { gate: pass });
    await writeFile(path.join(env.project, 'user.txt'), 'user\n');
    env.git(env.project, 'add', '-A'); env.git(env.project, 'commit', '-q', '-m', 'user work');
    const userTip = env.git(env.project, 'rev-parse', 'main');
    expect((await env.queue.apply(stale.id, { diffDigest: stale.diffDigest! })).status).toBe('stale');
    expect(env.git(env.project, 'rev-parse', 'main')).toBe(userTip);
    // Local changes in the checkout that the merge would overwrite: refused, nothing changes.
    const second = await env.queue.propose(first.id, { gate: pass });
    await writeFile(path.join(env.project, 'a.txt'), 'uncommitted user file\n');
    await expect(env.queue.apply(second.id, { diffDigest: second.diffDigest! })).rejects.toMatchObject({ code: 'in_use' });
    expect(env.git(env.project, 'rev-parse', 'main')).toBe(userTip);
    expect(await readFile(path.join(env.project, 'a.txt'), 'utf8')).toBe('uncommitted user file\n');
    await rm(path.join(env.project, 'a.txt'));
    expect((await env.queue.apply(second.id, { diffDigest: second.diffDigest! })).status).toBe('applied');
    // A target branch nobody has checked out moves by compare-and-swap.
    env.git(env.project, 'branch', 'release');
    const releaseTip = env.git(env.project, 'rev-parse', 'release');
    const third = await env.manager.create({ workspaceRoot: env.project, owner: owner(2), base: 'release' });
    expect(third.baseBranch).toBe('release');
    await writeFile(path.join(third.root, 'r.txt'), 'r\n');
    await env.manager.release(third.id, 'r');
    const proposal = await env.queue.propose(third.id, { gate: pass });
    expect(proposal.targetBranch).toBe('release');
    await env.queue.apply(proposal.id, { diffDigest: proposal.diffDigest! });
    expect(env.git(env.project, 'rev-parse', 'release')).toBe(proposal.mergeCommit);
    expect(env.git(env.project, 'rev-parse', `${proposal.mergeCommit!}^1`)).toBe(releaseTip);
    expect(existsSync(path.join(env.project, 'r.txt'))).toBe(false);
  });

  it('reports worktrees left by a crash as orphans and removes unmerged work only with the reviewed fingerprint', async () => {
    const env = await fixture();
    const crashed = await env.manager.create({ workspaceRoot: env.project, owner: owner(1) });
    env.active.add(owner(1).missionId);
    await writeFile(path.join(crashed.root, 'half-done.txt'), 'work in progress\n');
    await expect(env.manager.remove(crashed.id)).rejects.toMatchObject({ code: 'in_use' });
    expect(await env.manager.orphans()).toEqual([]);
    await mkdir(path.join(env.data, 'worktrees', 'stray'));
    // The host restarts: the task cannot be running any more, but nothing is cleaned up automatically.
    env.active.clear();
    const restarted = await env.open();
    const orphans = await restarted.manager.orphans();
    expect(orphans).toEqual([
      { reason: 'owner-ended', id: crashed.id, path: crashed.path, branch: crashed.branch, owner: owner(1), dirty: true, unmerged: true },
      { reason: 'unregistered', path: path.join(env.data, 'worktrees', 'stray') },
    ]);
    expect(await readFile(path.join(crashed.path, 'half-done.txt'), 'utf8')).toBe('work in progress\n');
    expect(env.git(env.project, 'branch', '--list', crashed.branch)).toContain(crashed.branch);
    // Removal of unmerged work needs the explicit user path: the exact fingerprint they reviewed.
    await expect(restarted.manager.remove(crashed.id)).rejects.toMatchObject({ code: 'unmerged_changes' });
    await expect(restarted.manager.remove(crashed.id, { fingerprint: `sha256:${'f'.repeat(64)}` })).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    const reviewed = await restarted.manager.status(crashed.id);
    await writeFile(path.join(crashed.root, 'later.txt'), 'changed after review\n');
    await expect(restarted.manager.remove(crashed.id, { fingerprint: reviewed.fingerprint })).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    expect(existsSync(crashed.path)).toBe(true);
    const current = await restarted.manager.status(crashed.id);
    await restarted.manager.remove(crashed.id, { fingerprint: current.fingerprint });
    expect(existsSync(crashed.path)).toBe(false);
    expect(env.git(env.project, 'branch', '--list', crashed.branch)).toBe('');
    expect(restarted.manager.list()).toEqual([]);
    expect(env.git(env.project, 'status', '--porcelain')).toBe('');
  });
});
