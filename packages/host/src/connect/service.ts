import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AgentAppConnectOptions, AgentAppConnectPlan, AgentAppConnectResult, AgentAppConnection, AgentAppDisconnectResult, AgentAppId, AgentAppTestResult, AgentAppTrustStatus,
} from '@extalia/platform';
import { HERMES_PROFILE_PATTERN } from '@extalia/runtime';
import { hermesSignature } from '../hooks/http.js';
import { HOOK_SOURCE_IDS } from '../hooks/normalize.js';
import { isNotFound, readJson, writeJsonAtomic } from '../jsonStore.js';
import { readMigrationMarker } from '../migration.js';
import { NativeImportService } from '../nativeImport.js';
import {
  ANTIGRAVITY_EVENTS, antigravityCommand, existingAntigravityCommand, inspectAntigravityHooks, planAntigravityHooks, removeAntigravityEntries, type AntigravityDesired,
} from './antigravity.js';
import {
  CLAUDE_EVENTS, claudeCommand, existingClaudeEntries, inspectClaudeSettings, planClaudeSettings, removeClaudeEntries, wouldReformat, type ClaudeDesired,
} from './claude.js';
import {
  CODEX_EVENTS, codexCommand, existingCodexCommand, inspectCodexConfig, planCodexConfig, removeCodexBlock, removeTrustTables, type CodexDesired,
} from './codex.js';
import {
  listExtaliaHooks, spawnCodexAppServer, summarizeTrust, trustExtaliaHooks, type CodexRpc, type CodexRpcFactory,
} from './codexAppServer.js';
import { unifiedDiff } from './diff.js';
import { DEFAULT_HOOK_PORT, ensureToken, readEndpoint, readToken } from './endpoint.js';
import { forwarderPath, forwarderStatus, installForwarder } from './forwarder.js';
import {
  GEMINI_EVENTS, existingGeminiCommand, geminiCommand, inspectGeminiSettings, planGeminiSettings, removeGeminiEntries, type GeminiDesired,
} from './gemini.js';
import {
  HERMES_EVENTS, existingHermesPort, inspectHermesConfig, planHermesConfig, removeHermesBlock,
} from './hermes.js';
import {
  ConnectError, displayPath, findOnPath, isExecutable, sha256, timestampForPath, writableTarget, writeConfigFile, type Env,
} from './util.js';

/** App versions the hook formats were verified against (prefix match). */
export const VERIFIED_VERSIONS: Record<AgentAppId, { pattern: RegExp; text: string }> = {
  codex: { pattern: /^0\.161\./, text: 'Codex 0.161' },
  claude: { pattern: /^2\.1\./, text: 'Claude Code 2.1' },
  gemini: { pattern: /^0\.\d+\./, text: 'Gemini CLI 0.x' },
  antigravity: { pattern: /^\d+\.\d+/, text: 'Antigravity 2.x' },
  hermes: { pattern: /^0\.\d+\./, text: 'Hermes 0.x' },
};

const LABELS: Record<AgentAppId, string> = { codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', antigravity: 'Antigravity', hermes: 'Hermes' };
const MASK = '<ingest token>';
const NEW_TOKEN = '<new ingest token>';

export interface RunResult { code: number | null; stdout: string; stderr: string }
export type RunCommand = (command: string, args: string[], options: { env: Env; timeoutMs: number }) => Promise<RunResult | undefined>;

export interface ConnectContext {
  platform: string;
  env: Env;
  homeDirectory: string;
  /** The Extalia data directory (`EXTALIA_HOME`): hooks, connect backups and manifest live below it. */
  extaliaHome: string;
  /** Absolute path of a Node.js binary for hook commands. */
  nodePath: string;
  now?: () => Date;
  run?: RunCommand;
  findBinary?: (name: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  codexRpc?: CodexRpcFactory;
  /** System-wide Claude Code policy files to read (never written). Defaults by platform. */
  managedClaudeSettings?: string[];
  /** Latest hook event time per app, when a host reports it. */
  lastEvent?: (app: AgentAppId) => string | undefined | Promise<string | undefined>;
  alive?: (pid: number) => boolean;
  /** How the user would run the CLI, for the undo command. */
  cliCommand?: string;
}

export interface ConnectService {
  connections(): Promise<AgentAppConnection[]>;
  plan(app: AgentAppId, options?: AgentAppConnectOptions): Promise<AgentAppConnectPlan>;
  apply(app: AgentAppId, options?: AgentAppConnectOptions): Promise<AgentAppConnectResult>;
  disconnect(app: AgentAppId): Promise<AgentAppDisconnectResult>;
  test(app: AgentAppId): Promise<AgentAppTestResult>;
}

interface ExtraProfileRecord {
  configPath: string;
  original: { existed: boolean; sha256?: string; backupDir: string; backupFile?: string };
  writtenSha256: string;
  inserted?: string;
}

interface AppRecord {
  connectedAt: string;
  updatedAt: string;
  configPath: string;
  /** The file as it was before Extalia first touched it. */
  original: { existed: boolean; sha256?: string; backupDir: string; backupFile?: string };
  lastBackupDir?: string;
  /** Hash of the file as Extalia last left it; equal means nobody edited it since. */
  writtenSha256: string;
  /** Codex / Hermes: the exact text appended, for byte-exact removal. */
  inserted?: string;
  /** Hermes: named profile `config.yaml` files updated alongside the primary one. */
  profiles?: ExtraProfileRecord[];
  /** Codex: trust keys Extalia wrote. */
  trustedKeys: string[];
  events: string[];
}

interface Manifest { schema: 'extalia.connect-manifest.v1'; apps: Partial<Record<AgentAppId, AppRecord>> }

const defaultRun: RunCommand = (command, args, { env, timeoutMs }) => new Promise(resolve => {
  let stdout = '', stderr = '';
  try {
    const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); resolve(undefined); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(undefined); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  } catch { resolve(undefined); }
});

/** Split a hook command into its arguments (POSIX single quotes, Windows double quotes, or bare words). */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|"((?:[^"]|"")*)"|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    if (match[1] !== undefined) words.push(match[1].replace(/'\\''/g, `'`));
    else if (match[2] !== undefined) words.push(match[2].replace(/""/g, '"'));
    else words.push(match[3] as string);
  }
  return words;
}

