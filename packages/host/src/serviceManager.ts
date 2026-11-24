import { spawn } from 'node:child_process';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { uptime } from 'node:os';
import path from 'node:path';
import { unifiedDiff } from './connect/diff.js';
import { readTextIfExists, sha256, timestampForPath } from './connect/util.js';
import { errorCode, isNotFound, readJson, writeFileAtomic, writeJsonAtomic } from './jsonStore.js';
import { HostLockedError, type HostKind } from './lock.js';
import { dataLayout, ensurePrivateDirectory, PRIVATE_FILE_MODE } from './paths.js';

export const DEFAULT_SERVICE_PORT = 4310;
export const SERVICE_LOOPBACK_HOST = '127.0.0.1' as const;
export const SERVICE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const SERVICE_UNDO_COMMAND = 'extalia service uninstall' as const;

export const LAUNCHD_SERVICE_LABEL = 'io.extalia.bridge' as const;
export const SYSTEMD_SERVICE_NAME = 'extalia-bridge.service' as const;
export const WINDOWS_TASK_NAME = 'ExtaliaBridge' as const;

const LAUNCHD_MARKER = `<!-- Managed by Extalia (${LAUNCHD_SERVICE_LABEL}) -->`;
const SYSTEMD_MARKER = `# Managed by Extalia (${SYSTEMD_SERVICE_NAME})`;
const WINDOWS_MARKER = `<!-- Managed by Extalia (${WINDOWS_TASK_NAME}) -->`;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const RESTART_TOLERANCE_MS = 5 * 60_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const UNIT_FILE_MODE = 0o644;

export type ServicePlatform = 'darwin' | 'linux' | 'win32';
export type ServiceManagerKind = 'launchd' | 'systemd-user' | 'windows-task-scheduler' | 'unsupported';
export type ServiceErrorCode = 'UNSUPPORTED_PLATFORM' | 'INVALID_OPTION' | 'UNMANAGED_TARGET' | 'NOT_INSTALLED' | 'COMMAND_FAILED';

export class ServiceManagerError extends Error {
  override name = 'ServiceManagerError';
  constructor(readonly code: ServiceErrorCode, message: string) {
    super(message);
  }
}

export interface ServiceRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ServiceRunCommand = (
  command: string,
  args: string[],
  options?: { env?: Readonly<Record<string, string | undefined>>; timeoutMs?: number },
) => Promise<ServiceRunResult>;

export interface ServiceCommandSpec {
  command: string;
  args: string[];
  display: string;
}

export interface ServiceCommandExecution {
  spec: ServiceCommandSpec;
  result: ServiceRunResult;
}

export type ServiceLockState = 'none' | 'live' | 'stale' | 'unreadable';

export interface ServiceLockStatus {
  lockFile: string;
  state: ServiceLockState;
  ownerPid?: number;
  ownerKind?: HostKind;
  startedAt?: string;
  conflict: boolean;
}

export interface ServiceManifestV1 {
  schemaVersion: typeof SERVICE_MANIFEST_SCHEMA_VERSION;
  serviceId: string;
  manager: Exclude<ServiceManagerKind, 'unsupported'>;
  platform: ServicePlatform;
  targetPath: string;
  dataDirectory: string;
  host: typeof SERVICE_LOOPBACK_HOST;
  port: number;
  executablePath: string;
  entryPath?: string;
  commandArgs: string[];
  installedAt: string;
  updatedAt: string;
  writtenSha256: string;
  originalExisted: boolean;
  backupPath?: string;
  undoCommand: string;
}

export interface ServiceTargetInfo {
  supported: boolean;
  platform: string;
  manager: ServiceManagerKind;
  serviceId: string;
  targetPath: string;
  serviceDir: string;
  manifestPath: string;
  logsDir: string;
  backupsDir: string;
  fileMode: number;
}

