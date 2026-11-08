import * as childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommandTool, WORKSPACE_COMMAND_UNAVAILABLE } from '../src/tools/command.js';
import { IntegrationQueue, WorktreeManager } from '../src/worktrees/index.js';
import { runTool, useTempDirs } from './helpers.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const tempDir = useTempDirs();
afterEach(() => vi.clearAllMocks());

/** Both the command and its child could write outside the selected project if launched. */
function writeAttempt(marker: string, childMarker: string): string {
  const child = `require('node:fs').writeFileSync(${JSON.stringify(childMarker)}, 'child')`;
  return `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'parent'); require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(child)}]);`;
}

describe('required Native command filesystem boundary', () => {
  it('refuses arbitrary writes and child execution before any spawn or command event', async () => {
    const root = await tempDir('extalia-command-boundary-');
    const project = path.join(root, 'project');
    await mkdir(project);
    const marker = path.join(root, 'outside-project.txt'), childMarker = path.join(root, 'outside-child.txt');
    await writeFile(path.join(project, 'attempt.cjs'), writeAttempt(marker, childMarker));
    const spawn = vi.mocked(childProcess.spawn);
    const tool = createCommandTool(project, { filesystemBoundary: 'required', env: { PATH: process.env.PATH } });

    expect(tool.description).toBe(WORKSPACE_COMMAND_UNAVAILABLE);
    expect(tool.precheck?.({ command: 'node attempt.cjs' })).toBe(WORKSPACE_COMMAND_UNAVAILABLE);
    expect(tool.describe({ command: 'node attempt.cjs' }).label).toBe('Native commands unavailable');
    const result = await runTool([tool], 'run_command', { command: 'node attempt.cjs' });

    expect(result).toEqual({ ok: false, output: WORKSPACE_COMMAND_UNAVAILABLE, events: [] });
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(childMarker)).toBe(false);
  });

  it('refuses even an empty or already cancelled command without execution events', async () => {
    const project = await tempDir('extalia-command-boundary-');
    const tool = createCommandTool(project, { filesystemBoundary: 'required' });
    const controller = new AbortController();
    controller.abort();
    const result = await runTool([tool], 'run_command', { command: '' }, controller.signal);
    expect(result).toEqual({ ok: false, output: WORKSPACE_COMMAND_UNAVAILABLE, events: [] });
  });
});

const hasGit = (() => { try { childProcess.execFileSync('git', ['--version']); return true; } catch { return false; } })();

describe.skipIf(!hasGit)('integration gate workspace boundary', { timeout: 60_000 }, () => {
  it('records an unexecuted failed gate, persists it and refuses applying the proposal', async () => {
    const root = await tempDir('extalia-gate-boundary-');
    const project = path.join(root, 'project'), home = path.join(root, 'home'), data = path.join(root, 'data');
    await mkdir(project); await mkdir(home);
    const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) => childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: project, env, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    const marker = path.join(root, 'outside-project.txt'), childMarker = path.join(root, 'outside-child.txt');
    await writeFile(path.join(project, 'gate.cjs'), writeAttempt(marker, childMarker));
    git('add', '-A'); git('commit', '-q', '-m', 'base');
    const before = git('rev-parse', 'HEAD');
    const manager = await WorktreeManager.open({ directory: path.join(data, 'worktrees'), registryFile: path.join(data, 'worktrees.json'), git: { env } });
    const registryFile = path.join(data, 'integrations.json');
    const options = { registryFile, env, requireWorkspaceBoundary: true };
    const queue = await IntegrationQueue.open(manager, options);
    const worker = await manager.create({ workspaceRoot: project, owner: { missionId: '00000000-0000-4000-8000-000000000001', taskId: '00000000-0000-4000-8000-000000000002' } });
    await writeFile(path.join(worker.root, 'feature.txt'), 'worker change\n');
    await manager.release(worker.id, 'worker');
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();

    const proposal = await queue.propose(worker.id, { gate: { command: 'node gate.cjs' } });

    expect(proposal).toMatchObject({ status: 'gate_failed', gate: { ok: false, exitCode: 1, basis: 'not_run', log: WORKSPACE_COMMAND_UNAVAILABLE } });
    expect(spawn.mock.calls.some(([, options]) => options && typeof options === 'object' && 'shell' in options && options.shell === true)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(childMarker)).toBe(false);
    await expect(queue.apply(proposal.id, { diffDigest: proposal.diffDigest! })).rejects.toMatchObject({ code: 'not_ready' });
    expect(git('rev-parse', 'HEAD')).toBe(before);
    const reopened = await IntegrationQueue.open(manager, options);
    expect(reopened.get(proposal.id).gate).toEqual(proposal.gate);
  });
});
