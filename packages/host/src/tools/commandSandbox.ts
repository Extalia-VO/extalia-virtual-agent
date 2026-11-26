import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CommandSandboxKind, CommandSandboxStatus } from '@extalia/platform';

export interface CommandSandboxSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  dataDirectory?: string;
  homeDirectory?: string;
  tempDirectory?: string;
}

export interface CommandSandboxSpawnResult {
  child: ChildProcess;
  cleanup(): Promise<void>;
}

export interface CommandSandboxExecutor {
  readonly status: CommandSandboxStatus;
  spawn(command: string, options: CommandSandboxSpawnOptions): Promise<CommandSandboxSpawnResult>;
}

export interface SeatbeltProfileOptions {
  workspaceRoot: string;
  tempDirectory: string;
  dataDirectory?: string;
  homeDirectory?: string;
}

export interface BwrapArgsOptions {
  workspaceRoot: string;
  tempDirectory: string;
  command: string;
}

export interface ProbeCommandSandboxOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  dataDirectory?: string;
  binary?: string;
}

const SENSITIVE_HOME_ENTRIES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
] as const;

const PROBE_TIMEOUT_MS = 10_000;

function escapeSeatbeltString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\0', '');
}

function isWithinPosix(parent: string, child: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
}

async function canonicalPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Builds a macOS Seatbelt (`sandbox-exec`) profile that restricts writes to the
 * canonical workspace root, per-command temp directory, and standard device nodes,
 * denies reads of Extalia's data directory and sensitive home credential locations,
 * and denies all inbound and outbound network access.
 */
export function buildSeatbeltProfile(options: SeatbeltProfileOptions): string {
  const workspaceRoot = path.posix.resolve(options.workspaceRoot);
  const tempDirectory = path.posix.resolve(options.tempDirectory);
  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${escapeSeatbeltString(workspaceRoot)}") (subpath "${escapeSeatbeltString(tempDirectory)}") (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
  ];

  const deniedReadPaths: string[] = [];
  if (options.dataDirectory) {
    const dataDirectory = path.posix.resolve(options.dataDirectory);
    if (!isWithinPosix(workspaceRoot, dataDirectory)) {
      deniedReadPaths.push(dataDirectory);
    }
  }
  if (options.homeDirectory) {
    const homeDirectory = path.posix.resolve(options.homeDirectory);
    for (const entry of SENSITIVE_HOME_ENTRIES) {
      const target = path.posix.join(homeDirectory, entry);
      if (!isWithinPosix(workspaceRoot, target)) {
        deniedReadPaths.push(target);
      }
    }
  }

  if (deniedReadPaths.length > 0) {
    const clauses = deniedReadPaths.map(item => `(subpath "${escapeSeatbeltString(item)}")`).join(' ');
    lines.push(`(deny file-read* ${clauses})`);
    // Disposable integration worktrees live under `<dataDirectory>/worktrees/<id>`;
    // re-allow reads strictly inside the active workspace root and per-command temp dir.
    lines.push(`(allow file-read* (subpath "${escapeSeatbeltString(workspaceRoot)}") (subpath "${escapeSeatbeltString(tempDirectory)}"))`);
  }

  lines.push('(deny network-outbound)');
  lines.push('(deny network-inbound)');
  return `${lines.join('\n')}\n`;
}

/**
 * Builds Linux bubblewrap (`bwrap`) arguments that isolate PID, UTS, IPC, and
 * network namespaces, mount system trees read-only, bind only the canonical
 * workspace root and per-command temp directory read-write, and chdir into the
 * workspace root.
 */
export function buildBwrapArgs(options: BwrapArgsOptions): string[] {
  const workspaceRoot = path.posix.resolve(options.workspaceRoot);
  const tempDirectory = path.posix.resolve(options.tempDirectory);
  return [
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
    '--bind', workspaceRoot, workspaceRoot,
    '--bind', tempDirectory, tempDirectory,
    '--chdir', workspaceRoot,
    '--', '/bin/sh', '-c', options.command,
  ];
}

