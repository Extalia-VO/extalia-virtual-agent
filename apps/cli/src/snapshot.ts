import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  OWNED_DATA_RESTORE_CONFLICT_POLICIES,
  OWNED_DATA_SNAPSHOT_SECTIONS,
  normalizeOwnedDataBackupId,
  normalizeOwnedDataSnapshotSelection,
  verifyOwnedDataSnapshotIntegrity,
  type ApplyOwnedDataRestoreInput,
  type OwnedDataBackupSummary,
  type OwnedDataRestoreApplyResult,
  type OwnedDataRestoreConflict,
  type OwnedDataRestoreConflictPolicy,
  type OwnedDataRestorePreview,
  type OwnedDataSnapshotExportResult,
  type OwnedDataSnapshotSelection,
  type RollbackOwnedDataRestoreResult,
} from '@extalia/core';
import { createAgentHost } from '@extalia/host';
import { resolveDataDirectory } from '@extalia/platform';
import { TOKEN_HEADER } from './bridge/server';
import type { CliHost } from './cli';

export const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
export const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

const SNAPSHOT_USAGE = `Usage: extalia snapshot <subcommand> [options]

Subcommands:
  export [--sections <csv>] [--workspace <id>] [--session <id>] [--mission <id>] [--out <file>] [--force] [--url <loopback-url> --token <token>] [--data-dir <dir>] [--json]
  verify <file> [--json]
  preview-restore <file> [--url <loopback-url> --token <token>] [--data-dir <dir>] [--json]
  restore <file> [--on-collision fail-on-collision|skip-existing] --yes [--url <loopback-url> --token <token>] [--data-dir <dir>] [--json]
  backups [--url <loopback-url> --token <token>] [--data-dir <dir>] [--json]
  rollback <backupId> --yes [--url <loopback-url> --token <token>] [--data-dir <dir>] [--json]`;

export type SnapshotCliHost = CliHost & {
  fetch?: typeof fetch;
  dataDirectory?: string;
  createAgentHost?: typeof createAgentHost;
};

type SnapshotBridgeRpcMethod =
  | 'exportOwnedDataSnapshot'
  | 'previewOwnedDataRestore'
  | 'applyOwnedDataRestore'
  | 'listOwnedDataBackups'
  | 'rollbackOwnedDataRestore';

type ParsedSnapshotArgs =
  | { action: 'help' }
  | {
    action: 'export';
    selection: OwnedDataSnapshotSelection;
    outFile?: string;
    force: boolean;
    origin?: string;
    token?: string;
    dataDir?: string;
    json: boolean;
  }
  | {
    action: 'verify';
    file: string;
    json: boolean;
  }
  | {
    action: 'preview-restore';
    file: string;
    origin?: string;
    token?: string;
    dataDir?: string;
    json: boolean;
  }
  | {
    action: 'restore';
    file: string;
    conflictPolicy: OwnedDataRestoreConflictPolicy;
    yes: boolean;
    origin?: string;
    token?: string;
    dataDir?: string;
    json: boolean;
  }
  | {
    action: 'backups';
    origin?: string;
    token?: string;
    dataDir?: string;
    json: boolean;
  }
  | {
    action: 'rollback';
    backupId: string;
    yes: boolean;
    origin?: string;
    token?: string;
    dataDir?: string;
    json: boolean;
  };

/**
 * Validate a Bridge base URL for snapshot RPC calls.
 * Fail-closed: accepts only `http:` URLs targeting `127.0.0.1`, `localhost`, or `[::1]`
 * without credentials, query parameters, hash fragments, or non-root paths.
 */
export function parseLoopbackSnapshotBridgeUrl(raw: string): URL | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:') return undefined;
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) return undefined;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return undefined;
  return parsed;
}

function defaultCliHost(): SnapshotCliHost {
  return {
    version: '0.0.0',
    out: line => { process.stdout.write(`${line}\n`); },
    err: line => { process.stderr.write(`${line}\n`); },
    readFile: file => readFile(file, 'utf8'),
    exists: file => access(file).then(() => true, () => false),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    env: process.env,
    homeDirectory: homedir(),
    start: async () => 1,
    update: async () => 1,
  };
}

