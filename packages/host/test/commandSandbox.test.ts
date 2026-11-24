import { execFileSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCommandTool } from '../src/tools/command.js';
import {
  buildBwrapArgs,
  buildSeatbeltProfile,
  probeCommandSandbox,
  type CommandSandboxExecutor,
} from '../src/tools/commandSandbox.js';
import { IntegrationQueue, WorktreeManager } from '../src/worktrees/index.js';
import { runTool, useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
const hasGit = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

describe('commandSandbox profile and argument builders', () => {
  it('builds a Seatbelt profile with escaped paths, credential read denials, and network denial', () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: '/Users/<name>/work "quoted"\\dir',
      tempDirectory: '/tmp/extalia-cmd',
      dataDirectory: '/Users/<name>/.extalia-vo',
      homeDirectory: '/Users/<name>',
    });

    expect(profile).toContain('(version 1)');
    expect(profile).toContain('(allow default)');
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(subpath "/Users/<name>/work \\"quoted\\"\\\\dir")');
    expect(profile).toContain('(subpath "/tmp/extalia-cmd")');
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(literal "/dev/tty")');
    expect(profile).toContain('(literal "/dev/dtracehelper")');
    expect(profile).toContain('(deny file-read*');
    expect(profile).toContain('(subpath "/Users/<name>/.extalia-vo")');
    expect(profile).toContain('(subpath "/Users/<name>/.ssh")');
    expect(profile).toContain('(subpath "/Users/<name>/.aws")');
    expect(profile).toContain('(subpath "/Users/<name>/.gnupg")');
    expect(profile).toContain('(subpath "/Users/<name>/.kube")');
    expect(profile).toContain('(subpath "/Users/<name>/.npmrc")');
    expect(profile).toContain('(subpath "/Users/<name>/.netrc")');
    expect(profile).toContain('(subpath "/Users/<name>/.pypirc")');
    expect(profile).toContain('(subpath "/Users/<name>/.git-credentials")');
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).toContain('(deny network-inbound)');
  });

  it('builds Linux bubblewrap arguments with namespace isolation and workspace-only write binds', () => {
    const args = buildBwrapArgs({
      workspaceRoot: '/workspace/app',
      tempDirectory: '/tmp/extalia-cmd',
      command: 'echo hello',
    });

    expect(args).toEqual([
      '--unshare-pid',
      '--unshare-uts',
      '--unshare-ipc',
      '--unshare-net',
      '--die-with-parent',
      '--new-session',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc', '/etc',
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      '--bind', '/workspace/app', '/workspace/app',
      '--bind', '/tmp/extalia-cmd', '/tmp/extalia-cmd',
      '--chdir', '/workspace/app',
      '--', '/bin/sh', '-c', 'echo hello',
    ]);
  });
});

describe('probeCommandSandbox fail-closed behavior', () => {
  it('fails closed on win32 and unsupported platforms', async () => {
    const win = await probeCommandSandbox({ platform: 'win32' });
    expect(win.status).toMatchObject({
      supported: false,
      kind: 'none',
      platform: 'win32',
      networkAccess: 'denied',
    });
    expect(win.status.reason).toBeTruthy();
    await expect(win.spawn('echo hi', { cwd: '/tmp', env: {} })).rejects.toThrow();

    const bsd = await probeCommandSandbox({ platform: 'freebsd' });
    expect(bsd.status.supported).toBe(false);
    expect(bsd.status.kind).toBe('none');
  });

  it('fails closed when the sandbox binary does not exist', async () => {
    const sandbox = await probeCommandSandbox({
      platform: 'darwin',
      binary: '/nonexistent/extalia-missing-sandbox-exec',
    });
    expect(sandbox.status.supported).toBe(false);
    expect(sandbox.status.kind).toBe('none');
    expect(sandbox.status.reason).toContain('extalia-missing-sandbox-exec');
  });

  it('fails closed when a candidate binary fails to block out-of-workspace writes', async () => {
    const root = await tempDir('extalia-fake-sandbox-');
    const fakeBin = path.join(root, 'fake-sandbox.sh');
    // Ignores `-p <profile>` and executes `/bin/sh -c <cmd>` unsandboxed; probe MUST detect the escape.
    await writeFile(fakeBin, '#!/bin/sh\nshift 2\nexec "$@"\n', 'utf8');
    await chmod(fakeBin, 0o755);

    const sandbox = await probeCommandSandbox({
      platform: 'darwin',
      binary: fakeBin,
    });
    expect(sandbox.status.supported).toBe(false);
    expect(sandbox.status.kind).toBe('none');
    expect(sandbox.status.reason).toContain('containment');
  });
});

