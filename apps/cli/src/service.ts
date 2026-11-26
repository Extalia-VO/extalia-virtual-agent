import {
  applyServiceInstall,
  applyServiceUninstall,
  DEFAULT_SERVICE_PORT,
  HostLockedError,
  inspectServiceStatus,
  planServiceInstall,
  planServiceUninstall,
  ServiceManagerError,
  startManagedService,
  stopManagedService,
  type ServiceManagerBaseOptions,
} from '@extalia/host';
import { resolveDataDirectory } from '@extalia/platform';
import type { CliHost } from './cli';

const SERVICE_USAGE = `Usage: extalia service <subcommand> [options]

Subcommands:
  install [--dry-run] [--yes|-y] [--port <number>]
  uninstall [--dry-run] [--yes|-y]
  status [--json]
  start
  stop`;

export type ParsedServiceArgs =
  | { action: 'install'; dryRun: boolean; yes: boolean; port?: number }
  | { action: 'uninstall'; dryRun: boolean; yes: boolean }
  | { action: 'status'; json: boolean }
  | { action: 'start' }
  | { action: 'stop' };

export function parseServiceArgs(args: readonly string[]): ParsedServiceArgs | string {
  const [subcommand, ...rest] = args;
  if (subcommand === 'install') {
    let dryRun = false;
    let yes = false;
    let port: number | undefined;
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index] as string;
      const equals = arg.indexOf('=');
      const flag = equals > 0 ? arg.slice(0, equals) : arg;
      const value = () => (equals > 0 ? arg.slice(equals + 1) : rest[++index]);
      if (flag === '--dry-run' && equals < 0) dryRun = true;
      else if ((flag === '--yes' || flag === '-y') && equals < 0) yes = true;
      else if (flag === '--port') {
        const raw = value() ?? '';
        if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) {
          return `--port needs a number from 1 to 65535 (got "${raw}").`;
        }
        port = Number(raw);
      } else {
        return `Unknown option for service install: ${arg}`;
      }
    }
    return { action: 'install', dryRun, yes, ...(port !== undefined ? { port } : {}) };
  }
  if (subcommand === 'uninstall') {
    let dryRun = false;
    let yes = false;
    for (const arg of rest) {
      if (arg === '--dry-run') dryRun = true;
      else if (arg === '--yes' || arg === '-y') yes = true;
      else return `Unknown option for service uninstall: ${arg}`;
    }
    return { action: 'uninstall', dryRun, yes };
  }
  if (subcommand === 'status') {
    let json = false;
    for (const arg of rest) {
      if (arg === '--json') json = true;
      else return `Unknown option for service status: ${arg}`;
    }
    return { action: 'status', json };
  }
  if (subcommand === 'start' || subcommand === 'stop') {
    if (rest.length > 0) return `Unknown option for service ${subcommand}: ${rest[0]}`;
    return { action: subcommand };
  }
  return SERVICE_USAGE;
}

function baseOptions(host: CliHost): ServiceManagerBaseOptions {
  const dataDirectory = resolveDataDirectory({
    platform: host.platform,
    env: host.env,
    homeDirectory: host.homeDirectory,
  });
  return {
    platform: host.platform,
    homeDirectory: host.homeDirectory,
    dataDirectory,
    env: host.env,
    ...(host.serviceRunCommand ? { runCommand: host.serviceRunCommand } : {}),
    ...(host.serviceUid !== undefined ? { uid: host.serviceUid } : {}),
    ...(host.serviceNow ? { now: host.serviceNow } : {}),
    ...(host.serviceIsProcessAlive ? { isProcessAlive: host.serviceIsProcessAlive } : {}),
    ...(host.serviceUptimeSeconds ? { uptimeSeconds: host.serviceUptimeSeconds } : {}),
  };
}