function unsupportedExecutor(platform: string, reason: string): CommandSandboxExecutor {
  const status: CommandSandboxStatus = {
    supported: false,
    kind: 'none',
    platform,
    networkAccess: 'denied',
    reason,
  };
  return {
    status,
    async spawn() {
      throw new Error(reason);
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runProbeCommand(
  executorSpawn: CommandSandboxExecutor['spawn'],
  command: string,
  options: CommandSandboxSpawnOptions,
): Promise<{ exitCode: number | null; error?: Error }> {
  const { child, cleanup } = await executorSpawn(command, options);
  try {
    return await new Promise<{ exitCode: number | null; error?: Error }>(resolve => {
      let settled = false;
      const finish = (result: { exitCode: number | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
        }
        finish({ exitCode: null, error: new Error('Sandbox probe timed out.') });
      }, PROBE_TIMEOUT_MS);
      timer.unref();
      child.on('error', error => finish({ exitCode: null, error }));
      child.on('close', code => finish({ exitCode: code }));
    });
  } finally {
    await cleanup();
  }
}

function createVerifiedSpawn(
  kind: Exclude<CommandSandboxKind, 'none'>,
  binary: string,
  defaults: { homeDirectory?: string; dataDirectory?: string },
): CommandSandboxExecutor['spawn'] {
  return async (command, options) => {
    const workspaceRoot = await canonicalPath(options.cwd);
    const ownedTemp = !options.tempDirectory;
    const rawTemp = options.tempDirectory ?? await mkdtemp(path.join(tmpdir(), 'extalia-sandbox-cmd-'));
    const tempDirectory = await canonicalPath(rawTemp);
    const dataDirectory = options.dataDirectory ?? defaults.dataDirectory;
    const homeDirectory = options.homeDirectory ?? defaults.homeDirectory;
    const canonicalData = dataDirectory ? await canonicalPath(dataDirectory) : undefined;
    const canonicalHome = homeDirectory ? await canonicalPath(homeDirectory) : undefined;

    const cleanup = async () => {
      if (ownedTemp) {
        await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    };

    try {
      const env: Record<string, string> = {
        ...options.env,
        TMPDIR: tempDirectory,
        TEMP: tempDirectory,
        TMP: tempDirectory,
      };
      const args = kind === 'macos-seatbelt'
        ? ['-p', buildSeatbeltProfile({ workspaceRoot, tempDirectory, dataDirectory: canonicalData, homeDirectory: canonicalHome }), '/bin/sh', '-c', command]
        : buildBwrapArgs({ workspaceRoot, tempDirectory, command });

      const child = spawn(binary, args, {
        cwd: workspaceRoot,
        detached: true,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return { child, cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  };
}

/**
 * Probes the host OS for a real, verified workspace-isolated command sandbox.
 * Never falls back silently: returns `supported: true` only after verifying both
 * an allowed in-workspace write and a blocked out-of-workspace escape write.
 */
export async function probeCommandSandbox(options: ProbeCommandSandboxOptions = {}): Promise<CommandSandboxExecutor> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'linux') {
    return unsupportedExecutor(platform, `No verified workspace-isolated command sandbox is available on ${platform}.`);
  }

  const kind: Exclude<CommandSandboxKind, 'none'> = platform === 'darwin' ? 'macos-seatbelt' : 'linux-bwrap';
  const binary = options.binary ?? (platform === 'darwin' ? '/usr/bin/sandbox-exec' : 'bwrap');
  const candidateSpawn = createVerifiedSpawn(kind, binary, {
    homeDirectory: options.homeDirectory,
    dataDirectory: options.dataDirectory,
  });

  const probeBase = await canonicalPath(await mkdtemp(path.join(tmpdir(), 'extalia-sandbox-probe-')));
  const workspaceDir = path.join(probeBase, 'workspace');
  const outsideDir = path.join(probeBase, 'outside');
  const tempDir = path.join(probeBase, 'tmp');
  await mkdir(workspaceDir);
  await mkdir(outsideDir);
  await mkdir(tempDir);

  const probeEnv: Record<string, string> = {};
  const pathEnv = options.env?.PATH ?? process.env.PATH;
  if (pathEnv) probeEnv.PATH = pathEnv;

  try {
    const insideFile = path.join(workspaceDir, 'probe-ok.txt');
    const insideResult = await runProbeCommand(
      candidateSpawn,
      `printf ok > ${shellQuote(insideFile)}`,
      { cwd: workspaceDir, env: probeEnv, tempDirectory: tempDir, dataDirectory: options.dataDirectory, homeDirectory: options.homeDirectory },
    );
    if (insideResult.error || insideResult.exitCode !== 0 || !existsSync(insideFile)) {
      const detail = insideResult.error ? insideResult.error.message : `exit code ${insideResult.exitCode ?? 'unknown'}`;
      return unsupportedExecutor(platform, `Command sandbox probe failed to allow workspace write (${binary}: ${detail}).`);
    }

    const escapeFile = path.join(outsideDir, 'probe-escape.txt');
    const escapeResult = await runProbeCommand(
      candidateSpawn,
      `printf escape > ${shellQuote(escapeFile)}`,
      { cwd: workspaceDir, env: probeEnv, tempDirectory: tempDir, dataDirectory: options.dataDirectory, homeDirectory: options.homeDirectory },
    );
    if (escapeResult.error) {
      return unsupportedExecutor(platform, `Command sandbox escape probe errored (${binary}: ${escapeResult.error.message}).`);
    }
    if (escapeResult.exitCode === 0 || existsSync(escapeFile)) {
      return unsupportedExecutor(platform, `Command sandbox failed containment verification: write outside workspace was not blocked (${binary}).`);
    }

    const status: CommandSandboxStatus = {
      supported: true,
      kind,
      platform,
      networkAccess: 'denied',
      verifiedAt: new Date().toISOString(),
    };
    return {
      status,
      spawn: candidateSpawn,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unsupportedExecutor(platform, `Command sandbox probe failed (${binary}: ${message}).`);
  } finally {
    await rm(probeBase, { recursive: true, force: true }).catch(() => undefined);
  }
}