describe('command settlement states', () => {
  it('reports settlement as unknown when a stuck child process cannot be reaped', async () => {
    const root = await tempDir('extalia-reap-unknown-');
    let cleaned = false;
    const fakeSandbox: CommandSandboxExecutor = {
      status: {
        supported: true,
        kind: 'macos-seatbelt',
        platform: process.platform,
        networkAccess: 'denied',
        verifiedAt: new Date().toISOString(),
      },
      async spawn() {
        const fakeChild = Object.assign(new EventEmitter(), {
          pid: undefined,
          stdout: new PassThrough(),
          stderr: new PassThrough(),
        }) as unknown as ChildProcess;
        return {
          child: fakeChild,
          async cleanup() { cleaned = true; },
        };
      },
    };

    const tool = createCommandTool(root, {
      filesystemBoundary: 'required',
      sandbox: fakeSandbox,
      killGraceMs: 50,
    });
    const controller = new AbortController();
    const pending = tool.run(
      { command: 'sleep 10', timeout_seconds: 10 },
      { signal: controller.signal, toolCallId: 'call-reap', emit: () => {} },
    );
    controller.abort();
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    expect(outcome.settlement).toBe('unknown');
    expect(outcome.output).toContain('unknown');
    expect(cleaned).toBe(true);
  }, 15_000);
});

