import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostLockedError } from '../src/lock.js';
import {
  applyServiceInstall,
  applyServiceUninstall,
  DEFAULT_SERVICE_PORT,
  inspectServiceStatus,
  LAUNCHD_SERVICE_LABEL,
  planServiceInstall,
  planServiceUninstall,
  SERVICE_UNDO_COMMAND,
  ServiceManagerError,
  startManagedService,
  stopManagedService,
  SYSTEMD_SERVICE_NAME,
  WINDOWS_TASK_NAME,
  type ServiceRunCommand,
} from '../src/serviceManager.js';

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('Headless OS Service Manager', () => {
  let root: string;
  let homeDirectory: string;
  let dataDirectory: string;
  const fixedNow = () => new Date('2026-11-24T12:00:00.000Z');

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-service-mgr-'));
    homeDirectory = path.join(root, 'home');
    dataDirectory = path.join(root, 'extalia-home');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('plans macOS launchd install with zero writes, sleep/keychain warnings, and loopback-only args', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand: ServiceRunCommand = async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    };

    const plan = await planServiceInstall({
      platform: 'darwin',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/local/bin/node',
      entryPath: '/usr/local/lib/extalia/extalia.mjs',
      uid: 501,
      now: fixedNow,
      runCommand,
    });

    expect(plan.supported).toBe(true);
    expect(plan.manager).toBe('launchd');
    expect(plan.serviceId).toBe(LAUNCHD_SERVICE_LABEL);
    expect(plan.targetPath).toBe(path.join(homeDirectory, 'Library', 'LaunchAgents', `${LAUNCHD_SERVICE_LABEL}.plist`));
    expect(plan.host).toBe('127.0.0.1');
    expect(plan.port).toBe(DEFAULT_SERVICE_PORT);
    expect(plan.undoCommand).toBe(SERVICE_UNDO_COMMAND);
    expect(plan.backupPath).toBe(path.join(dataDirectory, 'service', 'backups', '2026-11-24T12-00-00-000Z', `${LAUNCHD_SERVICE_LABEL}.plist`));
    expect(plan.content).toContain('<string>io.extalia.bridge</string>');
    expect(plan.content).toContain('<key>EXTALIA_HOME</key>');
    expect(plan.content).toContain(`<string>${dataDirectory}</string>`);
    expect(plan.content).toContain('<string>--no-open</string>');
    expect(plan.content).toContain('<string>--no-update-check</string>');
    expect(plan.content).toContain('<string>127.0.0.1</string>');
    expect(plan.content).not.toContain('0.0.0.0');
    expect(plan.diff).toContain('+++ ');
    expect(plan.activationCommands).toEqual([
      {
        command: 'launchctl',
        args: ['bootstrap', 'gui/501', plan.targetPath],
        display: expect.stringContaining('launchctl bootstrap gui/501'),
      },
    ]);
    expect(plan.warnings.some(w => /sleep/i.test(w))).toBe(true);
    expect(plan.warnings.some(w => /keychain|keyring/i.test(w))).toBe(true);

    // Dry-run guarantee: no files written and no OS commands invoked.
    expect(calls).toEqual([]);
    expect(await exists(plan.targetPath)).toBe(false);
    expect(await exists(plan.manifestPath)).toBe(false);
    expect(await exists(path.join(dataDirectory, 'service'))).toBe(false);
  });

  it('installs, backs up on reinstall, and uninstalls macOS launchd service while preserving user data', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand: ServiceRunCommand = async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    };

    // Seed user workspace/schedule data and an unrelated LaunchAgent to verify neither is touched.
    const userScheduleFile = path.join(dataDirectory, 'config', 'schedules.json');
    await mkdir(path.dirname(userScheduleFile), { recursive: true });
    await writeFile(userScheduleFile, '{"jobs":[{"id":"sch_1"}]}\n', 'utf8');
    const unrelatedPlist = path.join(homeDirectory, 'Library', 'LaunchAgents', 'com.example.unrelated.plist');
    await mkdir(path.dirname(unrelatedPlist), { recursive: true });
    await writeFile(unrelatedPlist, '<plist>unrelated</plist>\n', 'utf8');

    const firstInstall = await applyServiceInstall({
      platform: 'darwin',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/local/bin/node',
      entryPath: '/usr/local/lib/extalia/extalia.mjs',
      port: 4310,
      uid: 501,
      now: fixedNow,
      runCommand,
    });

    expect(firstInstall.activated).toBe(true);
    expect(firstInstall.backupPath).toBeUndefined();
    expect(await exists(firstInstall.targetPath)).toBe(true);
    expect(await exists(firstInstall.manifestPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(firstInstall.manifestPath)).mode & 0o777).toBe(0o600);
    }

    // Reinstall on a new port: previous Extalia-managed plist must be backed up.
    const secondInstall = await applyServiceInstall({
      platform: 'darwin',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/local/bin/node',
      entryPath: '/usr/local/lib/extalia/extalia.mjs',
      port: 4411,
      uid: 501,
      now: () => new Date('2026-11-24T13:00:00.000Z'),
      runCommand,
    });

    expect(secondInstall.backupPath).toBeDefined();
    expect(await exists(secondInstall.backupPath!)).toBe(true);
    expect(await readFile(secondInstall.backupPath!, 'utf8')).toContain('<string>4310</string>');
    expect(await readFile(secondInstall.targetPath, 'utf8')).toContain('<string>4411</string>');

    // Uninstall removes only Extalia-managed unit + manifest, leaving user data, backups, and unrelated plist intact.
    const uninstallPlan = await planServiceUninstall({
      platform: 'darwin',
      homeDirectory,
      dataDirectory,
      uid: 501,
    });
    expect(uninstallPlan.hasManagedService).toBe(true);
    expect(uninstallPlan.diff).toContain('--- ');
    expect(uninstallPlan.deactivationCommands[0]?.command).toBe('launchctl');

    const uninstallResult = await applyServiceUninstall({
      platform: 'darwin',
      homeDirectory,
      dataDirectory,
      uid: 501,
      runCommand,
    });
    expect(uninstallResult.removedUnit).toBe(true);
    expect(uninstallResult.removedManifest).toBe(true);
    expect(await exists(secondInstall.targetPath)).toBe(false);
    expect(await exists(secondInstall.manifestPath)).toBe(false);
    expect(await readFile(userScheduleFile, 'utf8')).toBe('{"jobs":[{"id":"sch_1"}]}\n');
    expect(await readFile(unrelatedPlist, 'utf8')).toBe('<plist>unrelated</plist>\n');
    expect(await exists(secondInstall.backupPath!)).toBe(true);
    expect(calls.map(c => `${c.command} ${c.args[0]}`)).toEqual([
      'launchctl bootstrap',
      'launchctl bootstrap',
      'launchctl bootout',
    ]);
  });

  it('generates, installs, inspects, and uninstalls Linux systemd --user service with Restart=on-failure', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand: ServiceRunCommand = async (command, args) => {
      calls.push({ command, args });
      if (args.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    };

    const installed = await applyServiceInstall({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/bin/node',
      entryPath: '/opt/extalia/extalia.mjs',
      port: 4321,
      now: fixedNow,
      runCommand,
    });

    expect(installed.targetPath).toBe(path.join(homeDirectory, '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME));
    const unit = await readFile(installed.targetPath, 'utf8');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain(`EXTALIA_HOME=${dataDirectory}`);
    expect(unit).toContain('--no-open');
    expect(unit).toContain('--no-update-check');
    expect(unit).toContain('127.0.0.1');
    expect(unit).toContain('4321');
    expect(unit).not.toContain('0.0.0.0');
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME] },
    ]);

    const status = await inspectServiceStatus({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      runCommand,
    });
    expect(status.installed).toBe(true);
    expect(status.manager).toBe('systemd-user');
    expect(status.port).toBe(4321);
    expect(status.osService.state).toBe('running');
    expect(status.lock.state).toBe('none');

    const uninstalled = await applyServiceUninstall({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      runCommand,
    });
    expect(uninstalled.removedUnit).toBe(true);
    expect(await exists(installed.targetPath)).toBe(false);
  });

  it('generates and installs Windows Task Scheduler XML + schtasks plan', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand: ServiceRunCommand = async (command, args) => {
      calls.push({ command, args });
      if (args.includes('/Query')) return { code: 0, stdout: 'Status: Ready\n', stderr: '' };
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    };

    const installed = await applyServiceInstall({
      platform: 'win32',
      homeDirectory,
      dataDirectory,
      executablePath: path.join(root, 'node.exe'),
      entryPath: path.join(root, 'extalia.mjs'),
      port: 4310,
      now: fixedNow,
      runCommand,
    });

    expect(installed.targetPath).toBe(path.join(dataDirectory, 'service', 'extalia-bridge.task.xml'));
    const xml = await readFile(installed.targetPath, 'utf8');
    expect(xml).toContain('EXTALIA_HOME=');
    expect(xml).toContain('--no-open');
    expect(xml).toContain('--no-update-check');
    expect(xml).toContain('127.0.0.1');
    expect(xml).not.toContain('0.0.0.0');
    expect(calls).toEqual([
      { command: 'schtasks', args: ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', installed.targetPath, '/F'] },
    ]);

    const status = await inspectServiceStatus({
      platform: 'win32',
      homeDirectory,
      dataDirectory,
      runCommand,
    });
    expect(status.manager).toBe('windows-task-scheduler');
    expect(status.osService.state).toBe('stopped');
  });

  it('refuses to start a second owner when state/host.lock is held by a live host (SCH-AT-20)', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand: ServiceRunCommand = async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: '', stderr: '' };
    };

    await applyServiceInstall({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/bin/node',
      activate: false,
      now: fixedNow,
    });

    const lockFile = path.join(dataDirectory, 'state', 'host.lock');
    await mkdir(path.dirname(lockFile), { recursive: true });
    await writeFile(
      lockFile,
      JSON.stringify({ pid: 42424, kind: 'desktop', startedAt: '2026-11-24T11:55:00.000Z' }),
      'utf8',
    );

    const status = await inspectServiceStatus({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      isProcessAlive: pid => pid === 42424,
      now: fixedNow,
      uptimeSeconds: () => 3600,
      runCommand,
    });
    expect(status.lock.state).toBe('live');
    expect(status.lock.ownerPid).toBe(42424);
    expect(status.lock.ownerKind).toBe('desktop');
    expect(status.lock.conflict).toBe(true);

    // Live lock must refuse start without invoking OS service manager.
    calls.length = 0;
    await expect(startManagedService({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      isProcessAlive: pid => pid === 42424,
      now: fixedNow,
      uptimeSeconds: () => 3600,
      runCommand,
    })).rejects.toThrow(HostLockedError);
    expect(calls).toEqual([]);

    // Stale lock (dead PID) permits clean start and stop.
    const started = await startManagedService({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      isProcessAlive: () => false,
      now: fixedNow,
      uptimeSeconds: () => 3600,
      runCommand,
    });
    expect(started.action).toBe('start');
    const stopped = await stopManagedService({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      runCommand,
    });
    expect(stopped.action).toBe('stop');
    expect(calls).toEqual([
      { command: 'systemctl', args: ['--user', 'start', SYSTEMD_SERVICE_NAME] },
      { command: 'systemctl', args: ['--user', 'stop', SYSTEMD_SERVICE_NAME] },
    ]);
  });

  it('refuses to overwrite or delete unrelated service files and rejects non-loopback hosts', async () => {
    const targetPath = path.join(homeDirectory, '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, '[Unit]\nDescription=Custom user unit\n', 'utf8');

    const installPlan = await planServiceInstall({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/bin/node',
    });
    expect(installPlan.refusedUnmanaged).toBe(true);

    await expect(applyServiceInstall({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/bin/node',
    })).rejects.toThrow(ServiceManagerError);
    expect(await readFile(targetPath, 'utf8')).toBe('[Unit]\nDescription=Custom user unit\n');

    await expect(applyServiceUninstall({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
    })).rejects.toThrow(ServiceManagerError);
    expect(await readFile(targetPath, 'utf8')).toBe('[Unit]\nDescription=Custom user unit\n');

    await expect(planServiceInstall({
      platform: 'linux',
      homeDirectory,
      dataDirectory,
      executablePath: '/usr/bin/node',
      host: '0.0.0.0',
    })).rejects.toThrow(/loopback-only/i);
  });
});