function splitFlag(arg: string): { flag: string; hasEquals: boolean; inlineValue?: string } {
  const equals = arg.indexOf('=');
  if (equals > 0) {
    return { flag: arg.slice(0, equals), hasEquals: true, inlineValue: arg.slice(equals + 1) };
  }
  return { flag: arg, hasEquals: false };
}

function readSingleValue(
  args: readonly string[],
  index: number,
  flag: string,
  hasEquals: boolean,
  inlineValue: string | undefined,
  seen: Set<string>,
): { value: string; nextIndex: number } | { error: string } {
  if (seen.has(flag)) return { error: `Duplicate option: ${flag}` };
  seen.add(flag);
  if (hasEquals) return { value: inlineValue ?? '', nextIndex: index };
  if (index + 1 >= args.length) return { error: `Missing value for ${flag}` };
  return { value: args[index + 1] as string, nextIndex: index + 1 };
}

function readMultiValue(
  args: readonly string[],
  index: number,
  flag: string,
  hasEquals: boolean,
  inlineValue: string | undefined,
  target: string[],
): { nextIndex: number } | { error: string } {
  const value = hasEquals ? inlineValue : args[index + 1];
  if (value === undefined) return { error: `Missing value for ${flag}` };
  const trimmed = value.trim();
  if (!trimmed) return { error: `${flag} must not be empty.` };
  target.push(trimmed);
  return { nextIndex: hasEquals ? index : index + 1 };
}

