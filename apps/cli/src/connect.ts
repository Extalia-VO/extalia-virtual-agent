import { createInterface } from 'node:readline/promises';
import { ConnectError, createConnectService, runMcpStdioServer, type ConnectService, type McpServerOptions } from '@extalia/host';
import { resolveDataDirectory, type AgentAppConnectOptions, type AgentAppId } from '@extalia/platform';
import type { CliHost } from './cli';

const APPS: readonly AgentAppId[] = ['codex', 'claude', 'gemini', 'antigravity', 'hermes'];
const LABELS: Record<AgentAppId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity',
  hermes: 'Hermes',
};

export function isAgentAppId(value: string | undefined): value is AgentAppId {
  return value !== undefined && (APPS as readonly string[]).includes(value);
}

export interface ParsedConnectArgs {
  app: AgentAppId;
  dryRun: boolean;
  yes: boolean;
  options: AgentAppConnectOptions;
}

export function parseConnectArgs(args: readonly string[]): ParsedConnectArgs | string {
  const [app, ...rest] = args;
  if (!isAgentAppId(app)) {
    return 'Usage: extalia connect <codex|claude|gemini|antigravity|hermes> [--dry-run] [--yes|-y] [--port <number>] [--rotate] [--trust]';
  }
  let dryRun = false;
  let yes = false;
  const options: AgentAppConnectOptions = {};
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const equals = arg.indexOf('=');
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const value = () => (equals > 0 ? arg.slice(equals + 1) : rest[++index]);
    if (flag === '--dry-run' && equals < 0) dryRun = true;
    else if ((flag === '--yes' || flag === '-y') && equals < 0) yes = true;
    else if (flag === '--rotate' && equals < 0) options.rotate = true;
    else if (flag === '--trust' && equals < 0) options.trust = true;
    else if (flag === '--port') {
      const port = value() ?? '';
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        return `--port needs a number from 1 to 65535 (got "${port}").`;
      }
      options.port = Number(port);
    } else {
      return `Unknown option: ${arg}`;
    }
  }
  return { app, dryRun, yes, options };
}

