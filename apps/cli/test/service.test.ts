import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServiceRunCommand } from '@extalia/host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type CliHost } from '../src/cli';
import { parseServiceArgs } from '../src/service';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('extalia service CLI', () => {
  let root: string;
  let homeDirectory: string;
  let extaliaHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-cli-service-'));
    homeDirectory = path.join(root, 'home');
    extaliaHome = path.join(root, 'extalia-home');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(extaliaHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeHost(overrides: Partial<CliHost> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];
    const serviceRunCommand: ServiceRunCommand = async (command, args) => {
      calls.push({ command, args });
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const value: CliHost = {
      version: '0.0.0-test',
      out: line => out.push(line),
      err: line => err.push(line),
      readFile: file => readFile(file, 'utf8'),
      exists,
      platform: 'linux',
      arch: 'x64',
      nodeVersion: 'v24.1.0',
      env: { EXTALIA_HOME: extaliaHome },
      homeDirectory,
      binPath: '/opt/extalia/extalia.mjs',
      serviceExecutablePath: '/usr/bin/node',
      serviceRunCommand,
      serviceUid: 1000,
      serviceNow: () => new Date('2026-11-24T12:00:00.000Z'),
      serviceUptimeSeconds: () => 3600,
      start: async () => 0,
      update: async () => 0,
      ...overrides,
    };
    return { value, out, err, calls };
  }

  it('parses valid service arguments and rejects invalid options', () => {
    expect(parseServiceArgs(['install', '--dry-run', '--port', '4410'])).toEqual({
      action: 'install',
      dryRun: true,
      yes: false,
      port: 4410,
    });
    expect(parseServiceArgs(['install', '-y', '--port=4311'])).toEqual({
      action: 'install',
      dryRun: false,
      yes: true,
      port: 4311,
    });
    expect(parseServiceArgs(['uninstall', '--dry-run'])).toEqual({
      action: 'uninstall',
      dryRun: true,
      yes: false,
    });
    expect(parseServiceArgs(['status', '--json'])).toEqual({ action: 'status', json: true });
    expect(parseServiceArgs(['start'])).toEqual({ action: 'start' });
    expect(parseServiceArgs(['stop'])).toEqual({ action: 'stop' });

    expect(typeof parseServiceArgs([])).toBe('string');
    expect(typeof parseServiceArgs(['install', '--port', '0'])).toBe('string');
    expect(typeof parseServiceArgs(['install', '--bogus'])).toBe('string');
    expect(typeof parseServiceArgs(['status', '--port', '4310'])).toBe('string');
    expect(typeof parseServiceArgs(['start', '--yes'])).toBe('string');
  });

  it('supports install --dry-run without writing files or running OS commands', async () => {
    const io = makeHost();
    const code = await run(['service', 'install', '--dry-run', '--port', '4420'], io.value);
    expect(code).toBe(0);
    const output = io.out.join('\n');
    expect(output).toContain('Target:');
    expect(output).toContain('Backup:');
    expect(output).toContain('Undo: extalia service uninstall');
    expect(output).toContain('http://127.0.0.1:4420');
    expect(output).toContain('Dry run complete. No files were changed.');
    expect(io.calls).toEqual([]);
    expect(await exists(path.join(homeDirectory, '.config', 'systemd', 'user', 'extalia-bridge.service'))).toBe(false);
  });

  it('asks for confirmation without --yes and aborts cleanly when declined', async () => {
    const prompts: string[] = [];
    const io = makeHost({
      prompt: async question => {
        prompts.push(question);
        return false;
      },
    });

    const code = await run(['service', 'install'], io.value);
    expect(code).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(io.err.join('\n')).toContain('Cancelled');
    expect(io.calls).toEqual([]);
    expect(await exists(path.join(homeDirectory, '.config', 'systemd', 'user', 'extalia-bridge.service'))).toBe(false);
  });

  it('installs with --yes, reports status --json, starts/stops, and uninstalls cleanly', async () => {
    const io = makeHost();
    expect(await run(['service', 'install', '--yes', '--port', '4455'], io.value)).toBe(0);
    const unitPath = path.join(homeDirectory, '.config', 'systemd', 'user', 'extalia-bridge.service');
    expect(await exists(unitPath)).toBe(true);

    // Status --json
    const statusJsonIo = makeHost();
    expect(await run(['service', 'status', '--json'], statusJsonIo.value)).toBe(0);
    const parsedStatus = JSON.parse(statusJsonIo.out.join('\n')) as {
      installed: boolean;
      port: number;
      host: string;
      osService: { state: string };
      lock: { state: string };
    };
    expect(parsedStatus.installed).toBe(true);
    expect(parsedStatus.port).toBe(4455);
    expect(parsedStatus.host).toBe('127.0.0.1');
    expect(parsedStatus.osService.state).toBe('running');
    expect(parsedStatus.lock.state).toBe('none');

    // Start refuses when a live host holds state/host.lock
    const lockFile = path.join(extaliaHome, 'state', 'host.lock');
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 99999, kind: 'bridge', startedAt: '2026-11-24T11:55:00.000Z' }),
      'utf8',
    );
    const blockedStartIo = makeHost({ serviceIsProcessAlive: pid => pid === 99999 });
    expect(await run(['service', 'start'], blockedStartIo.value)).toBe(1);
    expect(blockedStartIo.err.join('\n')).toContain('already running');

    // Start succeeds when lock is stale, and stop succeeds
    const startIo = makeHost({ serviceIsProcessAlive: () => false });
    expect(await run(['service', 'start'], startIo.value)).toBe(0);
    expect(startIo.out.join('\n')).toContain('Started extalia-bridge.service');

    const stopIo = makeHost();
    expect(await run(['service', 'stop'], stopIo.value)).toBe(0);
    expect(stopIo.out.join('\n')).toContain('Stopped extalia-bridge.service');

    // Uninstall --dry-run keeps unit
    const dryUninstallIo = makeHost();
    expect(await run(['service', 'uninstall', '--dry-run'], dryUninstallIo.value)).toBe(0);
    expect(dryUninstallIo.out.join('\n')).toContain('Dry run complete');
    expect(await exists(unitPath)).toBe(true);

    // Uninstall --yes removes unit
    const uninstallIo = makeHost();
    expect(await run(['service', 'uninstall', '--yes'], uninstallIo.value)).toBe(0);
    expect(uninstallIo.out.join('\n')).toContain('Uninstalled extalia-bridge.service');
    expect(await exists(unitPath)).toBe(false);
  });
});