function resolveBridgeConnection(
  rawUrl: string | undefined,
  rawToken: string | undefined,
  rawDataDir: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { origin?: string; token?: string; dataDir?: string } | { error: string } {
  const envUrl = env.EXTALIA_BRIDGE_URL?.trim();
  const effectiveUrl = rawUrl !== undefined ? rawUrl : envUrl || undefined;
  const envToken = env.EXTALIA_BRIDGE_TOKEN?.trim();
  const effectiveToken = rawToken !== undefined ? rawToken : envToken || undefined;

  if (rawDataDir !== undefined && !rawDataDir.trim()) {
    return { error: '--data-dir must not be empty.' };
  }
  if (rawToken !== undefined && !rawToken.trim()) {
    return { error: '--token must not be empty.' };
  }
  if (rawToken !== undefined && effectiveUrl === undefined) {
    return { error: '--token requires --url or EXTALIA_BRIDGE_URL.' };
  }
  if (effectiveUrl !== undefined) {
    if (rawDataDir !== undefined) {
      return { error: '--url and --data-dir cannot be used together.' };
    }
    const parsed = parseLoopbackSnapshotBridgeUrl(effectiveUrl);
    if (!parsed) {
      return {
        error: '--url must be a loopback http://127.0.0.1:<port>, http://localhost:<port>, or http://[::1]:<port> URL.',
      };
    }
    if (!effectiveToken?.trim()) {
      return { error: '--token is required when using --url or EXTALIA_BRIDGE_URL.' };
    }
    return { origin: parsed.origin, token: effectiveToken };
  }

  return rawDataDir !== undefined ? { dataDir: rawDataDir.trim() } : {};
}

function parseExportArgs(
  rest: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedSnapshotArgs | string {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  const workspaceIds: string[] = [];
  const sessionIds: string[] = [];
  const missionIds: string[] = [];
  let force = false;
  let json = false;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if (flag === '--force' && !hasEquals) {
      if (force) return 'Duplicate option: --force';
      force = true;
      continue;
    }
    if (flag === '--json' && !hasEquals) {
      if (json) return 'Duplicate option: --json';
      json = true;
      continue;
    }
    if (flag === '--workspace') {
      const read = readMultiValue(rest, index, flag, hasEquals, inlineValue, workspaceIds);
      if ('error' in read) return read.error;
      index = read.nextIndex;
      continue;
    }
    if (flag === '--session') {
      const read = readMultiValue(rest, index, flag, hasEquals, inlineValue, sessionIds);
      if ('error' in read) return read.error;
      index = read.nextIndex;
      continue;
    }
    if (flag === '--mission') {
      const read = readMultiValue(rest, index, flag, hasEquals, inlineValue, missionIds);
      if ('error' in read) return read.error;
      index = read.nextIndex;
      continue;
    }
    if (['--sections', '--out', '--url', '--token', '--data-dir'].includes(flag)) {
      const read = readSingleValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return read.error;
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    return `Unknown option for snapshot export: ${arg}`;
  }

  const rawSections = values.get('--sections');
  const sections = rawSections === undefined
    ? [...OWNED_DATA_SNAPSHOT_SECTIONS]
    : rawSections.split(',').map(item => item.trim()).filter(Boolean);

  let selection: OwnedDataSnapshotSelection;
  try {
    selection = normalizeOwnedDataSnapshotSelection({
      sections,
      ...(workspaceIds.length > 0 ? { workspaceIds } : {}),
      ...(sessionIds.length > 0 ? { sessionIds } : {}),
      ...(missionIds.length > 0 ? { missionIds } : {}),
    });
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid snapshot export selection.';
  }

  const outFile = values.get('--out');
  if (outFile !== undefined && !outFile.trim()) {
    return '--out must not be empty.';
  }

  const connection = resolveBridgeConnection(
    values.get('--url'),
    values.get('--token'),
    values.get('--data-dir'),
    env,
  );
  if ('error' in connection) return connection.error;

  return {
    action: 'export',
    selection,
    ...(outFile !== undefined ? { outFile: outFile.trim() } : {}),
    force,
    ...(connection.origin !== undefined ? { origin: connection.origin } : {}),
    ...(connection.token !== undefined ? { token: connection.token } : {}),
    ...(connection.dataDir !== undefined ? { dataDir: connection.dataDir } : {}),
    json,
  };
}

function parseVerifyArgs(rest: readonly string[]): ParsedSnapshotArgs | string {
  let json = false;
  let file: string | undefined;

  for (const arg of rest) {
    const { flag, hasEquals } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if (flag === '--json' && !hasEquals) {
      if (json) return 'Duplicate option: --json';
      json = true;
      continue;
    }
    if (arg.startsWith('-')) return `Unknown option for snapshot verify: ${arg}`;
    if (file !== undefined) return `Unexpected argument for snapshot verify: ${arg}`;
    file = arg;
  }

  if (!file || !file.trim()) return `Missing <file>.\n\n${SNAPSHOT_USAGE}`;
  return { action: 'verify', file, json };
}

function parsePreviewRestoreArgs(
  rest: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedSnapshotArgs | string {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let json = false;
  let file: string | undefined;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if (flag === '--json' && !hasEquals) {
      if (json) return 'Duplicate option: --json';
      json = true;
      continue;
    }
    if (['--url', '--token', '--data-dir'].includes(flag)) {
      const read = readSingleValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return read.error;
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) return `Unknown option for snapshot preview-restore: ${arg}`;
    if (file !== undefined) return `Unexpected argument for snapshot preview-restore: ${arg}`;
    file = arg;
  }

  if (!file || !file.trim()) return `Missing <file>.\n\n${SNAPSHOT_USAGE}`;

  const connection = resolveBridgeConnection(
    values.get('--url'),
    values.get('--token'),
    values.get('--data-dir'),
    env,
  );
  if ('error' in connection) return connection.error;

  return {
    action: 'preview-restore',
    file,
    ...(connection.origin !== undefined ? { origin: connection.origin } : {}),
    ...(connection.token !== undefined ? { token: connection.token } : {}),
    ...(connection.dataDir !== undefined ? { dataDir: connection.dataDir } : {}),
    json,
  };
}

function parseRestoreArgs(
  rest: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedSnapshotArgs | string {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let yes = false;
  let json = false;
  let file: string | undefined;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if ((flag === '--yes' || flag === '-y') && !hasEquals) {
      if (yes) return 'Duplicate option: --yes';
      yes = true;
      continue;
    }
    if (flag === '--json' && !hasEquals) {
      if (json) return 'Duplicate option: --json';
      json = true;
      continue;
    }
    if (['--on-collision', '--url', '--token', '--data-dir'].includes(flag)) {
      const read = readSingleValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return read.error;
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) return `Unknown option for snapshot restore: ${arg}`;
    if (file !== undefined) return `Unexpected argument for snapshot restore: ${arg}`;
    file = arg;
  }

  if (!file || !file.trim()) return `Missing <file>.\n\n${SNAPSHOT_USAGE}`;

  const rawPolicy = values.get('--on-collision');
  let conflictPolicy: OwnedDataRestoreConflictPolicy = 'fail-on-collision';
  if (rawPolicy !== undefined) {
    const normalized = rawPolicy.trim();
    if (!(OWNED_DATA_RESTORE_CONFLICT_POLICIES as readonly string[]).includes(normalized)) {
      return `Invalid --on-collision policy "${rawPolicy}". Expected ${OWNED_DATA_RESTORE_CONFLICT_POLICIES.join(' or ')}.`;
    }
    conflictPolicy = normalized as OwnedDataRestoreConflictPolicy;
  }

  const connection = resolveBridgeConnection(
    values.get('--url'),
    values.get('--token'),
    values.get('--data-dir'),
    env,
  );
  if ('error' in connection) return connection.error;

  return {
    action: 'restore',
    file,
    conflictPolicy,
    yes,
    ...(connection.origin !== undefined ? { origin: connection.origin } : {}),
    ...(connection.token !== undefined ? { token: connection.token } : {}),
    ...(connection.dataDir !== undefined ? { dataDir: connection.dataDir } : {}),
    json,
  };
}

function parseBackupsArgs(
  rest: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedSnapshotArgs | string {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let json = false;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if (flag === '--json' && !hasEquals) {
      if (json) return 'Duplicate option: --json';
      json = true;
      continue;
    }
    if (['--url', '--token', '--data-dir'].includes(flag)) {
      const read = readSingleValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return read.error;
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) return `Unknown option for snapshot backups: ${arg}`;
    return `Unexpected argument for snapshot backups: ${arg}`;
  }

  const connection = resolveBridgeConnection(
    values.get('--url'),
    values.get('--token'),
    values.get('--data-dir'),
    env,
  );
  if ('error' in connection) return connection.error;

  return {
    action: 'backups',
    ...(connection.origin !== undefined ? { origin: connection.origin } : {}),
    ...(connection.token !== undefined ? { token: connection.token } : {}),
    ...(connection.dataDir !== undefined ? { dataDir: connection.dataDir } : {}),
    json,
  };
}

function parseRollbackArgs(
  rest: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedSnapshotArgs | string {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let yes = false;
  let json = false;
  let rawBackupId: string | undefined;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if ((flag === '--yes' || flag === '-y') && !hasEquals) {
      if (yes) return 'Duplicate option: --yes';
      yes = true;
      continue;
    }
    if (flag === '--json' && !hasEquals) {
      if (json) return 'Duplicate option: --json';
      json = true;
      continue;
    }
    if (['--url', '--token', '--data-dir'].includes(flag)) {
      const read = readSingleValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return read.error;
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) return `Unknown option for snapshot rollback: ${arg}`;
    if (rawBackupId !== undefined) return `Unexpected argument for snapshot rollback: ${arg}`;
    rawBackupId = arg;
  }

  if (!rawBackupId || !rawBackupId.trim()) return `Missing <backupId>.\n\n${SNAPSHOT_USAGE}`;

  let backupId: string;
  try {
    backupId = normalizeOwnedDataBackupId(rawBackupId);
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid backupId.';
  }

  const connection = resolveBridgeConnection(
    values.get('--url'),
    values.get('--token'),
    values.get('--data-dir'),
    env,
  );
  if ('error' in connection) return connection.error;

  return {
    action: 'rollback',
    backupId,
    yes,
    ...(connection.origin !== undefined ? { origin: connection.origin } : {}),
    ...(connection.token !== undefined ? { token: connection.token } : {}),
    ...(connection.dataDir !== undefined ? { dataDir: connection.dataDir } : {}),
    json,
  };
}

function parseSnapshotArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedSnapshotArgs | string {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return SNAPSHOT_USAGE;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    return { action: 'help' };
  }
  if (subcommand === 'export') return parseExportArgs(rest, env);
  if (subcommand === 'verify') return parseVerifyArgs(rest);
  if (subcommand === 'preview-restore') return parsePreviewRestoreArgs(rest, env);
  if (subcommand === 'restore') return parseRestoreArgs(rest, env);
  if (subcommand === 'backups') return parseBackupsArgs(rest, env);
  if (subcommand === 'rollback') return parseRollbackArgs(rest, env);
  return `Unknown subcommand: ${subcommand}\n\n${SNAPSHOT_USAGE}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

async function readBoundedSnapshotFile(file: string): Promise<{ path: string; text: string } | { error: string }> {
  const resolved = path.resolve(file);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolved);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `Cannot read snapshot file ${resolved}: ${detail}` };
  }
  if (!info.isFile()) {
    return { error: `Snapshot path is not a regular file: ${resolved}` };
  }
  if (info.size === 0) {
    return { error: `Snapshot archive file is empty: ${resolved}` };
  }
  if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
    return {
      error: `Snapshot archive exceeds maximum size of ${MAX_SNAPSHOT_FILE_BYTES} bytes (${info.size} bytes): ${resolved}`,
    };
  }
  const text = await readFile(resolved, 'utf8');
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (!text.trim() || byteLength === 0) {
    return { error: `Snapshot archive file is empty: ${resolved}` };
  }
  if (byteLength > MAX_SNAPSHOT_FILE_BYTES) {
    return {
      error: `Snapshot archive exceeds maximum size of ${MAX_SNAPSHOT_FILE_BYTES} bytes (${byteLength} bytes): ${resolved}`,
    };
  }
  return { path: resolved, text };
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function writePrivateFileAtomic(targetPath: string, content: string, force: boolean): Promise<void> {
  if (!force && (await pathExists(targetPath))) {
    throw new Error(`Refusing to overwrite existing file ${targetPath} (pass --force to overwrite).`);
  }
  const directory = path.dirname(targetPath);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const handle = await open(tempPath, 'wx', PRIVATE_FILE_MODE);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') {
      await chmod(tempPath, PRIVATE_FILE_MODE);
    }
    if (!force && (await pathExists(targetPath))) {
      throw new Error(`Refusing to overwrite existing file ${targetPath} (pass --force to overwrite).`);
    }
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function callBridgeRpc<T>(
  origin: string,
  token: string,
  method: SnapshotBridgeRpcMethod,
  args: unknown[],
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/api/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify({ method, args }),
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : String(error);
    throw new Error(`Could not reach Bridge at ${origin}: ${detail}`, { cause: error });
  }

  const parsed = (await response.json().catch(() => undefined)) as { result?: T; error?: unknown } | undefined;
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && typeof parsed.error === 'string'
      ? parsed.error
      : `Bridge request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }
  if (!parsed || typeof parsed !== 'object' || !('result' in parsed) || parsed.result === undefined || parsed.result === null) {
    throw new Error(`Bridge returned an invalid response for ${method}.`);
  }
  return parsed.result;
}