describe.skipIf(process.platform !== 'darwin')('live macOS Seatbelt sandbox probe and execution', { timeout: 30_000 }, () => {
  it('verifies sandbox-exec, enforces workspace containment, shields credentials, and reports settlement', async () => {
    const base = await realpath(await tempDir('extalia-live-sandbox-'));
    const workspace = path.join(base, 'workspace');
    const outside = path.join(base, 'outside');
    const dataDir = path.join(base, 'data');
    const homeDir = path.join(base, 'home');
    await mkdir(workspace);
    await mkdir(outside);
    await mkdir(dataDir);
    await mkdir(path.join(homeDir, '.ssh'), { recursive: true });
    await writeFile(path.join(dataDir, 'secret.txt'), 'extalia-data-secret', 'utf8');
    await writeFile(path.join(homeDir, '.ssh', 'id_rsa'), 'private-ssh-key', 'utf8');

    const sandbox = await probeCommandSandbox({
      platform: 'darwin',
      dataDirectory: dataDir,
      homeDirectory: homeDir,
    });
    expect(sandbox.status.supported).toBe(true);
    expect(sandbox.status.kind).toBe('macos-seatbelt');
    expect(sandbox.status.networkAccess).toBe('denied');
    expect(sandbox.status.verifiedAt).toBeTruthy();

    const tool = createCommandTool(workspace, {
      filesystemBoundary: 'required',
      sandbox,
      dataDirectory: dataDir,
      homeDirectory: homeDir,
      env: { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-should-be-scrubbed' },
      killGraceMs: 100,
    });

    // 1. Allowed write inside workspace + credential env scrubbing
    const okResult = await tool.run(
      { command: 'printf "inside" > ok.txt && printf "%s" "$OPENAI_API_KEY"' },
      { signal: new AbortController().signal, toolCallId: 'call-ok', emit: () => {} },
    );
    expect(okResult.ok).toBe(true);
    expect(okResult.settlement).toBe('passed');
    expect(await readFile(path.join(workspace, 'ok.txt'), 'utf8')).toBe('inside');
    expect(okResult.output).not.toContain('sk-should-be-scrubbed');

    // 2. Blocked write outside workspace
    const escapeFile = path.join(outside, 'escape.txt');
    const escapeResult = await tool.run(
      { command: `printf "nope" > "${escapeFile}"` },
      { signal: new AbortController().signal, toolCallId: 'call-escape', emit: () => {} },
    );
    expect(escapeResult.ok).toBe(false);
    expect(escapeResult.settlement).toBe('failed');
    expect(existsSync(escapeFile)).toBe(false);

    // 3. Blocked read of Extalia data directory and ~/.ssh
    const dataRead = await tool.run(
      { command: `cat "${path.join(dataDir, 'secret.txt')}"` },
      { signal: new AbortController().signal, toolCallId: 'call-data', emit: () => {} },
    );
    expect(dataRead.ok).toBe(false);
    expect(dataRead.output).not.toContain('extalia-data-secret');

    const sshRead = await tool.run(
      { command: `cat "${path.join(homeDir, '.ssh', 'id_rsa')}"` },
      { signal: new AbortController().signal, toolCallId: 'call-ssh', emit: () => {} },
    );
    expect(sshRead.ok).toBe(false);
    expect(sshRead.output).not.toContain('private-ssh-key');

    // 4. Timeout settlement
    const timeoutResult = await tool.run(
      { command: 'sleep 5', timeout_seconds: 1 },
      { signal: new AbortController().signal, toolCallId: 'call-timeout', emit: () => {} },
    );
    expect(timeoutResult.ok).toBe(false);
    expect(timeoutResult.settlement).toBe('timed_out');

    // 5. Cancelled settlement
    const cancelController = new AbortController();
    cancelController.abort();
    const cancelResult = await runTool([tool], 'run_command', { command: 'echo never' }, cancelController.signal);
    expect(cancelResult.ok).toBe(false);
  });

  it.skipIf(!hasGit)('runs IntegrationQueue gates inside the verified sandbox and records settlement + executor', async () => {
    const base = await realpath(await tempDir('extalia-gate-sandbox-'));
    const project = path.join(base, 'project');
    const home = path.join(base, 'home');
    const data = path.join(base, 'data');
    await mkdir(project);
    await mkdir(home);
    const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]) => execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: project, env, encoding: 'utf8' },
    ).trim();
    git('init', '-q', '-b', 'main');
    await writeFile(path.join(project, 'README.md'), 'base\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');

    const sandbox = await probeCommandSandbox({ platform: 'darwin', dataDirectory: data, homeDirectory: home });
    expect(sandbox.status.supported).toBe(true);

    const manager = await WorktreeManager.open({
      directory: path.join(data, 'worktrees'),
      registryFile: path.join(data, 'worktrees.json'),
      git: { env },
    });
    const registryFile = path.join(data, 'integrations.json');
    const queueOptions = {
      registryFile,
      env,
      requireWorkspaceBoundary: true,
      sandbox,
      dataDirectory: data,
      homeDirectory: home,
    };
    const queue = await IntegrationQueue.open(manager, queueOptions);
    const worker = await manager.create({
      workspaceRoot: project,
      owner: { missionId: '00000000-0000-4000-8000-000000000011', taskId: '00000000-0000-4000-8000-000000000012' },
    });
    await writeFile(path.join(worker.root, 'feature.txt'), 'ok\n', 'utf8');
    await manager.release(worker.id, 'worker');

    // Passing sandboxed gate -> ready
    const passed = await queue.propose(worker.id, { gate: { command: 'test -f feature.txt' } });
    expect(passed.status).toBe('ready');
    expect(passed.gate).toMatchObject({
      ok: true,
      exitCode: 0,
      basis: 'verified_by_extalia',
      outcome: 'passed',
      executor: { kind: 'macos-seatbelt', isolated: true, networkAccess: 'denied' },
    });

    // Timed-out sandboxed gate -> gate_failed, never ready
    const timedOut = await queue.propose(worker.id, { gate: { command: 'sleep 5', timeoutSeconds: 1 } });
    expect(timedOut.status).toBe('gate_failed');
    expect(timedOut.gate).toMatchObject({
      ok: false,
      basis: 'verified_by_extalia',
      outcome: 'timed_out',
      executor: { kind: 'macos-seatbelt', isolated: true, networkAccess: 'denied' },
    });
    await expect(queue.apply(timedOut.id, { diffDigest: timedOut.diffDigest! })).rejects.toMatchObject({ code: 'not_ready' });

    // Persisted gate fields round-trip cleanly on reopen
    const reopened = await IntegrationQueue.open(manager, queueOptions);
    expect(reopened.get(passed.id).gate).toEqual(passed.gate);
    expect(reopened.get(timedOut.id).gate).toEqual(timedOut.gate);
  });
});