export async function defaultPrompt(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

async function resolveService(host: CliHost): Promise<ConnectService> {
  if (host.connectService) return host.connectService();
  const extaliaHome = resolveDataDirectory({ platform: host.platform, env: host.env, homeDirectory: host.homeDirectory });
  return createConnectService({
    platform: host.platform,
    env: host.env,
    homeDirectory: host.homeDirectory,
    extaliaHome,
    nodePath: process.execPath,
  });
}

export async function runConnect(host: CliHost, args: readonly string[]): Promise<number> {
  const parsed = parseConnectArgs(args);
  if (typeof parsed === 'string') {
    host.err(`connect: ${parsed}`);
    return 2;
  }
  const { app, dryRun, yes, options } = parsed;
  try {
    const service = await resolveService(host);
    const plan = await service.plan(app, options);
    if (!plan.supported) {
      host.err(plan.warnings.join('\n') || `${LABELS[app]} hooks arrive in a later release.`);
      return 1;
    }
    const versionText = plan.version ? ` ${plan.version}` : plan.installed ? ' (installed)' : ' (not detected)';
    host.out(`${LABELS[app]}${versionText}`);
    host.out(`Target: ${plan.configPath}`);
    for (const warning of plan.warnings) host.out(`Warning: ${warning}`);
    if (plan.nodeStatus === 'missing') {
      host.err(`${LABELS[app]} command hooks need an available Node.js runtime. Nothing was written; install Node.js and review the connection again.`);
      return 1;
    }
    if (plan.diff.trim()) host.out(plan.diff.trimEnd());
    else host.out('No configuration file changes needed.');
    if (plan.trustHint) host.out(plan.trustHint);

    if (dryRun) {
      host.out('Dry run complete. No files were changed.');
      return 0;
    }
    if (!plan.changes && !options.trust) {
      host.out('Already connected.');
      return 0;
    }
    if (!yes) {
      const confirmed = host.prompt ? await host.prompt('Apply these changes? [y/N] ') : false;
      if (!confirmed) {
        host.err('Cancelled. Nothing was written (pass --yes to apply non-interactively).');
        return 1;
      }
    }

    const result = await service.apply(app, {
      ...options,
      ...(plan.previewDigest !== undefined ? { expectedPreviewDigest: plan.previewDigest } : {}),
    });
    host.out(`Updated: ${result.configPath}`);
    if (result.backupPath) host.out(`Backup: ${result.backupPath}`);
    if (result.app === 'codex') host.out(`Trust: ${result.trust.status} (${result.trust.trusted}/${result.trust.total})`);
    for (const warning of result.warnings) {
      if (!plan.warnings.includes(warning)) host.out(`Warning: ${warning}`);
    }
    host.out(`Test: ${result.test.message}`);
    if (result.restartHint) host.out(result.restartHint);
    host.out(`Undo: ${result.undoCommand}`);
    return 0;
  } catch (error) {
    host.err(error instanceof ConnectError || error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runDisconnect(host: CliHost, args: readonly string[]): Promise<number> {
  const [app, ...rest] = args;
  if (!isAgentAppId(app) || rest.length > 0) {
    host.err('disconnect: Usage: extalia disconnect <codex|claude|gemini|antigravity|hermes>');
    return 2;
  }
  try {
    const service = await resolveService(host);
    const result = await service.disconnect(app);
    if (!result.changed) {
      host.out(`Nothing to remove for ${LABELS[app]}.`);
    } else if (result.restoredExactly) {
      host.out(`Disconnected ${LABELS[app]}: restored ${result.configPath ?? app} byte-for-byte from backup (${result.removed} event(s) removed).`);
    } else {
      host.out(`Disconnected ${LABELS[app]}: removed ${result.removed} Extalia entry/entries from ${result.configPath ?? app}.`);
    }
    for (const warning of result.warnings) host.out(`Warning: ${warning}`);
    return 0;
  } catch (error) {
    host.err(error instanceof ConnectError || error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runConnections(host: CliHost, args: readonly string[]): Promise<number> {
  if (args.length > 0) {
    host.err('connections: Usage: extalia connections');
    return 2;
  }
  try {
    const service = await resolveService(host);
    const connections = await service.connections();
    for (const item of connections) {
      const version = item.version ? ` ${item.version}` : '';
      const trust = item.app === 'codex' && item.trust.status !== 'not-applicable'
        ? ` | trust: ${item.trust.status} (${item.trust.trusted}/${item.trust.total})`
        : '';
      const hostInfo = ` | host: ${item.hostRunning ? 'running' : 'down'} (port ${item.port})`;
      const lastEvent = item.lastEventAt ? ` | last event: ${item.lastEventAt}` : '';
      host.out(`${item.label}${version}: ${item.state}${trust}${hostInfo}${lastEvent}`);
      host.out(`  Config: ${item.configPath}`);
      for (const warning of item.warnings) host.out(`  Warning: ${warning}`);
    }
    return 0;
  } catch (error) {
    host.err(error instanceof ConnectError || error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export interface ParsedMcpArgs {
  app?: AgentAppId;
  sessionId?: string;
  port?: number;
}

export function parseMcpArgs(args: readonly string[]): ParsedMcpArgs | string {
  const parsed: ParsedMcpArgs = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const equals = arg.indexOf('=');
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const value = () => (equals > 0 ? arg.slice(equals + 1) : args[++index]);
    if (flag === '--app') {
      const app = value();
      if (!isAgentAppId(app)) return `--app must be one of codex, claude, gemini, antigravity, hermes (got "${app ?? ''}").`;
      parsed.app = app;
    } else if (flag === '--session') {
      const sessionId = (value() ?? '').trim();
      if (!sessionId) return '--session needs a session identifier.';
      parsed.sessionId = sessionId;
    } else if (flag === '--port') {
      const port = value() ?? '';
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        return `--port needs a number from 1 to 65535 (got "${port}").`;
      }
      parsed.port = Number(port);
    } else {
      return `Unknown option: ${arg}. Usage: extalia mcp [--app <codex|claude|gemini|antigravity|hermes>] [--session <id>] [--port <number>]`;
    }
  }
  return parsed;
}

export async function runMcp(host: CliHost, args: readonly string[]): Promise<number> {
  const parsed = parseMcpArgs(args);
  if (typeof parsed === 'string') {
    host.err(`mcp: ${parsed}`);
    return 2;
  }
  const extaliaHome = resolveDataDirectory({ platform: host.platform, env: host.env, homeDirectory: host.homeDirectory });
  const options: McpServerOptions & { input?: NodeJS.ReadableStream; output?: (line: string) => void } = {
    extaliaHome,
    version: host.version,
    ...(parsed.app ? { app: parsed.app } : {}),
    ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
    ...(parsed.port ? { port: parsed.port } : {}),
    ...(host.mcpInput ? { input: host.mcpInput } : {}),
    output: line => host.out(line),
  };
  return runMcpStdioServer(options);
}