function resolveSnapshotDataDirectory(host: SnapshotCliHost, explicitDataDir?: string): string {
  if (explicitDataDir) return path.resolve(explicitDataDir);
  if (host.dataDirectory) return path.resolve(host.dataDirectory);
  return resolveDataDirectory({
    platform: host.platform,
    env: host.env,
    homeDirectory: host.homeDirectory,
  });
}

async function withLocalAgentHost<T>(
  host: SnapshotCliHost,
  explicitDataDir: string | undefined,
  action: (api: Awaited<ReturnType<typeof createAgentHost>>['host']) => Promise<T>,
): Promise<T> {
  const dataDirectory = resolveSnapshotDataDirectory(host, explicitDataDir);
  const makeHost = host.createAgentHost ?? createAgentHost;
  const runtime = await makeHost({
    kind: 'bridge',
    version: host.version,
    dataDirectory,
    homeDirectory: host.homeDirectory,
    env: host.env,
    ...(host.fetch ? { fetch: host.fetch } : {}),
  });
  try {
    return await action(runtime.host);
  } finally {
    await runtime.close();
  }
}

function formatConflictLine(conflict: OwnedDataRestoreConflict): string {
  const scope = conflict.section
    ? ` (${conflict.section}${conflict.id ? `:${conflict.id}` : ''})`
    : '';
  return `  - [${conflict.kind}]${scope}: ${conflict.detail}`;
}