function parseVersion(result: RunResult | undefined, app: AgentAppId): string | undefined {
  if (!result) return undefined;
  const combined = `${result.stdout}\n${result.stderr}`;
  if ((app === 'gemini' || app === 'antigravity' || app === 'hermes') && /Claude Code|codex-cli/i.test(combined)) return undefined;
  return /\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/.exec(result.stdout)?.[0] ?? /\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/.exec(result.stderr)?.[0];
}

/** Resolve a Node.js binary for hook commands; Electron's own binary is not one. */
export async function resolveNodePath(options: { execPath: string; electron?: boolean; env: Env; platform: string }): Promise<string | undefined> {
  if (!options.electron) return options.execPath;
  return findOnPath('node', options.env, options.platform);
}

function managedClaudePaths(platform: string): string[] {
  if (platform === 'darwin') return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  if (platform === 'win32') return ['C:\\Program Files\\ClaudeCode\\managed-settings.json'];
  return ['/etc/claude-code/managed-settings.json'];
}

const wildcard = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

const ENV_BIN: Record<AgentAppId, string> = {
  codex: 'EXTALIA_CODEX_BIN',
  claude: 'EXTALIA_CLAUDE_BIN',
  gemini: 'EXTALIA_GEMINI_BIN',
  antigravity: 'EXTALIA_ANTIGRAVITY_BIN',
  hermes: 'EXTALIA_HERMES_BIN',
};

