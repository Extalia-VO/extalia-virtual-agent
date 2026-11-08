import path from 'node:path';
import {
  applyCodexPermissionHookSetup, previewCodexPermissionHookSetup, undoCodexPermissionHookSetup,
  type CodexPermissionHookSetupOptions,
} from '@extalia/host';
import { resolveDataDirectory } from '@extalia/platform';
import type { CliHost } from './cli';

const USAGE = 'Usage: extalia connect codex-permission --session <native UUID> [--codex-home <absolute directory>] [--dry-run] [--undo] [--apply <reviewed revision>]';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Arguments {
  nativeSessionId: string;
  codexHome?: string;
  undo: boolean;
  revision?: string;
}

function parseArguments(args: string[]): Arguments | undefined {
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const equals = arg.indexOf('=');
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    if (flags.has(flag)) return undefined;
    if (flag === '--undo' || flag === '--dry-run') {
      if (equals !== -1) return undefined;
      flags.set(flag, true);
    } else if (flag === '--session' || flag === '--codex-home' || flag === '--apply') {
      const value = equals > 0 ? arg.slice(equals + 1) : args[++index];
      if (value === undefined || !value || value.startsWith('--')) return undefined;
      flags.set(flag, value);
    } else return undefined;
  }
  const nativeSessionId = flags.get('--session');
  const revision = flags.get('--apply');
  const codexHome = flags.get('--codex-home');
  if (typeof nativeSessionId !== 'string' || !SESSION_ID.test(nativeSessionId)
    || (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))
    || (revision !== undefined && flags.has('--dry-run')) || (codexHome !== undefined && typeof codexHome !== 'string')) return undefined;
  return { nativeSessionId, undo: flags.has('--undo'), ...(typeof codexHome === 'string' ? { codexHome } : {}), ...(typeof revision === 'string' ? { revision } : {}) };
}

function quoteArgument(value: string, platform: string): string {
  return platform === 'win32' ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Explicit preview/apply entry point; it never prompts for or changes hook trust. */
export async function runCodexPermissions(host: CliHost, args: string[]): Promise<number> {
  const parsed = parseArguments(args);
  if (!parsed) { host.err(USAGE); return 2; }
  const codexHome = parsed.codexHome ?? (host.env.CODEX_HOME?.trim() || path.join(host.homeDirectory, '.codex'));
  if (!path.isAbsolute(codexHome)) { host.err('--codex-home and CODEX_HOME must resolve to an absolute directory.'); return 2; }
  const options: CodexPermissionHookSetupOptions = {
    extaliaHome: resolveDataDirectory({ platform: host.platform, env: host.env, homeDirectory: host.homeDirectory }),
    codexHome, nodePath: process.execPath, platform: host.platform, nativeSessionId: parsed.nativeSessionId,
  };
  try {
    const plan = parsed.undo
      ? await undoCodexPermissionHookSetup(options, parsed.revision)
      : parsed.revision === undefined ? await previewCodexPermissionHookSetup(options) : await applyCodexPermissionHookSetup(options, parsed.revision);
    const undoCommand = `extalia connect codex-permission --session ${quoteArgument(parsed.nativeSessionId, host.platform)} --codex-home ${quoteArgument(codexHome, host.platform)} --undo`;
    host.out(JSON.stringify({
      ...plan,
      nativeSessionId: parsed.nativeSessionId,
      configPath: path.join(codexHome, 'config.toml'),
      undoCommand,
      operation: parsed.undo ? 'undo' : 'install',
      applied: parsed.revision !== undefined,
      instructions: parsed.revision === undefined ? `Review this preview, then add --apply ${plan.revision} to apply it.`
        : parsed.undo ? 'The synchronous permission handler has been removed.' : 'Review and trust this exact hook in Codex before it can run.',
    }, null, 2));
    return 0;
  } catch (error) {
    host.err(error instanceof Error ? error.message : 'Codex permission hook setup failed.');
    return 1;
  }
}