async function handleExport(
  host: SnapshotCliHost,
  parsed: Extract<ParsedSnapshotArgs, { action: 'export' }>,
): Promise<number> {
  const outPath = parsed.outFile ? path.resolve(parsed.outFile) : undefined;
  if (outPath && !parsed.force && (await pathExists(outPath))) {
    host.err(`snapshot export: Refusing to overwrite existing file ${outPath} (pass --force to overwrite).`);
    return 1;
  }

  let result: OwnedDataSnapshotExportResult;
  if (parsed.origin && parsed.token) {
    result = await callBridgeRpc<OwnedDataSnapshotExportResult>(
      parsed.origin,
      parsed.token,
      'exportOwnedDataSnapshot',
      [parsed.selection],
      host.fetch ?? globalThis.fetch,
    );
  } else {
    result = await withLocalAgentHost(host, parsed.dataDir, async api => {
      if (typeof api.exportOwnedDataSnapshot !== 'function') {
        throw new Error('This host does not support owned-data snapshot export.');
      }
      return api.exportOwnedDataSnapshot(parsed.selection);
    });
  }

  if (outPath) {
    await writePrivateFileAtomic(outPath, result.bundleJson, parsed.force);
    if (parsed.json) {
      host.out(JSON.stringify({
        outFile: outPath,
        sha256: result.sha256,
        byteLength: result.byteLength,
        entryCount: result.bundle.manifest.entryCount,
        omittedSecretFields: result.omittedSecretFields,
        format: result.bundle.manifest.format,
        schemaVersion: result.bundle.manifest.schemaVersion,
      }, null, 2));
    } else {
      host.out(`Exported owned-data snapshot to ${outPath}`);
      host.out(`SHA-256:               ${result.sha256}`);
      host.out(`Entries:               ${result.bundle.manifest.entryCount}`);
      host.out(`Omitted secret fields: ${result.omittedSecretFields}`);
    }
    return 0;
  }

  if (parsed.json) {
    host.out(JSON.stringify(result, null, 2));
  } else {
    host.out(result.bundleJson);
  }
  return 0;
}