export function createConnectService(ctx: ConnectContext): ConnectService {
  const now = ctx.now ?? (() => new Date());
  const run = ctx.run ?? defaultRun;
  const findBinary = ctx.findBinary ?? ((name: string) => findOnPath(name, ctx.env, ctx.platform));
  const rpcFactory = ctx.codexRpc ?? spawnCodexAppServer;
  const connectDirectory = path.join(ctx.extaliaHome, 'connect');
  const manifestFile = path.join(connectDirectory, 'manifest.json');
  const forwarder = forwarderPath(ctx.extaliaHome);

  const hermesRootDir = (): string => {
    const configured = ctx.env.HERMES_HOME?.trim();
    if (!configured) return path.join(ctx.homeDirectory, '.hermes');
    return path.basename(path.dirname(configured)) === 'profiles' ? path.dirname(path.dirname(configured)) : configured;
  };

  const configPath = (app: AgentAppId): string => {
    if (app === 'codex') return path.join(ctx.env.CODEX_HOME?.trim() || path.join(ctx.homeDirectory, '.codex'), 'config.toml');
    if (app === 'claude') return path.join(ctx.env.CLAUDE_CONFIG_DIR?.trim() || path.join(ctx.homeDirectory, '.claude'), 'settings.json');
    if (app === 'gemini') return path.join(ctx.env.GEMINI_CLI_HOME?.trim() || path.join(ctx.homeDirectory, '.gemini'), 'settings.json');
    if (app === 'antigravity') return path.join(ctx.env.ANTIGRAVITY_CONFIG_DIR?.trim() || path.join(ctx.homeDirectory, '.gemini', 'config'), 'hooks.json');
    return path.join(ctx.env.HERMES_HOME?.trim() || path.join(ctx.homeDirectory, '.hermes'), 'config.yaml');
  };

  /** Named Hermes profile config files (`<hermesRoot>/profiles/<name>/config.yaml`), sorted by profile name. */
  async function extraHermesProfileConfigs(primaryFile: string): Promise<Array<{ profile: string; file: string }>> {
    const root = hermesRootDir();
    const profilesDir = path.join(root, 'profiles');
    try {
      const entries = await readdir(profilesDir, { withFileTypes: true });
      const found: Array<{ profile: string; file: string }> = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !HERMES_PROFILE_PATTERN.test(entry.name)) continue;
        const candidate = path.join(profilesDir, entry.name, 'config.yaml');
        if (path.resolve(candidate) !== path.resolve(primaryFile)) {
          found.push({ profile: entry.name, file: candidate });
        }
      }
      return found;
    } catch {
      return [];
    }
  }

  const isSupported = (_app: AgentAppId) => true;
  const undoCommand = (app: AgentAppId) => {
    const home = ctx.env.EXTALIA_HOME?.trim();
    const prefix = home ? `EXTALIA_HOME=${/^[\w./-]+$/.test(home) ? home : `'${home.replace(/'/g, `'\\''`)}'`} ` : '';
    return `${prefix}${ctx.cliCommand ?? 'extalia'} disconnect ${app}`;
  };

  async function readManifest(): Promise<Manifest> {
    const value = await readJson<Partial<Manifest> | undefined>(manifestFile, undefined);
    return { schema: 'extalia.connect-manifest.v1', apps: value?.apps && typeof value.apps === 'object' ? value.apps : {} };
  }
  async function writeManifest(manifest: Manifest): Promise<void> {
    await mkdir(connectDirectory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(manifestFile, manifest);
  }

  async function detect(app: AgentAppId): Promise<{ installed: boolean; bin?: string; version?: string; verified?: boolean }> {
    if (!isSupported(app)) return { installed: false };
    const override = ctx.env[ENV_BIN[app]]?.trim();
    const bin = override || (app === 'antigravity' ? (await findBinary('agy')) || (await findBinary('antigravity')) : await findBinary(app));
    const text = await readTextSafe(configPath(app));
    const configDirExists = text !== undefined
      || (await dirExists(path.dirname(configPath(app))))
      || (app === 'antigravity' && (
        (await dirExists(ctx.env.ANTIGRAVITY_HOME?.trim() || path.join(ctx.homeDirectory, '.gemini', 'antigravity')))
        || (await dirExists(path.join(ctx.homeDirectory, '.gemini', 'tasks')))
        || (await dirExists(path.join(ctx.homeDirectory, '.gemini')))
      ));
    const version = bin ? parseVersion(await run(bin, ['--version'], { env: ctx.env, timeoutMs: 8000 }), app) : undefined;
    const rule = VERIFIED_VERSIONS[app];
    return { installed: Boolean(bin) || configDirExists, ...(bin ? { bin } : {}), ...(version ? { version, verified: rule.pattern.test(version) } : {}) };
  }

  async function commandValid(command: string | undefined): Promise<boolean> {
    if (!command) return false;
    const [node, script] = splitCommand(command);
    return Boolean(node && script && path.resolve(script) === path.resolve(forwarder) && (await isExecutable(node)));
  }

  async function resolvePort(options: AgentAppConnectOptions, existing: number | undefined): Promise<{ port: number; hostRunning: boolean }> {
    const endpoint = await readEndpoint(ctx.extaliaHome, ctx.alive);
    const alive = Boolean(endpoint?.alive);
    return { port: options.port ?? (alive ? endpoint?.port : undefined) ?? existing ?? DEFAULT_HOOK_PORT, hostRunning: alive };
  }

  async function claudeWarnings(): Promise<string[]> {
    const warnings: string[] = [];
    for (const file of ctx.managedClaudeSettings ?? managedClaudePaths(ctx.platform)) {
      const text = await readTextSafe(file);
      if (!text) continue;
      try {
        const policy = JSON.parse(text) as Record<string, unknown>;
        if (policy.disableAllHooks === true) warnings.push(`A managed Claude Code policy (${file}) disables all hooks.`);
        if (policy.allowManagedHooksOnly === true) warnings.push(`A managed Claude Code policy (${file}) only allows managed hooks, so Extalia's hooks will not run.`);
        if (Array.isArray(policy.allowedHttpHookUrls) && !policy.allowedHttpHookUrls.some(entry => typeof entry === 'string' && wildcard(entry).test('http://127.0.0.1:4317/api/hooks/claude'))) {
          warnings.push(`A managed Claude Code policy (${file}) restricts HTTP hook URLs and does not list the local Extalia endpoint.`);
        }
      } catch { /* an unreadable policy is not ours to report */ }
    }
    return warnings;
  }

  async function withRpc<T>(bin: string, fn: (rpc: CodexRpc) => Promise<T>): Promise<T> {
    const rpc = await rpcFactory({ bin, codexHome: path.dirname(configPath('codex')), env: ctx.env, cwd: os.tmpdir() });
    try { return await fn(rpc); } finally { rpc.close(); }
  }

  async function codexTrust(bin: string | undefined): Promise<{ status: AgentAppTrustStatus; trusted: number; total: number; warning?: string }> {
    if (!bin) return { status: 'unknown', trusted: 0, total: 0 };
    try {
      const hooks = await withRpc(bin, rpc => listExtaliaHooks(rpc, configPath('codex'), os.tmpdir()));
      return summarizeTrust(hooks);
    } catch (error) {
      return { status: 'unknown', trusted: 0, total: 0, warning: `Could not read hook trust from Codex (${error instanceof Error ? error.message : 'unknown error'}).` };
    }
  }

  // ---- state of one app --------------------------------------------------------------------------------------------

  async function describe(app: AgentAppId): Promise<AgentAppConnection> {
    const label = LABELS[app];
    const file = configPath(app);
    const base: AgentAppConnection = {
      app, label, supported: isSupported(app), installed: false, connected: false, state: 'not-connected',
      trust: { status: 'not-applicable', trusted: 0, total: 0 }, warnings: [], events: [], hostRunning: false, port: DEFAULT_HOOK_PORT, configPath: file,
    };
    const endpoint = await readEndpoint(ctx.extaliaHome, ctx.alive);
    base.hostRunning = Boolean(endpoint?.alive);
    if (endpoint?.alive) base.port = endpoint.port;
    const last = await ctx.lastEvent?.(app);
    if (last) base.lastEventAt = last;
    if (!isSupported(app)) { base.warnings.push(`${label} hooks arrive in a later release.`); return base; }

    const detected = await detect(app);
    base.installed = detected.installed;
    if (detected.version) { base.version = detected.version; base.versionVerified = Boolean(detected.verified); }
    if (detected.version && !detected.verified) base.warnings.push(`${label} ${detected.version} was not verified; hooks were tested with ${VERIFIED_VERSIONS[app].text}.`);

    let text: string | undefined;
    try { text = await readTextSafe(file); } catch { /* handled below */ }
    const token = await readToken(ctx.extaliaHome);
    let fwd = await forwarderStatus(ctx.extaliaHome);
    if (fwd === 'outdated') {
      try {
        await installForwarder(ctx.extaliaHome);
        fwd = await forwarderStatus(ctx.extaliaHome);
      } catch { /* reported below if still outdated */ }
    }
    // Hooks connected before the data folder moved still run the old forwarder, which now passes events on.
    const migrated = await readMigrationMarker(ctx.extaliaHome);
    const legacyForwarder = migrated ? path.resolve(forwarderPath(migrated.from)) : undefined;
    let legacyHooks = false;
    const noteLegacy = (command: string | undefined) => {
      const script = command ? splitCommand(command)[1] : undefined;
      if (legacyForwarder && script && path.resolve(script) === legacyForwarder) legacyHooks = true;
    };

    try {
      if (app === 'claude') {
        const existing = existingClaudeEntries(text, file);
        noteLegacy(existing.command);
        const port = (await resolvePort({}, existing.port)).port;
        const command = (await commandValid(existing.command)) ? (existing.command as string) : claudeCommand(ctx.nodePath, forwarder, ctx.platform);
        const inspected = inspectClaudeSettings(text, file, { port: base.hostRunning ? port : undefined, token: token ?? '', command });
        const ours = CLAUDE_EVENTS.length - inspected.missing.length;
        base.events = CLAUDE_EVENTS.filter(event => !inspected.missing.includes(event));
        base.state = ours === 0 ? 'not-connected' : inspected.missing.length ? 'partial' : inspected.stale.length || !token ? 'stale' : 'connected';
        if (base.state === 'stale') base.warnings.push(token ? 'The hooks use an old token, port or Node path. Connect again to update them.' : 'The ingest token is missing. Connect again to create it.');
        if (base.state === 'partial') base.warnings.push(`Some hooks are missing (${inspected.missing.join(', ')}). Connect again to repair them.`);
        if (inspected.disableAllHooks) base.warnings.push('Claude Code settings have disableAllHooks set, so no hooks run.');
        if (inspected.allowManagedHooksOnly) base.warnings.push('Claude Code settings allow managed hooks only, so Extalia hooks will not run.');
        if (ours) base.warnings.push(...(await claudeWarnings()));
        base.port = port;
      } else if (app === 'gemini') {
        const existing = existingGeminiCommand(text, file);
        noteLegacy(existing);
        const command = (await commandValid(existing)) ? (existing as string) : geminiCommand(ctx.nodePath, forwarder, ctx.platform);
        const inspected = inspectGeminiSettings(text, file, { command });
        const ours = GEMINI_EVENTS.length - inspected.missing.length;
        base.events = GEMINI_EVENTS.filter(event => !inspected.missing.includes(event));
        base.state = ours === 0 ? 'not-connected' : inspected.missing.length ? 'partial' : inspected.stale.length || !token ? 'stale' : 'connected';
        if (base.state === 'stale') base.warnings.push(token ? 'The hooks point to a Node binary or forwarder that is missing or moved. Connect again to update them.' : 'The ingest token is missing. Connect again to create it.');
        if (base.state === 'partial') base.warnings.push(`Some hooks are missing (${inspected.missing.join(', ')}). Connect again to repair them.`);
      } else if (app === 'antigravity') {
        const existing = existingAntigravityCommand(text, file);
        noteLegacy(existing);
        const command = (await commandValid(existing)) ? (existing as string) : antigravityCommand(ctx.nodePath, forwarder, ctx.platform);
        const inspected = inspectAntigravityHooks(text, file, { command });
        const ours = ANTIGRAVITY_EVENTS.length - inspected.missing.length;
        base.events = ANTIGRAVITY_EVENTS.filter(event => !inspected.missing.includes(event));
        base.state = ours === 0 ? 'not-connected' : inspected.missing.length ? 'partial' : inspected.stale.length || !token ? 'stale' : 'connected';
        if (base.state === 'stale') base.warnings.push(token ? 'The hooks point to a Node binary or forwarder that is missing or moved. Connect again to update them.' : 'The ingest token is missing. Connect again to create it.');
        if (base.state === 'partial') base.warnings.push(`Some hooks are missing (${inspected.missing.join(', ')}). Connect again to repair them.`);
      } else if (app === 'hermes') {
        const existingPort = existingHermesPort(text, file);
        const port = (await resolvePort({}, existingPort)).port;
        const inspected = inspectHermesConfig(text, file, { port: base.hostRunning ? port : undefined, token: token ?? '' });
        const ours = HERMES_EVENTS.length - inspected.missing.length;
        base.events = HERMES_EVENTS.filter(event => !inspected.missing.includes(event));
        base.state = ours === 0 ? 'not-connected' : inspected.missing.length ? 'partial' : inspected.stale.length || !token ? 'stale' : 'connected';
        if (base.state === 'stale') base.warnings.push(token ? 'The webhook uses an old secret or port. Connect again to update it.' : 'The ingest token is missing. Connect again to create it.');
        if (base.state === 'partial') base.warnings.push(`Some webhook events are missing (${inspected.missing.join(', ')}). Connect again to repair them.`);
        base.port = port;
      } else {
        const existing = existingCodexCommand(text, file);
        noteLegacy(existing);
        const command = (await commandValid(existing)) ? (existing as string) : codexCommand(ctx.nodePath, forwarder, ctx.platform);
        const inspected = inspectCodexConfig(text, file, { command });
        const ours = CODEX_EVENTS.length - inspected.missing.length;
        base.events = CODEX_EVENTS.filter(event => !inspected.missing.includes(event));
        base.state = ours === 0 ? 'not-connected' : inspected.missing.length ? 'partial' : inspected.stale.length || !token ? 'stale' : 'connected';
        if (base.state === 'stale') base.warnings.push('The hooks point to a Node binary or forwarder that is missing or moved. Connect again to update them.');
        if (base.state === 'partial') base.warnings.push(`Some hooks are missing (${inspected.missing.join(', ')}). Connect again to repair them.`);
        if (ours) {
          const trust = await codexTrust(detected.bin);
          base.trust = { status: trust.status, trusted: trust.trusted, total: trust.total };
          if (trust.warning) base.warnings.push(trust.warning);
          if (trust.status === 'untrusted' || trust.status === 'modified') base.warnings.push(`Codex has not approved the Extalia hooks (${trust.status}). Open Codex, run /hooks and approve them.`);
        }
      }
    } catch (error) {
      base.warnings.push(error instanceof Error ? error.message : 'The configuration could not be read.');
      base.state = 'not-connected';
    }
    if (base.state !== 'not-connected' && app !== 'hermes' && fwd !== 'current') {
      base.warnings.push(fwd === 'missing' ? 'The Extalia forwarder script is missing. Connect again to reinstall it.' : 'The Extalia forwarder script is out of date. Connect again to update it.');
    }
    if (legacyHooks && migrated && base.state !== 'not-connected') {
      base.warnings.unshift(`Extalia moved its data folder to ${ctx.extaliaHome}. These hooks still run the forwarder in the previous folder (${migrated.from}), which passes events on for now. Run \`extalia connect ${app}\` (or Connect again) to point them to the new folder.`);
    }
    base.connected = base.state === 'connected';
    return base;
  }

  // ---- planning -----------------------------------------------------------------------------------------------------

  interface ExtraProfilePlan {
    profile: string;
    file: string;
    before: string | undefined;
    after: string;
    inserted: string;
    needsWrite: boolean;
  }

  interface Computed {
    plan: AgentAppConnectPlan;
    before: string | undefined;
    after: string;
    inserted?: string;
    extraProfiles?: ExtraProfilePlan[];
    file: string;
    token?: string;
    needsWrite: boolean;
  }

  async function compute(app: AgentAppId, options: AgentAppConnectOptions, real: { token: string } | undefined): Promise<Computed> {
    const label = LABELS[app];
    const file = configPath(app);
    const detected = await detect(app);
    const warnings: string[] = [];
    const base: AgentAppConnectPlan = {
      app, supported: isSupported(app), installed: detected.installed, ...(detected.version ? { version: detected.version, versionVerified: Boolean(detected.verified) } : {}),
      configPath: file, changes: false, diff: '', events: [], needsTrust: false, warnings, backupRoot: path.join(connectDirectory, 'backups', app),
      forwarderPath: forwarder, port: options.port ?? DEFAULT_HOOK_PORT, restartHint: '',
    };
    if (!isSupported(app)) {
      warnings.push(`${label} hooks arrive in a later release.`);
      return { plan: base, before: undefined, after: '', file, needsWrite: false };
    }
    if (!detected.installed) warnings.push(`${label} was not found on PATH or in ${displayPath(path.dirname(file), ctx.homeDirectory)}. Hooks are written anyway and work once ${label} is installed.`);
    if (detected.version && !detected.verified) warnings.push(`${label} ${detected.version} was not verified; hooks were tested with ${VERIFIED_VERSIONS[app].text}.`);
    if (ctx.platform === 'win32' && app !== 'hermes') warnings.push('Windows command quoting for hooks is untested.');

    const before = await readTextSafe(file);
    const fwd = await forwarderStatus(ctx.extaliaHome);
    const existingToken = await readToken(ctx.extaliaHome);
    const tokenForPlan = real?.token ?? (options.rotate ? NEW_TOKEN : existingToken ?? NEW_TOKEN);
    const tokenChanges = !existingToken || Boolean(options.rotate);
    let after: string, inserted: string | undefined, events: string[];
    const extraProfiles: ExtraProfilePlan[] = [];

    if (app === 'claude') {
      const existing = existingClaudeEntries(before, file);
      const { port, hostRunning } = await resolvePort(options, existing.port);
      base.port = port;
      if (!hostRunning) warnings.push(`No Extalia host is running, so port ${port} is a guess; Claude Code hooks keep this port until you connect again with --port.`);
      const command = (await commandValid(existing.command)) ? (existing.command as string) : claudeCommand(ctx.nodePath, forwarder, ctx.platform);
      const desired: ClaudeDesired = { port, token: tokenForPlan, command };
      const planned = planClaudeSettings(before, file, desired);
      after = planned.after; events = planned.events;
      const inspected = inspectClaudeSettings(before, file, { ...desired, port });
      if (inspected.disableAllHooks) warnings.push('Claude Code settings have disableAllHooks set, so hooks will not run until you remove it.');
      if (inspected.allowManagedHooksOnly) warnings.push('Claude Code settings allow managed hooks only, so Extalia hooks will not run.');
      warnings.push(...(await claudeWarnings()));
      if (before !== undefined && before.trim() && wouldReformat(before)) warnings.push('The settings file is formatted differently from standard JSON output, so its layout will be normalised (content and key order stay the same).');
      base.restartHint = 'Restart Claude Code (or open /hooks in a running session) so it loads the new hooks.';
    } else if (app === 'gemini') {
      const existing = existingGeminiCommand(before, file);
      const command = (await commandValid(existing)) ? (existing as string) : geminiCommand(ctx.nodePath, forwarder, ctx.platform);
      const desired: GeminiDesired = { command };
      const planned = planGeminiSettings(before, file, desired);
      after = planned.after; events = planned.events;
      if (before !== undefined && before.trim() && wouldReformat(before)) warnings.push('The settings file is formatted differently from standard JSON output, so its layout will be normalised (content and key order stay the same).');
      const { port } = await resolvePort(options, undefined);
      base.port = port;
      base.restartHint = 'Restart Gemini CLI so it loads the new hooks.';
    } else if (app === 'antigravity') {
      const existing = existingAntigravityCommand(before, file);
      const command = (await commandValid(existing)) ? (existing as string) : antigravityCommand(ctx.nodePath, forwarder, ctx.platform);
      const desired: AntigravityDesired = { command };
      const planned = planAntigravityHooks(before, file, desired);
      after = planned.after; events = planned.events;
      if (before !== undefined && before.trim() && wouldReformat(before)) warnings.push('The hooks file is formatted differently from standard JSON output, so its layout will be normalised (content and key order stay the same).');
      const { port } = await resolvePort(options, undefined);
      base.port = port;
      base.restartHint = 'Restart Antigravity (or start a new conversation) so it loads the new hooks.';
    } else if (app === 'hermes') {
      const existingPort = existingHermesPort(before, file);
      const { port, hostRunning } = await resolvePort(options, existingPort);
      base.port = port;
      if (!hostRunning) warnings.push(`No Extalia host is running, so port ${port} is a guess; Hermes webhooks keep this port until you connect again with --port.`);
      const planned = planHermesConfig(before, file, { port, token: tokenForPlan });
      after = planned.after; inserted = planned.inserted; events = planned.events;
      for (const extra of await extraHermesProfileConfigs(file)) {
        const extraBefore = await readTextSafe(extra.file);
        const extraPlanned = planHermesConfig(extraBefore, extra.file, { port, token: tokenForPlan });
        extraProfiles.push({
          profile: extra.profile,
          file: extra.file,
          before: extraBefore,
          after: extraPlanned.after,
          inserted: extraPlanned.inserted,
          needsWrite: extraPlanned.after !== (extraBefore ?? '') || extraBefore === undefined,
        });
      }
      base.restartHint = 'Restart running Hermes sessions so they load the outbound webhook configuration.';
    } else {
      const existing = existingCodexCommand(before, file);
      const command = (await commandValid(existing)) ? (existing as string) : codexCommand(ctx.nodePath, forwarder, ctx.platform);
      const desired: CodexDesired = { command };
      const planned = planCodexConfig(before, file, desired);
      after = planned.after; inserted = planned.inserted; events = planned.events;
      base.needsTrust = events.length > 0 || (await codexTrust(detected.bin)).status !== 'trusted';
      base.trustHint = detected.bin
        ? 'Codex runs hooks only after they are approved: open Codex, run /hooks and approve the Extalia hooks. Or connect with --trust to approve them from here.'
        : 'Codex runs hooks only after they are approved: open Codex, run /hooks and approve the Extalia hooks.';
      const { port } = await resolvePort(options, undefined);
      base.port = port;
      base.restartHint = 'Restart Codex so it loads the new hooks, then open /hooks and approve the Extalia hooks.';
    }

    const display = (text: string | undefined) => (text ?? '').replace(/[0-9a-f]{64}/g, MASK);
    const diffs = [
      unifiedDiff(display(before), display(after), {
        from: before === undefined ? '/dev/null' : displayPath(file, ctx.homeDirectory), to: displayPath(file, ctx.homeDirectory),
      }),
      ...extraProfiles.map(extra => unifiedDiff(display(extra.before), display(extra.after), {
        from: extra.before === undefined ? '/dev/null' : displayPath(extra.file, ctx.homeDirectory), to: displayPath(extra.file, ctx.homeDirectory),
      })),
    ].filter(chunk => chunk.trim().length > 0);
    const diff = diffs.join('\n');
    const fileChanges = after !== (before ?? '') || before === undefined || extraProfiles.some(extra => extra.needsWrite);
    const needsForwarder = app !== 'hermes' && fwd !== 'current';
    base.events = events;
    base.diff = diff;
    base.changes = fileChanges || needsForwarder || tokenChanges;
    if (needsForwarder) warnings.push(`The forwarder script ${fwd === 'missing' ? 'will be installed' : 'will be updated'} at ${displayPath(forwarder, ctx.homeDirectory)}.`);
    if (!existingToken) warnings.push('A new ingest token will be created (kept only on this computer).');
    if (options.rotate && existingToken) warnings.push(app === 'claude' || app === 'hermes'
      ? 'The ingest token will be replaced; hooks of other connected apps that store the token (Claude Code, Hermes) must be connected again.'
      : 'The ingest token will be replaced; Claude Code or Hermes hooks, if connected, must be connected again.');
    return {
      plan: base,
      before,
      after,
      ...(inserted !== undefined ? { inserted } : {}),
      ...(extraProfiles.length ? { extraProfiles } : {}),
      file,
      ...(real ? { token: real.token } : {}),
      needsWrite: fileChanges,
    };
  }

  // ---- applying -----------------------------------------------------------------------------------------------------

  async function backupFile(app: AgentAppId, file: string, current: Buffer | undefined, subDir?: string): Promise<string> {
    const base = path.join(connectDirectory, 'backups', app, ...(subDir ? [subDir] : []), timestampForPath(now()));
    let directory = base;
    for (let suffix = 2; await dirExists(directory); suffix++) directory = `${base}-${suffix}`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (current) {
      await writeFile(path.join(directory, path.basename(file)), current, { mode: 0o600 });
    }
    await writeFile(path.join(directory, 'backup.json'), `${JSON.stringify({ app, path: file, existed: Boolean(current), sha256: current ? sha256(current) : null, createdAt: now().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return directory;
  }

  async function sendTest(app: AgentAppId): Promise<AgentAppTestResult> {
    const token = await readToken(ctx.extaliaHome);
    if (!token) return { ok: false, status: 'skipped', message: 'No ingest token yet; connect an app first.' };
    const endpoint = await readEndpoint(ctx.extaliaHome, ctx.alive);
    if (endpoint && !endpoint.alive) return { ok: false, status: 'host-down', message: 'No Extalia host is running. Start Extalia (Desktop or `extalia`) and test again.' };
    const port = endpoint?.port ?? DEFAULT_HOOK_PORT;
    const fetchImpl = ctx.fetch ?? globalThis.fetch;
    const body = JSON.stringify({ hook_event_name: 'ExtaliaConnectTest', session_id: 'extalia-connect-test', extalia_test: true, app });
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    if (app === 'hermes') headers['x-hermes-signature-256'] = hermesSignature(token, body);
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/api/hooks/${app}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(2500),
      });
      if (response.status >= 200 && response.status < 300) return { ok: true, status: 'delivered', message: `The host on port ${port} accepted the test event.` };
      if (response.status === 401 || response.status === 403) return { ok: false, status: 'rejected', message: 'The host rejected the ingest token. Restart the host, or connect again with --rotate.' };
      if (response.status === 404) return { ok: false, status: 'rejected', message: 'The host does not accept hook events yet. Update Extalia and restart it.' };
      return { ok: false, status: 'rejected', message: `The host answered ${response.status}.` };
    } catch {
      return { ok: false, status: 'host-down', message: `No Extalia host answered on port ${port}. Events are dropped until one is running; the app is not affected.` };
    }
  }

  async function apply(app: AgentAppId, options: AgentAppConnectOptions = {}): Promise<AgentAppConnectResult> {
    if (!isSupported(app)) throw new ConnectError(`${LABELS[app]} hooks arrive in a later release.`);
    const preview = await compute(app, options, undefined);
    const detected = await detect(app);
    const warnings = [...preview.plan.warnings];
    const { token } = await ensureToken(ctx.extaliaHome, Boolean(options.rotate));
    if (app !== 'hermes') await installForwarder(ctx.extaliaHome);
    const real = await compute(app, { ...options, rotate: false }, { token });
    const file = real.file;
    const target = await writableTarget(file);
    const manifest = await readManifest();
    let backupPath: string | undefined;
    let changed = false;

    if (real.needsWrite) {
      let current: Buffer | undefined;
      try { current = await readFile(target); } catch (error) { if (!isNotFound(error)) throw error; }
      if (current && current.toString('utf8') !== real.before) throw new ConnectError('The configuration changed while Extalia was preparing the update. Nothing was written; run the command again.');
      backupPath = await backupFile(app, file, current);
      await writeConfigFile(target, real.after);
      changed = true;

      const previous = manifest.apps[app];
      const profileRecords: ExtraProfileRecord[] = [];
      for (const extra of real.extraProfiles ?? []) {
        const extraTarget = await writableTarget(extra.file);
        let extraCurrent: Buffer | undefined;
        try { extraCurrent = await readFile(extraTarget); } catch (error) { if (!isNotFound(error)) throw error; }
        if (extraCurrent && extraCurrent.toString('utf8') !== extra.before) {
          throw new ConnectError('A profile configuration changed while Extalia was preparing the update.');
        }
        const prevExtra = previous?.profiles?.find(item => path.resolve(item.configPath) === path.resolve(extra.file));
        const extraBackup = await backupFile(app, extra.file, extraCurrent, `profile-${extra.profile}`);
        await writeConfigFile(extraTarget, extra.after);
        profileRecords.push({
          configPath: extra.file,
          original: prevExtra?.original ?? {
            existed: Boolean(extraCurrent),
            ...(extraCurrent ? { sha256: sha256(extraCurrent), backupFile: path.join(extraBackup, path.basename(extra.file)) } : {}),
            backupDir: extraBackup,
          },
          writtenSha256: sha256(extra.after),
          ...(extra.inserted ? { inserted: extra.inserted } : prevExtra?.inserted ? { inserted: prevExtra.inserted } : {}),
        });
      }

      const allEvents = app === 'claude'
        ? [...CLAUDE_EVENTS]
        : app === 'gemini'
          ? [...GEMINI_EVENTS]
          : app === 'antigravity'
            ? [...ANTIGRAVITY_EVENTS]
            : app === 'hermes'
              ? [...HERMES_EVENTS]
              : [...CODEX_EVENTS];

      manifest.apps[app] = {
        connectedAt: previous?.connectedAt ?? now().toISOString(),
        updatedAt: now().toISOString(),
        configPath: file,
        original: previous?.original ?? { existed: Boolean(current), ...(current ? { sha256: sha256(current), backupFile: path.join(backupPath, path.basename(file)) } : {}), backupDir: backupPath },
        lastBackupDir: backupPath,
        writtenSha256: sha256(real.after),
        ...(real.inserted ? { inserted: real.inserted } : previous?.inserted ? { inserted: previous.inserted } : {}),
        ...(profileRecords.length ? { profiles: profileRecords } : previous?.profiles ? { profiles: previous.profiles } : {}),
        trustedKeys: previous?.trustedKeys ?? [],
        events: allEvents,
      };
      await writeManifest(manifest);
    }

    let trust: { status: AgentAppTrustStatus; trusted: number; total: number } = { status: 'not-applicable', trusted: 0, total: 0 };
    if (app === 'codex') {
      if (options.trust && detected.bin) {
        try {
          const result = await withRpc(detected.bin, async rpc => {
            const hooks = await listExtaliaHooks(rpc, file, os.tmpdir());
            if (!hooks.length) throw new Error('Codex does not list the Extalia hooks yet.');
            const written = await trustExtaliaHooks(rpc, hooks);
            return { written, after: summarizeTrust(await listExtaliaHooks(rpc, file, os.tmpdir())) };
          });
          trust = result.after;
          const record = (await readManifest()).apps.codex;
          if (record) {
            const latest = await readManifest();
            const entry = latest.apps.codex as AppRecord;
            entry.trustedKeys = [...new Set([...entry.trustedKeys, ...result.written])];
            entry.writtenSha256 = sha256(await readFile(target));
            entry.updatedAt = now().toISOString();
            await writeManifest(latest);
          }
          if (trust.status !== 'trusted') warnings.push('Codex did not report the hooks as trusted after writing the trust records. Open /hooks in Codex to approve them.');
        } catch (error) {
          trust = await codexTrust(detected.bin);
          warnings.push(`Could not approve the hooks automatically (${error instanceof Error ? error.message : 'unknown error'}). Open Codex, run /hooks and approve the Extalia hooks.`);
        }
      } else {
        trust = await codexTrust(detected.bin);
        if (options.trust && !detected.bin) warnings.push('The codex command was not found, so the hooks cannot be approved from here. Open Codex, run /hooks and approve them.');
      }
    }

    await enableAutoWatchOnConnect(app);
    const test = await sendTest(app);
    return {
      app, changed, configPath: file, ...(backupPath ? { backupPath } : {}), undoCommand: undoCommand(app), trust, test,
      restartHint: real.plan.restartHint, warnings,
    };
  }

  /** Enable automatic transcript discovery for the connected app so sessions fall back gracefully when hooks have not fired yet. */
  async function enableAutoWatchOnConnect(app: AgentAppId): Promise<void> {
    try {
      const importer = await NativeImportService.create({ homeDirectory: ctx.homeDirectory, env: ctx.env });
      const sourceId = HOOK_SOURCE_IDS[app];
      const stateDir = path.join(ctx.extaliaHome, 'state');
      const settingsFile = path.join(stateDir, 'observer-discovery.json');
      const existing = (await readJson<Record<string, unknown> | undefined>(settingsFile, undefined).catch(() => undefined)) ?? {};
      const locations: Record<string, { enabledAt: string }> =
        existing.locations && typeof existing.locations === 'object' && !Array.isArray(existing.locations)
          ? { ...(existing.locations as Record<string, { enabledAt: string }>) }
          : {};
      const stamp = now().toISOString();
      let updated = false;
      for (const loc of importer.locations()) {
        if (loc.sourceId !== sourceId || !importer.autoWatchable(loc.id)) continue;
        if (loc.label.toLowerCase().includes('archived')) continue;
        if (!locations[loc.id]) {
          locations[loc.id] = { enabledAt: stamp };
          updated = true;
        }
      }
      if (updated) {
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        await writeJsonAtomic(settingsFile, {
          schema: 'extalia.observer-discovery.v1',
          ignored: existing.ignored && typeof existing.ignored === 'object' && !Array.isArray(existing.ignored) ? existing.ignored : {},
          ...(typeof existing.labelsOnly === 'boolean' ? { labelsOnly: existing.labelsOnly } : {}),
          ...(typeof existing.hermesDashboardUrl === 'string' ? { hermesDashboardUrl: existing.hermesDashboardUrl } : {}),
          ...(Array.isArray(existing.ignoreFolders) ? { ignoreFolders: existing.ignoreFolders } : {}),
          locations,
        }, { mode: 0o600 });
      }
    } catch { /* best-effort auto-watch registration */ }
  }

  async function disconnect(app: AgentAppId): Promise<AgentAppDisconnectResult> {
    if (!isSupported(app)) throw new ConnectError(`${LABELS[app]} hooks arrive in a later release.`);
    const manifest = await readManifest();
    const record = manifest.apps[app];
    const candidates = [...new Set([configPath(app), ...(record ? [record.configPath] : [])])];
    const warnings: string[] = [];
    let result: AgentAppDisconnectResult = { app, changed: false, restoredExactly: false, removed: 0, warnings };

    for (const file of candidates) {
      const target = await writableTarget(file);
      let current: Buffer;
      try { current = await readFile(target); } catch (error) { if (isNotFound(error)) continue; throw error; }
      const text = current.toString('utf8');
      const forThis = record && path.resolve(record.configPath) === path.resolve(file) ? record : undefined;

      // Untouched since Extalia wrote it: put the original bytes back.
      if (forThis && sha256(current) === forThis.writtenSha256) {
        if (!forThis.original.existed) {
          await rm(target, { force: true });
          result = { app, changed: true, configPath: file, restoredExactly: true, removed: forThis.events.length, warnings };
        } else if (forThis.original.backupFile) {
          const original = await readFile(forThis.original.backupFile);
          if (sha256(original) === forThis.original.sha256) {
            await writeConfigFile(target, original.toString('utf8'));
            result = { app, changed: true, configPath: file, restoredExactly: true, removed: forThis.events.length, warnings };
          }
        }
        if (result.changed) break;
      }

      // Edited since: remove only the marked entries.
      const out = app === 'claude'
        ? removeClaudeEntries(text, file)
        : app === 'gemini'
          ? removeGeminiEntries(text, file)
          : app === 'antigravity'
            ? removeAntigravityEntries(text, file)
            : app === 'hermes'
              ? removeHermesBlock(text, forThis?.inserted)
              : (() => {
                  const block = removeCodexBlock(text, forThis?.inserted);
                  let rem = block.removed ? CODEX_EVENTS.length : 0;
                  const keys = new Set(forThis?.trustedKeys ?? []);
                  const inspected = (() => { try { return inspectCodexConfig(text, file, { command: '' }); } catch { return undefined; } })();
                  for (const entry of inspected?.trustRecords ?? []) keys.add(entry.key);
                  const trust = removeTrustTables(block.after, [...keys]);
                  rem += trust.removed;
                  if (inspected?.outsideBlock && !block.removed) warnings.push('Extalia hooks were found outside the managed block; remove them by hand.');
                  return { after: trust.after, removed: rem };
                })();
      const after = out.after;
      const removed = out.removed;
      if (removed && after !== text) {
        await backupFile(app, file, current);
        await writeConfigFile(target, after);
        result = { app, changed: true, configPath: file, restoredExactly: false, removed, warnings };
        break;
      }
    }

    if (app === 'hermes') {
      const extraCandidates = new Map<string, ExtraProfileRecord | undefined>();
      for (const extra of record?.profiles ?? []) extraCandidates.set(path.resolve(extra.configPath), extra);
      for (const extra of await extraHermesProfileConfigs(configPath('hermes'))) {
        if (!extraCandidates.has(path.resolve(extra.file))) extraCandidates.set(path.resolve(extra.file), undefined);
      }
      for (const [resolvedPath, profileRecord] of extraCandidates) {
        const extraFile = profileRecord?.configPath ?? resolvedPath;
        const extraTarget = await writableTarget(extraFile);
        let extraCurrent: Buffer;
        try { extraCurrent = await readFile(extraTarget); } catch (error) { if (isNotFound(error)) continue; throw error; }
        if (profileRecord && sha256(extraCurrent) === profileRecord.writtenSha256) {
          if (!profileRecord.original.existed) {
            await rm(extraTarget, { force: true });
            continue;
          }
          if (profileRecord.original.backupFile) {
            const orig = await readFile(profileRecord.original.backupFile);
            if (sha256(orig) === profileRecord.original.sha256) {
              await writeConfigFile(extraTarget, orig.toString('utf8'));
              continue;
            }
          }
        }
        const extraText = extraCurrent.toString('utf8');
        const removedExtra = removeHermesBlock(extraText, profileRecord?.inserted);
        if (removedExtra.removed && removedExtra.after !== extraText) {
          await writeConfigFile(extraTarget, removedExtra.after);
        }
      }
    }

    if (record) {
      delete manifest.apps[app];
      await writeManifest(manifest);
    }
    return result;
  }

  return {
    async connections() { return Promise.all((['codex', 'claude', 'gemini', 'antigravity', 'hermes'] as const).map(describe)); },
    async plan(app, options = {}) { return (await compute(app, options, undefined)).plan; },
    apply,
    disconnect,
    test: sendTest,
  };
}

async function readTextSafe(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (isNotFound(error)) return undefined; throw error; }
}

async function dirExists(directory: string): Promise<boolean> {
  return stat(directory).then(info => info.isDirectory(), () => false);
}