function formatError(error: unknown): string {
  if (error instanceof HostLockedError || error instanceof ServiceManagerError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function runService(host: CliHost, args: readonly string[]): Promise<number> {
  const parsed = parseServiceArgs(args);
  if (typeof parsed === 'string') {
    host.err(`service: ${parsed}`);
    return 2;
  }

  const base = baseOptions(host);
  try {
    if (parsed.action === 'install') {
      const installOptions = {
        ...base,
        executablePath: host.serviceExecutablePath ?? process.execPath,
        ...(host.binPath ? { entryPath: host.binPath } : {}),
        port: parsed.port ?? DEFAULT_SERVICE_PORT,
      };
      const plan = await planServiceInstall(installOptions);
      if (!plan.supported) {
        host.err(plan.warnings.join('\n') || `Headless OS service management is not supported on ${host.platform}.`);
        return 1;
      }
      host.out(`Service: ${plan.serviceId} (${plan.manager})`);
      host.out(`Target: ${plan.targetPath}`);
      host.out(`EXTALIA_HOME: ${plan.dataDirectory}`);
      host.out(`Address: http://${plan.host}:${plan.port}`);
      host.out(`Backup: ${plan.backupPath}`);
      host.out(`Undo: ${plan.undoCommand}`);
      for (const cmd of plan.activationCommands) host.out(`Activate: ${cmd.display}`);
      for (const warning of plan.warnings) host.out(`Warning: ${warning}`);
      if (plan.diff.trim()) host.out(plan.diff.trimEnd());
      else host.out('No service file changes needed.');

      if (plan.refusedUnmanaged) {
        host.err(`Refusing to overwrite unrelated service file at ${plan.targetPath}.`);
        return 1;
      }
      if (parsed.dryRun) {
        host.out('Dry run complete. No files were changed.');
        return 0;
      }
      if (!parsed.yes) {
        const confirmed = host.prompt ? await host.prompt('Install and activate this service? [y/N] ') : false;
        if (!confirmed) {
          host.err('Cancelled. Nothing was written (pass --yes to apply non-interactively).');
          return 1;
        }
      }
      const result = await applyServiceInstall(installOptions);
      host.out(`Installed: ${result.targetPath}`);
      host.out(`Manifest: ${result.manifestPath}`);
      if (result.backupPath) host.out(`Backup: ${result.backupPath}`);
      host.out(`Undo: ${result.undoCommand}`);
      return 0;
    }

    if (parsed.action === 'uninstall') {
      const plan = await planServiceUninstall(base);
      if (!plan.supported) {
        host.err(plan.warnings.join('\n') || `Headless OS service management is not supported on ${host.platform}.`);
        return 1;
      }
      if (plan.refusedUnmanaged) {
        for (const warning of plan.warnings) host.err(warning);
        return 1;
      }
      if (!plan.hasManagedService) {
        host.out('No Extalia-managed service is installed.');
        return 0;
      }
      host.out(`Service: ${plan.serviceId} (${plan.manager})`);
      host.out(`Target: ${plan.targetPath}`);
      for (const cmd of plan.deactivationCommands) host.out(`Deactivate: ${cmd.display}`);
      for (const warning of plan.warnings) host.out(`Warning: ${warning}`);
      host.out(plan.preservedDataNote);
      if (plan.diff.trim()) host.out(plan.diff.trimEnd());

      if (parsed.dryRun) {
        host.out('Dry run complete. No files were changed.');
        return 0;
      }
      if (!parsed.yes) {
        const confirmed = host.prompt ? await host.prompt('Uninstall the Extalia headless service? [y/N] ') : false;
        if (!confirmed) {
          host.err('Cancelled. Nothing was changed (pass --yes to apply non-interactively).');
          return 1;
        }
      }
      const result = await applyServiceUninstall(base);
      host.out(`Uninstalled ${plan.serviceId}.`);
      host.out(result.preservedDataNote);
      return 0;
    }

    if (parsed.action === 'status') {
      const status = await inspectServiceStatus(base);
      if (parsed.json) {
        host.out(JSON.stringify(status, null, 2));
        return 0;
      }
      host.out(`Service           ${status.serviceId || 'unsupported'} (${status.manager})`);
      host.out(`Installed         ${status.installed ? 'yes' : 'no'}`);
      host.out(`OS service        ${status.osService.state}${status.osService.detail ? ` (${status.osService.detail})` : ''}`);
      const lockLabel = status.lock.state === 'live'
        ? `live (${status.lock.ownerKind === 'desktop' ? 'Desktop' : 'Bridge'}, pid ${status.lock.ownerPid})`
        : status.lock.state === 'stale'
          ? `stale (pid ${status.lock.ownerPid})`
          : status.lock.state;
      host.out(`Host lock         ${lockLabel}`);
      host.out(`Address           http://${status.host}:${status.port}`);
      host.out(`EXTALIA_HOME      ${status.dataDirectory}`);
      if (status.targetPath) host.out(`Target            ${status.targetPath}`);
      for (const warning of status.warnings) host.out(`Warning: ${warning}`);
      return 0;
    }

    if (parsed.action === 'start') {
      const result = await startManagedService(base);
      host.out(`Started ${result.serviceId} (${result.manager}).`);
      return 0;
    }

    const result = await stopManagedService(base);
    host.out(`Stopped ${result.serviceId} (${result.manager}).`);
    return 0;
  } catch (error) {
    host.err(formatError(error));
    return 1;
  }
}