async function handleVerify(
  host: SnapshotCliHost,
  parsed: Extract<ParsedSnapshotArgs, { action: 'verify' }>,
): Promise<number> {
  const read = await readBoundedSnapshotFile(parsed.file);
  if ('error' in read) {
    if (parsed.json) {
      host.out(JSON.stringify({
        ok: false,
        file: path.resolve(parsed.file),
        checksumVerified: false,
        secretFreeVerified: false,
        conflicts: [{ kind: 'corrupt-archive', detail: read.error }],
      }, null, 2));
    } else {
      host.err(`snapshot verify: ${read.error}`);
    }
    return 1;
  }

  const verification = verifyOwnedDataSnapshotIntegrity(read.text, sha256Hex);
  const entryCount = verification.bundle?.manifest.entryCount ?? 0;

  if (parsed.json) {
    host.out(JSON.stringify({
      ok: verification.ok,
      file: read.path,
      ...(verification.schemaVersion !== undefined ? { schemaVersion: verification.schemaVersion } : {}),
      entryCount,
      checksumVerified: verification.checksumVerified,
      secretFreeVerified: verification.secretFreeVerified,
      conflicts: verification.conflicts,
    }, null, 2));
    return verification.ok ? 0 : 1;
  }

  if (verification.ok) {
    host.out(
      `Snapshot verified: ${read.path} (schema v${verification.schemaVersion}, ${entryCount} entries, checksumVerified=${verification.checksumVerified}, secretFreeVerified=${verification.secretFreeVerified})`,
    );
    return 0;
  }

  host.err(`Snapshot verification failed (${verification.conflicts.length} conflict(s)):`);
  for (const conflict of verification.conflicts) {
    host.err(formatConflictLine(conflict));
  }
  return 1;
}