export interface ServiceManagerBaseOptions {
  platform?: string;
  homeDirectory: string;
  dataDirectory: string;
  uid?: number;
  now?: () => Date;
  runCommand?: ServiceRunCommand;
  isProcessAlive?: (pid: number) => boolean;
  uptimeSeconds?: () => number;
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ServiceInstallOptions extends ServiceManagerBaseOptions {
  executablePath: string;
  entryPath?: string;
  port?: number;
  host?: string;
  activate?: boolean;
}

export interface ServiceUninstallOptions extends ServiceManagerBaseOptions {
  deactivate?: boolean;
}

export interface ServiceStatusOptions extends ServiceManagerBaseOptions {
  port?: number;
}

export interface ServiceControlOptions extends ServiceManagerBaseOptions {
  port?: number;
}

export interface ServiceInstallPlan {
  supported: boolean;
  platform: string;
  manager: ServiceManagerKind;
  serviceId: string;
  targetPath: string;
  manifestPath: string;
  backupDir: string;
  backupPath: string;
  dataDirectory: string;
  host: typeof SERVICE_LOOPBACK_HOST;
  port: number;
  executablePath: string;
  entryPath?: string;
  commandArgs: string[];
  content: string;
  diff: string;
  changes: boolean;
  existingManaged: boolean;
  refusedUnmanaged: boolean;
  activationCommands: ServiceCommandSpec[];
  undoCommand: string;
  warnings: string[];
}

export interface ServiceInstallResult {
  plan: ServiceInstallPlan;
  targetPath: string;
  manifestPath: string;
  backupPath?: string;
  activated: boolean;
  commandResults: ServiceCommandExecution[];
  undoCommand: string;
  warnings: string[];
}

export interface ServiceUninstallPlan {
  supported: boolean;
  platform: string;
  manager: ServiceManagerKind;
  serviceId: string;
  targetPath: string;
  manifestPath: string;
  hasManagedService: boolean;
  unitExists: boolean;
  unitManaged: boolean;
  manifestExists: boolean;
  refusedUnmanaged: boolean;
  diff: string;
  deactivationCommands: ServiceCommandSpec[];
  preservedDataNote: string;
  warnings: string[];
}

export interface ServiceUninstallResult {
  plan: ServiceUninstallPlan;
  removedUnit: boolean;
  removedManifest: boolean;
  deactivated: boolean;
  commandResults: ServiceCommandExecution[];
  preservedDataNote: string;
  warnings: string[];
}

export type OsServiceState = 'running' | 'stopped' | 'not-installed' | 'unknown' | 'unsupported';

export interface ServiceStatusReport {
  supported: boolean;
  platform: string;
  manager: ServiceManagerKind;
  serviceId: string;
  installed: boolean;
  unitExists: boolean;
  unitManaged: boolean;
  manifestExists: boolean;
  targetPath: string;
  manifestPath: string;
  dataDirectory: string;
  host: typeof SERVICE_LOOPBACK_HOST;
  port: number;
  lock: ServiceLockStatus;
  osService: {
    state: OsServiceState;
    detail?: string;
  };
  warnings: string[];
}

export interface ServiceControlResult {
  action: 'start' | 'stop';
  serviceId: string;
  manager: Exclude<ServiceManagerKind, 'unsupported'>;
  commandResults: ServiceCommandExecution[];
}

interface LockInfo {
  pid: number;
  kind: HostKind;
  startedAt: string;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

function parseLockInfo(text: string): LockInfo | undefined {
  try {
    const value = JSON.parse(text) as Partial<LockInfo>;
    if (
      Number.isInteger(value.pid)
      && (value.pid as number) > 0
      && (value.kind === 'desktop' || value.kind === 'bridge')
      && typeof value.startedAt === 'string'
    ) {
      return value as LockInfo;
    }
  } catch {
    // Unreadable lock is reported explicitly.
  }
  return undefined;
}

/**
 * Inspect `state/host.lock` without modifying it. Reports whether a live host
 * currently owns the data directory so a second host/service is never started.
 */
export async function inspectHostLock(
  stateDirectory: string,
  options?: {
    isProcessAlive?: (pid: number) => boolean;
    now?: () => Date;
    uptimeSeconds?: () => number;
  },
): Promise<ServiceLockStatus> {
  const lockFile = path.join(stateDirectory, 'host.lock');
  const raw = await readTextIfExists(lockFile);
  if (raw === undefined) {
    return { lockFile, state: 'none', conflict: false };
  }
  const info = parseLockInfo(raw);
  if (!info) {
    return { lockFile, state: 'unreadable', conflict: false };
  }
  const aliveCheck = options?.isProcessAlive ?? defaultIsProcessAlive;
  const nowMs = (options?.now ?? (() => new Date()))().getTime();
  const hostUptimeSeconds = (options?.uptimeSeconds ?? uptime)();
  const startedMs = Date.parse(info.startedAt);
  const predatesBoot = Number.isFinite(startedMs) && startedMs < nowMs - hostUptimeSeconds * 1000 - RESTART_TOLERANCE_MS;
  const live = aliveCheck(info.pid) && !predatesBoot;
  return {
    lockFile,
    state: live ? 'live' : 'stale',
    ownerPid: info.pid,
    ownerKind: info.kind,
    startedAt: info.startedAt,
    conflict: live,
  };
}

function assertSafePath(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\0\r\n]/.test(trimmed)) {
    throw new ServiceManagerError('INVALID_OPTION', `${label} must be a valid non-empty path without line breaks.`);
  }
  return path.resolve(trimmed);
}

function validatePort(port: number | undefined): number {
  const resolved = port ?? DEFAULT_SERVICE_PORT;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > 65535) {
    throw new ServiceManagerError('INVALID_OPTION', `Port must be an integer between 1 and 65535 (got "${String(resolved)}").`);
  }
  return resolved;
}

function validateLoopbackHost(host: string | undefined): typeof SERVICE_LOOPBACK_HOST {
  if (host === undefined) return SERVICE_LOOPBACK_HOST;
  const normalized = host.trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(normalized)) {
    throw new ServiceManagerError(
      'INVALID_OPTION',
      `Service host must remain loopback-only (127.0.0.1 or localhost); refusing "${host}".`,
    );
  }
  return SERVICE_LOOPBACK_HOST;
}

