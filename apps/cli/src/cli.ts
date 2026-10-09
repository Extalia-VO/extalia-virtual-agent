import { PORTABLE_SESSION_FORMAT, previewImport } from '@extalia/core';
import { resolveDataDirectory } from '@extalia/platform';
import { PROTOCOL_VERSION, parseEvent, parseEventLines, type ParseResult } from '@extalia/protocol';
import type { StartOptions } from './start';

export type { StartOptions } from './start';
export interface UpdateOptions { check: boolean }

/** Everything the CLI touches on the host, injected so commands are testable. */
export interface CliHost {
  version: string;
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  platform: string;
  arch: string;
  nodeVersion: string;
  env: Readonly<Record<string, string | undefined>>;
  homeDirectory: string;
  /** Run the local Bridge until it stops; resolves to the exit code. */
  start(options: StartOptions): Promise<number>;
  update(options: UpdateOptions): Promise<number>;
}

export const DEFAULT_PORT = 4310;

const HELP = `Usage: extalia [command] [options]

Commands:
  start               Start the local Bridge and open Extalia in your browser
                      (the default command)
    --port <number>     Port on 127.0.0.1 (default ${DEFAULT_PORT})
    --no-open           Do not open a browser
    --no-update-check   Skip the update check (or set EXTALIA_NO_UPDATE_CHECK=1)
  update              Install the latest version from npm
    --check             Only report whether a newer version exists
  doctor              Show versions, platform and the user-data location
  validate <file>     Validate Extalia Protocol events (.jsonl, or a JSON array)
                      or Extalia portable sessions (${PORTABLE_SESSION_FORMAT})
  version             Print the CLI version
  help                Show this help`;

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost']);

function disabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes(value?.trim().toLowerCase() ?? '');
}

/** Parse `start` options; returns an error message for invalid input. */
export function parseStartArgs(args: readonly string[], env: Readonly<Record<string, string | undefined>>): StartOptions | string {
  const options: StartOptions = { port: DEFAULT_PORT, open: true, updateCheck: !disabled(env.EXTALIA_NO_UPDATE_CHECK) };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    const equals = arg.indexOf('=');
    const flag = equals > 0 ? arg.slice(0, equals) : arg;
    const value = () => (equals > 0 ? arg.slice(equals + 1) : args[++index]);
    if (flag === '--no-open' && equals < 0) options.open = false;
    else if (flag === '--no-update-check' && equals < 0) options.updateCheck = false;
    else if (flag === '--port') {
      const port = value() ?? '';
      if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return `--port needs a number from 0 to 65535 (got "${port}").`;
      options.port = Number(port);
    } else if (flag === '--host') {
      // Accepted for clarity only: the Bridge never listens beyond this computer.
      const host = value() ?? '';
      if (!LOOPBACK_NAMES.has(host.toLowerCase())) return `--host must be 127.0.0.1 or localhost; the Bridge only listens on this computer (got "${host}").`;
    } else return `Unknown option: ${arg}`;
  }
  return options;
}

async function start(host: CliHost, args: readonly string[]): Promise<number> {
  const options = parseStartArgs(args, host.env);
  if (typeof options === 'string') { host.err(`start: ${options}\n\n${HELP}`); return 2; }
  return host.start(options);
}

async function update(host: CliHost, args: readonly string[]): Promise<number> {
  const unknown = args.find(arg => arg !== '--check');
  if (unknown !== undefined) { host.err(`update: unknown option ${unknown}\n\n${HELP}`); return 2; }
  return host.update({ check: args.includes('--check') });
}

const MIN_NODE = [22, 12] as const;

function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

async function doctor(host: CliHost): Promise<number> {
  const dataDirectory = resolveDataDirectory({ platform: host.platform, env: host.env, homeDirectory: host.homeDirectory });
  const nodeOk = nodeSupported(host.nodeVersion);
  host.out(`Extalia CLI       ${host.version}`);
  host.out(`Protocol          ${PROTOCOL_VERSION}`);
  host.out(`Node.js           ${host.nodeVersion}${nodeOk ? '' : `  (requires ${MIN_NODE.join('.')} or newer)`}`);
  host.out(`Platform          ${host.platform} ${host.arch}`);
  host.out(`User data         ${dataDirectory}${(await host.exists(dataDirectory)) ? '' : '  (not created yet)'}`);
  return nodeOk ? 0 : 1;
}

function report(host: CliHost, label: string, result: ParseResult): boolean {
  if (result.ok) return true;
  host.err(`${label}: ${result.code}: ${result.errors.join(' ')}`);
  return false;
}

async function validate(host: CliHost, file: string | undefined): Promise<number> {
  if (!file) { host.err('validate: missing file. Usage: extalia validate <file>'); return 2; }
  let content: string;
  try { content = await host.readFile(file); }
  catch (error) { host.err(`validate: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`); return 2; }

  const trimmed = content.trim();
  // A whole-file JSON value is a single item or an array; anything else is read as JSON Lines.
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }

  const items = parsed === undefined ? undefined : Array.isArray(parsed) ? parsed : [parsed];
  const looksLikeSessions = items?.some(item => typeof item === 'object' && item !== null && (item as { format?: unknown }).format === PORTABLE_SESSION_FORMAT);
  if (looksLikeSessions) {
    const preview = previewImport(trimmed);
    if (preview.rejectionReason) { host.err(`Invalid portable sessions: ${preview.rejectionReason}`); return 1; }
    const redactions = preview.results.reduce((sum, entry) => sum + entry.redactions, 0);
    host.out(`${preview.results.length} portable session(s) valid${redactions ? `; ${redactions} likely credential(s) would be redacted on import` : ''}.`);
    return 0;
  }

  const results = items
    ? items.map((item, index) => ({ label: `item ${index + 1}`, result: parseEvent(item) }))
    : parseEventLines(content).map(entry => ({ label: `line ${entry.line}`, result: entry.result }));
  if (!results.length) { host.err('validate: no events found.'); return 1; }
  const valid = results.filter(entry => report(host, entry.label, entry.result)).length;
  host.out(`${valid} of ${results.length} event(s) valid (${PROTOCOL_VERSION}).`);
  return valid === results.length ? 0 : 1;
}

/** Run a command and return the process exit code. */
export async function run(args: readonly string[], host: CliHost): Promise<number> {
  const [command, ...rest] = args;
  // `extalia` and `extalia --port 4400` start the Bridge.
  if (command === undefined || (command.startsWith('-') && !['-h', '--help', '-v', '--version'].includes(command))) return start(host, args);
  switch (command) {
    case 'start':
      return start(host, rest);
    case 'update':
      return update(host, rest);
    case 'help':
    case '--help':
    case '-h':
      host.out(HELP);
      return 0;
    case 'version':
    case '--version':
    case '-v':
      host.out(host.version);
      return 0;
    case 'doctor':
      return doctor(host);
    case 'validate':
      return validate(host, rest[0]);
    default:
      host.err(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}