async function handlePreviewRestore(
  host: SnapshotCliHost,
  parsed: Extract<ParsedSnapshotArgs, { action: 'preview-restore' }>,
): Promise<number> {
  const read = await readBoundedSnapshotFile(parsed.file);
  if ('error' in read) {
    host.err(`snapshot preview-restore: ${read.error}`);
    return 1;
  }

  let preview: OwnedDataRestorePreview;
  if (parsed.origin && parsed.token) {
    preview = await callBridgeRpc<OwnedDataRestorePreview>(
      parsed.origin,
      parsed.token,
      'previewOwnedDataRestore',
      [read.text],
      host.fetch ?? globalThis.fetch,
    );
  } else {
    preview = await withLocalAgentHost(host, parsed.dataDir, async api => {
      if (typeof api.previewOwnedDataRestore !== 'function') {
        throw new Error('This host does not support owned-data snapshot restore previews.');
      }
      return api.previewOwnedDataRestore(read.text);
    });
  }

  if (parsed.json) {
    host.out(JSON.stringify(preview, null, 2));
  } else {
    host.out(`Restore preview (dryRunOnly=${preview.dryRunOnly}): ${preview.valid ? 'VALID' : 'BLOCKED'}`);
    host.out(`Entries:              ${preview.entryCount} (wouldAdd=${preview.wouldAdd}, wouldCollide=${preview.wouldCollide})`);
    host.out(`Checksum verified:    ${preview.checksumVerified}`);
    host.out(`Secret-free verified: ${preview.secretFreeVerified}`);
    if (preview.warnings.length > 0) {
      host.out(`Warnings (${preview.warnings.length}):`);
      for (const warning of preview.warnings) {
        host.out(`  - ${warning}`);
      }
    }
    if (preview.conflicts.length > 0) {
      const writeLine = preview.valid ? host.out : host.err;
      writeLine(`Conflicts (${preview.conflicts.length}):`);
      for (const conflict of preview.conflicts) {
        writeLine(formatConflictLine(conflict));
      }
    }
  }

  return preview.valid ? 0 : 1;
}

async function handleRestore(
  host: SnapshotCliHost,
  parsed: Extract<ParsedSnapshotArgs, { action: 'restore' }>,
): Promise<number> {
  if (!parsed.yes) {
    const message = 'Refusing to apply owned-data restore without --yes (required to confirm pre-restore backup and restore apply; use preview-restore for a dry-run).';
    if (parsed.json) {
      host.out(JSON.stringify({
        ok: false,
        code: 'confirmation-required',
        rolledBack: false,
        conflicts: [],
        detail: message,
      } satisfies OwnedDataRestoreApplyResult, null, 2));
    } else {
      host.err(`snapshot restore: ${message}`);
    }
    return 1;
  }

  const read = await readBoundedSnapshotFile(parsed.file);
  if ('error' in read) {
    if (parsed.json) {
      host.out(JSON.stringify({
        ok: false,
        code: 'corrupt-archive',
        rolledBack: false,
        conflicts: [{ kind: 'corrupt-archive', detail: read.error }],
        detail: read.error,
      } satisfies OwnedDataRestoreApplyResult, null, 2));
    } else {
      host.err(`snapshot restore: ${read.error}`);
    }
    return 1;
  }

  const input: ApplyOwnedDataRestoreInput = {
    bundleJson: read.text,
    expectedBundleSha256: sha256Hex(read.text),
    conflictPolicy: parsed.conflictPolicy,
    confirmBackup: true,
  };

  let result: OwnedDataRestoreApplyResult;
  if (parsed.origin && parsed.token) {
    result = await callBridgeRpc<OwnedDataRestoreApplyResult>(
      parsed.origin,
      parsed.token,
      'applyOwnedDataRestore',
      [input],
      host.fetch ?? globalThis.fetch,
    );
  } else {
    result = await withLocalAgentHost(host, parsed.dataDir, async api => {
      if (typeof api.applyOwnedDataRestore !== 'function') {
        throw new Error('This host does not support owned-data snapshot restore.');
      }
      return api.applyOwnedDataRestore(input);
    });
  }

  if (parsed.json) {
    host.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    host.out(`Restored owned-data snapshot from ${read.path}`);
    host.out(`Pre-restore backup: ${result.backupId}`);
    host.out(`Applied entries:    ${result.appliedCount}`);
    host.out(`Skipped entries:    ${result.skippedCount}`);
    host.out(`Bundle SHA-256:     ${result.bundleSha256}`);
    if (result.warnings.length > 0) {
      host.out(`Warnings (${result.warnings.length}):`);
      for (const warning of result.warnings) {
        host.out(`  - ${warning}`);
      }
    }
    return 0;
  }

  host.err(`Snapshot restore failed (${result.code}): ${result.detail}`);
  host.err(`Rolled back: ${result.rolledBack}`);
  if (result.backupId) {
    host.err(`Backup ID:   ${result.backupId}`);
  }
  if (result.conflicts.length > 0) {
    host.err(`Conflicts (${result.conflicts.length}):`);
    for (const conflict of result.conflicts) {
      host.err(formatConflictLine(conflict));
    }
  }
  return 1;
}