function isSupportedPlatform(platform: string): platform is ServicePlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

function resolveUid(uid: number | undefined): number {
  if (uid !== undefined) {
    if (!Number.isInteger(uid) || uid < 0) {
      throw new ServiceManagerError('INVALID_OPTION', `uid must be a non-negative integer (got "${String(uid)}").`);
    }
    return uid;
  }
  return typeof process.getuid === 'function' ? process.getuid() : 501;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeSystemdArg(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$');
  return `"${escaped}"`;
}

function quoteDisplayArg(value: string): string {
  return /[\s"'`]/.test(value) ? JSON.stringify(value) : value;
}

function formatCommandSpec(command: string, args: string[]): ServiceCommandSpec {
  return {
    command,
    args,
    display: [command, ...args.map(quoteDisplayArg)].join(' '),
  };
}

function buildBridgeCommandArgs(executablePath: string, entryPath: string | undefined, port: number): string[] {
  const args = [executablePath];
  if (entryPath) args.push(entryPath);
  args.push('start', '--no-open', '--no-update-check', '--host', SERVICE_LOOPBACK_HOST, '--port', String(port));
  return args;
}

function hasExtaliaManagedMarker(platform: ServicePlatform, content: string): boolean {
  if (platform === 'darwin') return content.includes(LAUNCHD_MARKER);
  if (platform === 'linux') return content.includes(SYSTEMD_MARKER);
  return content.includes(WINDOWS_MARKER);
}

/** Resolve target unit/task paths and metadata for the requested platform. */
export function resolveServiceTarget(options: Pick<ServiceManagerBaseOptions, 'platform' | 'homeDirectory' | 'dataDirectory'>): ServiceTargetInfo {
  const platform = options.platform ?? process.platform;
  const homeDirectory = assertSafePath(options.homeDirectory, 'homeDirectory');
  const dataDirectory = assertSafePath(options.dataDirectory, 'dataDirectory');
  const serviceDir = path.join(dataDirectory, 'service');
  const manifestPath = path.join(serviceDir, 'manifest.json');
  const logsDir = path.join(serviceDir, 'logs');
  const backupsDir = path.join(serviceDir, 'backups');

  if (platform === 'darwin') {
    return {
      supported: true,
      platform,
      manager: 'launchd',
      serviceId: LAUNCHD_SERVICE_LABEL,
      targetPath: path.join(homeDirectory, 'Library', 'LaunchAgents', `${LAUNCHD_SERVICE_LABEL}.plist`),
      serviceDir,
      manifestPath,
      logsDir,
      backupsDir,
      fileMode: UNIT_FILE_MODE,
    };
  }
  if (platform === 'linux') {
    return {
      supported: true,
      platform,
      manager: 'systemd-user',
      serviceId: SYSTEMD_SERVICE_NAME,
      targetPath: path.join(homeDirectory, '.config', 'systemd', 'user', SYSTEMD_SERVICE_NAME),
      serviceDir,
      manifestPath,
      logsDir,
      backupsDir,
      fileMode: UNIT_FILE_MODE,
    };
  }
  if (platform === 'win32') {
    return {
      supported: true,
      platform,
      manager: 'windows-task-scheduler',
      serviceId: WINDOWS_TASK_NAME,
      targetPath: path.join(serviceDir, 'extalia-bridge.task.xml'),
      serviceDir,
      manifestPath,
      logsDir,
      backupsDir,
      fileMode: PRIVATE_FILE_MODE,
    };
  }
  return {
    supported: false,
    platform,
    manager: 'unsupported',
    serviceId: '',
    targetPath: '',
    serviceDir,
    manifestPath,
    logsDir,
    backupsDir,
    fileMode: PRIVATE_FILE_MODE,
  };
}

function renderLaunchdPlist(options: {
  dataDirectory: string;
  logsDir: string;
  commandArgs: string[];
}): string {
  const programArguments = options.commandArgs
    .map(arg => `    <string>${escapeXml(arg)}</string>`)
    .join('\n');
  const stdoutLog = path.join(options.logsDir, 'bridge.stdout.log');
  const stderrLog = path.join(options.logsDir, 'bridge.stderr.log');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    LAUNCHD_MARKER,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_SERVICE_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    programArguments,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>EXTALIA_HOME</key>',
    `    <string>${escapeXml(options.dataDirectory)}</string>`,
    '    <key>EXTALIA_NO_UPDATE_CHECK</key>',
    '    <string>1</string>',
    '  </dict>',
    '  <key>WorkingDirectory</key>',
    `  <string>${escapeXml(options.dataDirectory)}</string>`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(stdoutLog)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(stderrLog)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function renderSystemdUnit(options: {
  dataDirectory: string;
  commandArgs: string[];
}): string {
  const execStart = options.commandArgs.map(escapeSystemdArg).join(' ');
  return [
    SYSTEMD_MARKER,
    '[Unit]',
    'Description=Extalia Local Bridge Host',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${escapeSystemdArg(options.dataDirectory)}`,
    `Environment=${escapeSystemdArg(`EXTALIA_HOME=${options.dataDirectory}`)}`,
    'Environment="EXTALIA_NO_UPDATE_CHECK=1"',
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function quoteWindowsCmdArg(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function renderWindowsTaskXml(options: {
  dataDirectory: string;
  port: number;
  commandArgs: string[];
}): string {
  const commandLine = options.commandArgs.map(quoteWindowsCmdArg).join(' ');
  const cmdArgs = `/d /s /c "set "EXTALIA_HOME=${options.dataDirectory.replace(/"/g, '')}" && set "EXTALIA_NO_UPDATE_CHECK=1" && ${commandLine}"`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    WINDOWS_MARKER,
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>Extalia Local Bridge Host (EXTALIA_HOME=${escapeXml(options.dataDirectory)}; loopback ${SERVICE_LOOPBACK_HOST}:${options.port})</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '    <Enabled>true</Enabled>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>cmd.exe</Command>',
    `      <Arguments>${escapeXml(cmdArgs)}</Arguments>`,
    `      <WorkingDirectory>${escapeXml(options.dataDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\n');
}

function activationCommandsFor(target: ServiceTargetInfo, uid: number): ServiceCommandSpec[] {
  if (target.platform === 'darwin') {
    return [
      formatCommandSpec('launchctl', ['bootstrap', `gui/${uid}`, target.targetPath]),
    ];
  }
  if (target.platform === 'linux') {
    return [
      formatCommandSpec('systemctl', ['--user', 'daemon-reload']),
      formatCommandSpec('systemctl', ['--user', 'enable', '--now', SYSTEMD_SERVICE_NAME]),
    ];
  }
  if (target.platform === 'win32') {
    return [
      formatCommandSpec('schtasks', ['/Create', '/TN', WINDOWS_TASK_NAME, '/XML', target.targetPath, '/F']),
    ];
  }
  return [];
}

function deactivationCommandsFor(target: ServiceTargetInfo, uid: number): ServiceCommandSpec[] {
  if (target.platform === 'darwin') {
    return [
      formatCommandSpec('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`]),
    ];
  }
  if (target.platform === 'linux') {
    return [
      formatCommandSpec('systemctl', ['--user', 'disable', '--now', SYSTEMD_SERVICE_NAME]),
      formatCommandSpec('systemctl', ['--user', 'daemon-reload']),
    ];
  }
  if (target.platform === 'win32') {
    return [
      formatCommandSpec('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME]),
      formatCommandSpec('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']),
    ];
  }
  return [];
}

function startCommandFor(target: ServiceTargetInfo, uid: number): ServiceCommandSpec {
  if (target.platform === 'darwin') {
    return formatCommandSpec('launchctl', ['kickstart', '-k', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`]);
  }
  if (target.platform === 'linux') {
    return formatCommandSpec('systemctl', ['--user', 'start', SYSTEMD_SERVICE_NAME]);
  }
  return formatCommandSpec('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME]);
}

function stopCommandFor(target: ServiceTargetInfo, uid: number): ServiceCommandSpec {
  if (target.platform === 'darwin') {
    return formatCommandSpec('launchctl', ['kill', 'SIGTERM', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`]);
  }
  if (target.platform === 'linux') {
    return formatCommandSpec('systemctl', ['--user', 'stop', SYSTEMD_SERVICE_NAME]);
  }
  return formatCommandSpec('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME]);
}

function statusProbeCommandFor(target: ServiceTargetInfo, uid: number): ServiceCommandSpec {
  if (target.platform === 'darwin') {
    return formatCommandSpec('launchctl', ['print', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`]);
  }
  if (target.platform === 'linux') {
    return formatCommandSpec('systemctl', ['--user', 'is-active', SYSTEMD_SERVICE_NAME]);
  }
  return formatCommandSpec('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST']);
}

function platformWarnings(platform: string): string[] {
  const warnings = [
    'OS sleep or hibernation pauses scheduled runs; Extalia does not wake a sleeping computer.',
    'Headless runs depend on user keychain/keyring credential availability in your OS session.',
  ];
  if (platform === 'linux') {
    warnings.push('For background runs after logout on Linux, systemd user lingering (`loginctl enable-linger`) may be required.');
  } else if (platform === 'win32') {
    warnings.push('Windows Task Scheduler runs under your interactive logon session; verify credential store access after logon.');
  }
  return warnings;
}

/** Default safe command runner using `spawn` with `shell: false`. */
export const defaultServiceRunCommand: ServiceRunCommand = (command, args, options) =>
  new Promise<ServiceRunResult>((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options?.env ? { ...process.env, ...options.env } : process.env,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const timeoutMs = options?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, timeoutMs);
    timer.unref();
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });

/** Pure helper that renders the OS service definition text for a supported platform. */
export function buildServiceDefinition(options: {
  platform: ServicePlatform;
  dataDirectory: string;
  logsDir: string;
  executablePath: string;
  entryPath?: string;
  port: number;
}): { commandArgs: string[]; content: string } {
  const commandArgs = buildBridgeCommandArgs(options.executablePath, options.entryPath, options.port);
  if (options.platform === 'darwin') {
    return {
      commandArgs,
      content: renderLaunchdPlist({ dataDirectory: options.dataDirectory, logsDir: options.logsDir, commandArgs }),
    };
  }
  if (options.platform === 'linux') {
    return {
      commandArgs,
      content: renderSystemdUnit({ dataDirectory: options.dataDirectory, commandArgs }),
    };
  }
  return {
    commandArgs,
    content: renderWindowsTaskXml({ dataDirectory: options.dataDirectory, port: options.port, commandArgs }),
  };
}

/**
 * Pure read-only planner for installing the headless Extalia Bridge OS service.
 * Never writes files or invokes OS service manager commands.
 */
export async function planServiceInstall(options: ServiceInstallOptions): Promise<ServiceInstallPlan> {
  const target = resolveServiceTarget(options);
  const dataDirectory = assertSafePath(options.dataDirectory, 'dataDirectory');
  const executablePath = assertSafePath(options.executablePath, 'executablePath');
  const entryPath = options.entryPath ? assertSafePath(options.entryPath, 'entryPath') : undefined;
  const port = validatePort(options.port);
  const host = validateLoopbackHost(options.host);
  const now = (options.now ?? (() => new Date()))();
  const stamp = timestampForPath(now);
  const backupDir = path.join(target.backupsDir, stamp);
  const backupPath = target.targetPath ? path.join(backupDir, path.basename(target.targetPath)) : '';

  if (!target.supported || !isSupportedPlatform(target.platform)) {
    return {
      supported: false,
      platform: target.platform,
      manager: 'unsupported',
      serviceId: '',
      targetPath: '',
      manifestPath: target.manifestPath,
      backupDir,
      backupPath: '',
      dataDirectory,
      host,
      port,
      executablePath,
      ...(entryPath ? { entryPath } : {}),
      commandArgs: buildBridgeCommandArgs(executablePath, entryPath, port),
      content: '',
      diff: '',
      changes: false,
      existingManaged: false,
      refusedUnmanaged: false,
      activationCommands: [],
      undoCommand: SERVICE_UNDO_COMMAND,
      warnings: [`Headless OS service management is not supported on platform "${target.platform}".`],
    };
  }

  const uid = resolveUid(options.uid);
  const { commandArgs, content } = buildServiceDefinition({
    platform: target.platform,
    dataDirectory,
    logsDir: target.logsDir,
    executablePath,
    ...(entryPath ? { entryPath } : {}),
    port,
  });

  const existingContent = await readTextIfExists(target.targetPath);
  const existingManifest = await readManifest(target.manifestPath);
  const existingManaged = existingContent !== undefined && (
    hasExtaliaManagedMarker(target.platform, existingContent)
    || existingManifest?.targetPath === target.targetPath
  );
  const refusedUnmanaged = existingContent !== undefined && !existingManaged;

  const warnings = platformWarnings(target.platform);
  if (refusedUnmanaged) {
    warnings.unshift(`Existing file at ${target.targetPath} is not managed by Extalia; installation will refuse to overwrite it.`);
  }

  const diff = unifiedDiff(existingContent ?? '', content, {
    from: existingContent === undefined ? '/dev/null' : target.targetPath,
    to: target.targetPath,
  });

  return {
    supported: true,
    platform: target.platform,
    manager: target.manager,
    serviceId: target.serviceId,
    targetPath: target.targetPath,
    manifestPath: target.manifestPath,
    backupDir,
    backupPath,
    dataDirectory,
    host,
    port,
    executablePath,
    ...(entryPath ? { entryPath } : {}),
    commandArgs,
    content,
    diff,
    changes: existingContent !== content,
    existingManaged,
    refusedUnmanaged,
    activationCommands: activationCommandsFor(target, uid),
    undoCommand: SERVICE_UNDO_COMMAND,
    warnings,
  };
}

async function readManifest(manifestPath: string): Promise<ServiceManifestV1 | undefined> {
  const value = await readJson<Partial<ServiceManifestV1> | undefined>(manifestPath, undefined);
  if (!value || value.schemaVersion !== SERVICE_MANIFEST_SCHEMA_VERSION || typeof value.targetPath !== 'string') {
    return undefined;
  }
  return value as ServiceManifestV1;
}

/**
 * Apply the planned headless service installation: back up any existing managed
 * unit, atomically write the service definition and manifest, and optionally
 * activate it through the platform service manager.
 */
export async function applyServiceInstall(options: ServiceInstallOptions): Promise<ServiceInstallResult> {
  const plan = await planServiceInstall(options);
  if (!plan.supported || !isSupportedPlatform(plan.platform) || plan.manager === 'unsupported') {
    throw new ServiceManagerError('UNSUPPORTED_PLATFORM', plan.warnings[0] ?? `Unsupported platform: ${plan.platform}`);
  }
  if (plan.refusedUnmanaged) {
    throw new ServiceManagerError(
      'UNMANAGED_TARGET',
      `Refusing to overwrite unrelated service file at ${plan.targetPath}. Remove or rename it manually before installing Extalia's service.`,
    );
  }

  const target = resolveServiceTarget(options);
  await ensurePrivateDirectory(target.serviceDir);
  await ensurePrivateDirectory(target.logsDir);

  const existingContent = await readTextIfExists(plan.targetPath);
  const existingManifest = await readManifest(plan.manifestPath);
  let createdBackupPath: string | undefined;
  if (existingContent !== undefined) {
    await ensurePrivateDirectory(plan.backupDir);
    await writeFileAtomic(plan.backupPath, existingContent, { mode: PRIVATE_FILE_MODE });
    createdBackupPath = plan.backupPath;
  }

  await mkdir(path.dirname(plan.targetPath), { recursive: true });
  await writeFileAtomic(plan.targetPath, plan.content, { mode: target.fileMode });
  if (process.platform !== 'win32') {
    await chmod(plan.targetPath, target.fileMode);
  }

  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  const manifest: ServiceManifestV1 = {
    schemaVersion: SERVICE_MANIFEST_SCHEMA_VERSION,
    serviceId: plan.serviceId,
    manager: plan.manager,
    platform: plan.platform,
    targetPath: plan.targetPath,
    dataDirectory: plan.dataDirectory,
    host: SERVICE_LOOPBACK_HOST,
    port: plan.port,
    executablePath: plan.executablePath,
    ...(plan.entryPath ? { entryPath: plan.entryPath } : {}),
    commandArgs: plan.commandArgs,
    installedAt: existingManifest?.installedAt ?? nowIso,
    updatedAt: nowIso,
    writtenSha256: sha256(plan.content),
    originalExisted: existingManifest?.originalExisted ?? (existingContent !== undefined),
    ...(createdBackupPath ? { backupPath: createdBackupPath } : existingManifest?.backupPath ? { backupPath: existingManifest.backupPath } : {}),
    undoCommand: SERVICE_UNDO_COMMAND,
  };
  await writeJsonAtomic(plan.manifestPath, manifest, { mode: PRIVATE_FILE_MODE });

  const commandResults: ServiceCommandExecution[] = [];
  const shouldActivate = options.activate !== false;
  if (shouldActivate) {
    const runner = options.runCommand ?? defaultServiceRunCommand;
    for (const spec of plan.activationCommands) {
      const result = await runner(spec.command, spec.args, { env: options.env });
      commandResults.push({ spec, result });
      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        throw new ServiceManagerError(
          'COMMAND_FAILED',
          `Failed to activate service via "${spec.display}" (exit ${result.code ?? 'signal'})${detail ? `: ${detail}` : ''}`,
        );
      }
    }
  }

  return {
    plan,
    targetPath: plan.targetPath,
    manifestPath: plan.manifestPath,
    ...(createdBackupPath ? { backupPath: createdBackupPath } : {}),
    activated: shouldActivate,
    commandResults,
    undoCommand: SERVICE_UNDO_COMMAND,
    warnings: plan.warnings,
  };
}

/** Pure read-only planner for uninstalling the Extalia-managed OS service. */
export async function planServiceUninstall(options: ServiceUninstallOptions): Promise<ServiceUninstallPlan> {
  const target = resolveServiceTarget(options);
  const preservedDataNote = `User workspaces, sessions, schedules, and backups under ${assertSafePath(options.dataDirectory, 'dataDirectory')} will be preserved.`;
  if (!target.supported || !isSupportedPlatform(target.platform)) {
    return {
      supported: false,
      platform: target.platform,
      manager: 'unsupported',
      serviceId: '',
      targetPath: '',
      manifestPath: target.manifestPath,
      hasManagedService: false,
      unitExists: false,
      unitManaged: false,
      manifestExists: false,
      refusedUnmanaged: false,
      diff: '',
      deactivationCommands: [],
      preservedDataNote,
      warnings: [`Headless OS service management is not supported on platform "${target.platform}".`],
    };
  }

  const uid = resolveUid(options.uid);
  const existingContent = await readTextIfExists(target.targetPath);
  const existingManifest = await readManifest(target.manifestPath);
  const unitExists = existingContent !== undefined;
  const manifestExists = existingManifest !== undefined;
  const unitManaged = unitExists && (
    hasExtaliaManagedMarker(target.platform, existingContent)
    || existingManifest?.targetPath === target.targetPath
  );
  const refusedUnmanaged = unitExists && !unitManaged;
  const hasManagedService = unitManaged || manifestExists;
  const warnings: string[] = [];
  if (refusedUnmanaged) {
    warnings.push(`File at ${target.targetPath} is not managed by Extalia; uninstall will not modify or delete it.`);
  }

  const diff = unitManaged && existingContent !== undefined
    ? unifiedDiff(existingContent, '', { from: target.targetPath, to: '/dev/null' })
    : '';

  return {
    supported: true,
    platform: target.platform,
    manager: target.manager,
    serviceId: target.serviceId,
    targetPath: target.targetPath,
    manifestPath: target.manifestPath,
    hasManagedService,
    unitExists,
    unitManaged,
    manifestExists,
    refusedUnmanaged,
    diff,
    deactivationCommands: hasManagedService ? deactivationCommandsFor(target, uid) : [],
    preservedDataNote,
    warnings,
  };
}

/**
 * Remove ONLY Extalia-managed service definitions and manifest, preserving all
 * user workspaces, sessions, schedules, and backups.
 */
export async function applyServiceUninstall(options: ServiceUninstallOptions): Promise<ServiceUninstallResult> {
  const plan = await planServiceUninstall(options);
  if (!plan.supported || plan.manager === 'unsupported') {
    throw new ServiceManagerError('UNSUPPORTED_PLATFORM', plan.warnings[0] ?? `Unsupported platform: ${plan.platform}`);
  }
  if (plan.refusedUnmanaged) {
    throw new ServiceManagerError(
      'UNMANAGED_TARGET',
      `Refusing to remove unrelated service file at ${plan.targetPath}.`,
    );
  }

  const commandResults: ServiceCommandExecution[] = [];
  const shouldDeactivate = options.deactivate !== false && plan.hasManagedService;
  if (shouldDeactivate) {
    const runner = options.runCommand ?? defaultServiceRunCommand;
    for (const spec of plan.deactivationCommands) {
      const result = await runner(spec.command, spec.args, { env: options.env });
      commandResults.push({ spec, result });
    }
  }

  let removedUnit = false;
  if (plan.unitManaged) {
    try {
      await rm(plan.targetPath);
      removedUnit = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  let removedManifest = false;
  if (plan.manifestExists) {
    try {
      await rm(plan.manifestPath);
      removedManifest = true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  return {
    plan,
    removedUnit,
    removedManifest,
    deactivated: shouldDeactivate,
    commandResults,
    preservedDataNote: plan.preservedDataNote,
    warnings: plan.warnings,
  };
}

function interpretOsProbe(platform: ServicePlatform, result: ServiceRunResult): { state: OsServiceState; detail?: string } {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const combined = [stdout, stderr].filter(Boolean).join(' | ');
  if (platform === 'linux') {
    if (result.code === 0 && stdout === 'active') return { state: 'running', detail: stdout };
    if (['inactive', 'deactivating', 'failed'].includes(stdout)) return { state: 'stopped', detail: stdout };
    return { state: 'unknown', ...(combined ? { detail: combined } : {}) };
  }
  if (platform === 'darwin') {
    if (result.code === 0) {
      if (/\bstate\s*=\s*running\b/i.test(stdout) || /\bpid\s*=\s*\d+/i.test(stdout)) {
        return { state: 'running', detail: 'launchd reports running' };
      }
      return { state: 'stopped', detail: 'launchd loaded (not running)' };
    }
    return { state: 'stopped', ...(combined ? { detail: combined } : {}) };
  }
  // Windows Task Scheduler (`schtasks /Query /TN ExtaliaBridge /FO LIST`)
  if (result.code === 0) {
    if (/Status:\s*Running/i.test(stdout)) return { state: 'running', detail: 'Task Scheduler reports Running' };
    if (/Status:\s*(Ready|Disabled|Queued)/i.test(stdout)) return { state: 'stopped', detail: 'Task Scheduler registered (not running)' };
    return { state: 'unknown', ...(combined ? { detail: combined } : {}) };
  }
  return { state: 'stopped', ...(combined ? { detail: combined } : {}) };
}

/**
 * Inspect headless service installation state, single-owner `state/host.lock`
 * status, loopback port, `EXTALIA_HOME`, and live OS service manager status.
 */
export async function inspectServiceStatus(options: ServiceStatusOptions): Promise<ServiceStatusReport> {
  const target = resolveServiceTarget(options);
  const dataDirectory = assertSafePath(options.dataDirectory, 'dataDirectory');
  const layout = dataLayout(dataDirectory);
  const lock = await inspectHostLock(layout.state, {
    ...(options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.uptimeSeconds ? { uptimeSeconds: options.uptimeSeconds } : {}),
  });

  if (!target.supported || !isSupportedPlatform(target.platform)) {
    return {
      supported: false,
      platform: target.platform,
      manager: 'unsupported',
      serviceId: '',
      installed: false,
      unitExists: false,
      unitManaged: false,
      manifestExists: false,
      targetPath: '',
      manifestPath: target.manifestPath,
      dataDirectory,
      host: SERVICE_LOOPBACK_HOST,
      port: validatePort(options.port),
      lock,
      osService: { state: 'unsupported', detail: `Platform "${target.platform}" is not supported.` },
      warnings: [`Headless OS service management is not supported on platform "${target.platform}".`],
    };
  }

  const existingContent = await readTextIfExists(target.targetPath);
  const manifest = await readManifest(target.manifestPath);
  const unitExists = existingContent !== undefined;
  const manifestExists = manifest !== undefined;
  const unitManaged = unitExists && (
    hasExtaliaManagedMarker(target.platform, existingContent)
    || manifest?.targetPath === target.targetPath
  );
  const installed = unitManaged || manifestExists;
  const port = manifest?.port ?? validatePort(options.port);
  const warnings: string[] = [];

  if (unitExists && !unitManaged) {
    warnings.push(`File at ${target.targetPath} is not managed by Extalia.`);
  }
  if (lock.state === 'live') {
    warnings.push(`Single-owner lock is held by ${lock.ownerKind === 'desktop' ? 'Desktop' : 'Bridge'} (pid ${lock.ownerPid}).`);
  } else if (lock.state === 'stale') {
    warnings.push(`Stale host lock found at ${lock.lockFile} (pid ${lock.ownerPid} is no longer running).`);
  } else if (lock.state === 'unreadable') {
    warnings.push(`Host lock at ${lock.lockFile} is unreadable.`);
  }

  let osService: { state: OsServiceState; detail?: string };
  if (!installed) {
    osService = { state: 'not-installed' };
  } else {
    const uid = resolveUid(options.uid);
    const probeSpec = statusProbeCommandFor(target, uid);
    const runner = options.runCommand ?? defaultServiceRunCommand;
    try {
      const probeResult = await runner(probeSpec.command, probeSpec.args, { env: options.env });
      osService = interpretOsProbe(target.platform, probeResult);
    } catch (error) {
      osService = {
        state: 'unknown',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    supported: true,
    platform: target.platform,
    manager: target.manager,
    serviceId: target.serviceId,
    installed,
    unitExists,
    unitManaged,
    manifestExists,
    targetPath: target.targetPath,
    manifestPath: target.manifestPath,
    dataDirectory,
    host: SERVICE_LOOPBACK_HOST,
    port,
    lock,
    osService,
    warnings,
  };
}

/**
 * Start the installed headless OS service. Refuses to start a second owner if
 * another live Host already holds `state/host.lock` (`SCH-AT-20`).
 */
export async function startManagedService(options: ServiceControlOptions): Promise<ServiceControlResult> {
  const target = resolveServiceTarget(options);
  if (!target.supported || !isSupportedPlatform(target.platform) || target.manager === 'unsupported') {
    throw new ServiceManagerError('UNSUPPORTED_PLATFORM', `Headless OS service management is not supported on platform "${target.platform}".`);
  }
  const dataDirectory = assertSafePath(options.dataDirectory, 'dataDirectory');
  const layout = dataLayout(dataDirectory);
  const lock = await inspectHostLock(layout.state, {
    ...(options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.uptimeSeconds ? { uptimeSeconds: options.uptimeSeconds } : {}),
  });
  if (lock.state === 'live' && lock.ownerKind && lock.ownerPid !== undefined) {
    throw new HostLockedError(lock.ownerKind, lock.ownerPid, lock.lockFile);
  }

  const existingContent = await readTextIfExists(target.targetPath);
  const manifest = await readManifest(target.manifestPath);
  const installed = (existingContent !== undefined && hasExtaliaManagedMarker(target.platform, existingContent)) || manifest !== undefined;
  if (!installed) {
    throw new ServiceManagerError(
      'NOT_INSTALLED',
      'Extalia headless service is not installed. Run `extalia service install` first.',
    );
  }

  const uid = resolveUid(options.uid);
  const spec = startCommandFor(target, uid);
  const runner = options.runCommand ?? defaultServiceRunCommand;
  const result = await runner(spec.command, spec.args, { env: options.env });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new ServiceManagerError(
      'COMMAND_FAILED',
      `Failed to start service via "${spec.display}" (exit ${result.code ?? 'signal'})${detail ? `: ${detail}` : ''}`,
    );
  }

  return {
    action: 'start',
    serviceId: target.serviceId,
    manager: target.manager,
    commandResults: [{ spec, result }],
  };
}

/** Stop the installed headless OS service cleanly via the platform service manager. */
export async function stopManagedService(options: ServiceControlOptions): Promise<ServiceControlResult> {
  const target = resolveServiceTarget(options);
  if (!target.supported || !isSupportedPlatform(target.platform) || target.manager === 'unsupported') {
    throw new ServiceManagerError('UNSUPPORTED_PLATFORM', `Headless OS service management is not supported on platform "${target.platform}".`);
  }

  const existingContent = await readTextIfExists(target.targetPath);
  const manifest = await readManifest(target.manifestPath);
  const installed = (existingContent !== undefined && hasExtaliaManagedMarker(target.platform, existingContent)) || manifest !== undefined;
  if (!installed) {
    throw new ServiceManagerError(
      'NOT_INSTALLED',
      'Extalia headless service is not installed.',
    );
  }

  const uid = resolveUid(options.uid);
  const spec = stopCommandFor(target, uid);
  const runner = options.runCommand ?? defaultServiceRunCommand;
  const result = await runner(spec.command, spec.args, { env: options.env });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new ServiceManagerError(
      'COMMAND_FAILED',
      `Failed to stop service via "${spec.display}" (exit ${result.code ?? 'signal'})${detail ? `: ${detail}` : ''}`,
    );
  }

  return {
    action: 'stop',
    serviceId: target.serviceId,
    manager: target.manager,
    commandResults: [{ spec, result }],
  };
}