async function handleBackups(
  host: SnapshotCliHost,
  parsed: Extract<ParsedSnapshotArgs, { action: 'backups' }>,
): Promise<number> {
  let backups: OwnedDataBackupSummary[];
  if (parsed.origin && parsed.token) {
    backups = await callBridgeRpc<OwnedDataBackupSummary[]>(
      parsed.origin,
      parsed.token,
      'listOwnedDataBackups',
      [],
      host.fetch ?? globalThis.fetch,
    );
  } else {
    backups = await withLocalAgentHost(host, parsed.dataDir, async api => {
      if (typeof api.listOwnedDataBackups !== 'function') {
        throw new Error('This host does not support listing owned-data backups.');
      }
      return api.listOwnedDataBackups();
    });
  }

  if (parsed.json) {
    host.out(JSON.stringify(backups, null, 2));
    return 0;
  }

  if (backups.length === 0) {
    host.out('No pre-restore backups found.');
    return 0;
  }

  host.out(`Pre-restore backups (${backups.length}):`);
  for (const backup of backups) {
    const shortSha = backup.sourceBundleSha256.slice(0, 12);
    host.out(
      `  - ${backup.backupId}  createdAt=${backup.createdAt}  files=${backup.fileCount}  sourceSha256=${shortSha}`,
    );
  }
  return 0;
}

async function handleRollback(
  host: SnapshotCliHost,
  parsed: Extract<ParsedSnapshotArgs, { action: 'rollback' }>,
): Promise<number> {
  if (!parsed.yes) {
    const message = `Refusing to roll back backup ${parsed.backupId} without --yes (required to confirm restoring pre-restore backup).`;
    if (parsed.json) {
      host.out(JSON.stringify({
        ok: false,
        backupId: parsed.backupId,
        detail: message,
      } satisfies RollbackOwnedDataRestoreResult, null, 2));
    } else {
      host.err(`snapshot rollback: ${message}`);
    }
    return 1;
  }

  let result: RollbackOwnedDataRestoreResult;
  if (parsed.origin && parsed.token) {
    result = await callBridgeRpc<RollbackOwnedDataRestoreResult>(
      parsed.origin,
      parsed.token,
      'rollbackOwnedDataRestore',
      [parsed.backupId],
      host.fetch ?? globalThis.fetch,
    );
  } else {
    result = await withLocalAgentHost(host, parsed.dataDir, async api => {
      if (typeof api.rollbackOwnedDataRestore !== 'function') {
        throw new Error('This host does not support owned-data backup rollback.');
      }
      return api.rollbackOwnedDataRestore(parsed.backupId);
    });
  }

  if (parsed.json) {
    host.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (result.ok) {
    host.out(`Rolled back owned-data state to backup ${result.backupId}`);
    host.out(`Restored files: ${result.restoredFiles}`);
    host.out(`Removed files:  ${result.removedFiles}`);
    host.out(result.detail);
    return 0;
  }

  host.err(`Snapshot rollback failed (${result.backupId}): ${result.detail}`);
  return 1;
}

/** Run `extalia snapshot <export|verify|preview-restore|restore|backups|rollback>` and return the process exit code. */
export async function runSnapshot(
  argv: readonly string[],
  host: SnapshotCliHost = defaultCliHost(),
): Promise<number> {
  const parsed = parseSnapshotArgs(argv, host.env);
  if (typeof parsed === 'string') {
    host.err(`snapshot: ${parsed}`);
    return 1;
  }
  if (parsed.action === 'help') {
    host.out(SNAPSHOT_USAGE);
    return 0;
  }

  try {
    if (parsed.action === 'export') return await handleExport(host, parsed);
    if (parsed.action === 'verify') return await handleVerify(host, parsed);
    if (parsed.action === 'preview-restore') return await handlePreviewRestore(host, parsed);
    if (parsed.action === 'restore') return await handleRestore(host, parsed);
    if (parsed.action === 'backups') return await handleBackups(host, parsed);
    return await handleRollback(host, parsed);
  } catch (error) {
    host.err(`snapshot ${parsed.action}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
