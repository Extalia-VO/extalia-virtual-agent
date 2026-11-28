import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createAgentHost } from '@extalia/host';
import {
  normalizeGrantMissionWaiverInput,
  normalizeMissionReconciliationCommitInput,
  normalizeWaiverId,
  resolveDataDirectory,
  type GrantMissionWaiverInput,
  type MissionAuthorityHostMethod,
  type MissionAuthorityOverview,
  type MissionReconciliationCommitInput,
  type MissionReconciliationCommitResult,
  type MissionReconciliationPreview,
  type MissionTaskGateEvaluation,
} from '@extalia/platform';
import { TOKEN_HEADER } from './bridge/server';
import type { CliHost } from './cli';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CONTROL_CHAR_PATTERN = /\p{Cc}/u;

export const MISSION_USAGE = `Usage: extalia mission <action> [options]

Actions:
  reconcile-preview --session <id> --mission <id> [--url <loopback> --token <tok>] [--data-dir <dir>] [--json]
  reconcile-commit --session <id> --mission <id> --digest <sha256> --decision <mark-failed|mark-cancelled|retain-quarantine> --actor <name> --reason <text> [--key <decisionKey>] [--url <loopback> --token <tok>] [--data-dir <dir>] [--json]
  evidence --session <id> --mission <id> [--url <loopback> --token <tok>] [--data-dir <dir>] [--json]
  waive --session <id> --mission <id> --task <taskId> --digest <sha256> --actor <name> --reason <text> --policy-version <ver> [--scope <dependency-release|mission-acceptance>] [--ttl-ms <ms>] [--url <loopback> --token <tok>] [--data-dir <dir>] [--json]
  revoke-waiver --session <id> --mission <id> --waiver <waiverId> [--url <loopback> --token <tok>] [--data-dir <dir>] [--json]`;

export type MissionAuthorityCliHost = CliHost & {
  fetch?: typeof fetch;
  dataDirectory?: string;
  createAgentHost?: typeof createAgentHost;
};

type BridgeConnection = {
  origin?: string;
  token?: string;
  dataDir?: string;
};

type ParsedMissionArgs =
  | { action: 'help' }
  | ({
    action: 'reconcile-preview';
    sessionId: string;
    missionId: string;
    json: boolean;
  } & BridgeConnection)
  | ({
    action: 'reconcile-commit';
    input: MissionReconciliationCommitInput;
    json: boolean;
  } & BridgeConnection)
  | ({
    action: 'evidence';
    sessionId: string;
    missionId: string;
    json: boolean;
  } & BridgeConnection)
  | ({
    action: 'waive';
    input: GrantMissionWaiverInput & { ttlMs: number };
    json: boolean;
  } & BridgeConnection)
  | ({
    action: 'revoke-waiver';
    sessionId: string;
    missionId: string;
    waiverId: string;
    json: boolean;
  } & BridgeConnection);

/**
 * Validate a Bridge base URL for mission authority RPC calls.
 * Fail-closed: accepts only `http:` URLs targeting `127.0.0.1`, `localhost`, or `[::1]`
 * without credentials, query parameters, hash fragments, or non-root paths.
 */
export function parseLoopbackMissionBridgeUrl(raw: string): URL | undefined {
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

function defaultCliHost(): MissionAuthorityCliHost {
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

function parseActionFlags(
  action: string,
  rest: readonly string[],
  valueFlags: readonly string[],
): { help: true } | { values: Map<string, string>; json: boolean } | { error: string } {
  const allowedValueFlags = new Set(valueFlags);
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let json = false;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { help: true };
    if (flag === '--json' && !hasEquals) {
      if (json) return { error: 'Duplicate option: --json' };
      json = true;
      continue;
    }
    if (allowedValueFlags.has(flag)) {
      const read = readSingleValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return { error: read.error };
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) return { error: `Unknown option for mission ${action}: ${arg}` };
    return { error: `Unexpected argument for mission ${action}: ${arg}` };
  }

  return { values, json };
}

function resolveBridgeConnection(
  rawUrl: string | undefined,
  rawToken: string | undefined,
  rawDataDir: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): BridgeConnection | { error: string } {
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
    const parsed = parseLoopbackMissionBridgeUrl(effectiveUrl);
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

function requireIdentifier(values: Map<string, string>, flag: string, field: string): string | { error: string } {
  const raw = values.get(flag);
  if (raw === undefined) {
    return { error: `Missing required option ${flag}.\n\n${MISSION_USAGE}` };
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) {
    return { error: `${field}: must be 1–200 characters.` };
  }
  if (CONTROL_CHAR_PATTERN.test(trimmed)) {
    return { error: `${field}: contains disallowed control characters.` };
  }
  return trimmed;
}

function requireFlagsPresent(values: Map<string, string>, flags: readonly string[]): string | undefined {
  for (const flag of flags) {
    if (values.get(flag) === undefined) {
      return `Missing required option ${flag}.\n\n${MISSION_USAGE}`;
    }
  }
  return undefined;
}

function parseMissionArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): ParsedMissionArgs | string {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) return MISSION_USAGE;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    return { action: 'help' };
  }

  const commonFlags = ['--url', '--token', '--data-dir'] as const;

  if (subcommand === 'reconcile-preview' || subcommand === 'evidence') {
    const parsed = parseActionFlags(subcommand, rest, ['--session', '--mission', ...commonFlags]);
    if ('error' in parsed) return parsed.error;
    if ('help' in parsed) return { action: 'help' };
    const sessionId = requireIdentifier(parsed.values, '--session', 'sessionId');
    if (typeof sessionId !== 'string') return sessionId.error;
    const missionId = requireIdentifier(parsed.values, '--mission', 'missionId');
    if (typeof missionId !== 'string') return missionId.error;
    const connection = resolveBridgeConnection(
      parsed.values.get('--url'),
      parsed.values.get('--token'),
      parsed.values.get('--data-dir'),
      env,
    );
    if ('error' in connection) return connection.error;
    return {
      action: subcommand,
      sessionId,
      missionId,
      json: parsed.json,
      ...connection,
    };
  }

  if (subcommand === 'reconcile-commit') {
    const parsed = parseActionFlags(subcommand, rest, [
      '--session',
      '--mission',
      '--digest',
      '--decision',
      '--actor',
      '--reason',
      '--key',
      ...commonFlags,
    ]);
    if ('error' in parsed) return parsed.error;
    if ('help' in parsed) return { action: 'help' };
    const missing = requireFlagsPresent(parsed.values, [
      '--session',
      '--mission',
      '--digest',
      '--decision',
      '--actor',
      '--reason',
    ]);
    if (missing) return missing;

    const rawKey = parsed.values.get('--key');
    let input: MissionReconciliationCommitInput;
    try {
      input = normalizeMissionReconciliationCommitInput({
        sessionId: parsed.values.get('--session'),
        missionId: parsed.values.get('--mission'),
        expectedReviewDigest: parsed.values.get('--digest'),
        decisionKey: rawKey !== undefined ? rawKey : `cli-${randomUUID()}`,
        decision: parsed.values.get('--decision'),
        actor: parsed.values.get('--actor'),
        reason: parsed.values.get('--reason'),
      });
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid mission reconciliation commit arguments.';
    }

    const connection = resolveBridgeConnection(
      parsed.values.get('--url'),
      parsed.values.get('--token'),
      parsed.values.get('--data-dir'),
      env,
    );
    if ('error' in connection) return connection.error;
    return {
      action: 'reconcile-commit',
      input,
      json: parsed.json,
      ...connection,
    };
  }

  if (subcommand === 'waive') {
    const parsed = parseActionFlags(subcommand, rest, [
      '--session',
      '--mission',
      '--task',
      '--digest',
      '--actor',
      '--reason',
      '--policy-version',
      '--scope',
      '--ttl-ms',
      ...commonFlags,
    ]);
    if ('error' in parsed) return parsed.error;
    if ('help' in parsed) return { action: 'help' };
    const missing = requireFlagsPresent(parsed.values, [
      '--session',
      '--mission',
      '--task',
      '--digest',
      '--actor',
      '--reason',
      '--policy-version',
    ]);
    if (missing) return missing;

    const rawTtlMs = parsed.values.get('--ttl-ms');
    const ttlMs = rawTtlMs === undefined
      ? undefined
      : (/^-?\d+$/.test(rawTtlMs.trim()) ? Number(rawTtlMs.trim()) : Number.NaN);

    let input: GrantMissionWaiverInput & { ttlMs: number };
    try {
      input = normalizeGrantMissionWaiverInput({
        sessionId: parsed.values.get('--session'),
        missionId: parsed.values.get('--mission'),
        taskId: parsed.values.get('--task'),
        expectedReviewDigest: parsed.values.get('--digest'),
        actor: parsed.values.get('--actor'),
        reason: parsed.values.get('--reason'),
        policyVersion: parsed.values.get('--policy-version'),
        scope: parsed.values.get('--scope') ?? 'dependency-release',
        ...(ttlMs !== undefined ? { ttlMs } : {}),
      });
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid mission waiver arguments.';
    }

    const connection = resolveBridgeConnection(
      parsed.values.get('--url'),
      parsed.values.get('--token'),
      parsed.values.get('--data-dir'),
      env,
    );
    if ('error' in connection) return connection.error;
    return {
      action: 'waive',
      input,
      json: parsed.json,
      ...connection,
    };
  }

  if (subcommand === 'revoke-waiver') {
    const parsed = parseActionFlags(subcommand, rest, ['--session', '--mission', '--waiver', ...commonFlags]);
    if ('error' in parsed) return parsed.error;
    if ('help' in parsed) return { action: 'help' };
    const sessionId = requireIdentifier(parsed.values, '--session', 'sessionId');
    if (typeof sessionId !== 'string') return sessionId.error;
    const missionId = requireIdentifier(parsed.values, '--mission', 'missionId');
    if (typeof missionId !== 'string') return missionId.error;
    const rawWaiverId = parsed.values.get('--waiver');
    if (rawWaiverId === undefined) return `Missing required option --waiver.\n\n${MISSION_USAGE}`;

    let waiverId: string;
    try {
      waiverId = normalizeWaiverId(rawWaiverId);
    } catch (error) {
      return error instanceof Error ? error.message : 'Invalid waiver id.';
    }

    const connection = resolveBridgeConnection(
      parsed.values.get('--url'),
      parsed.values.get('--token'),
      parsed.values.get('--data-dir'),
      env,
    );
    if ('error' in connection) return connection.error;
    return {
      action: 'revoke-waiver',
      sessionId,
      missionId,
      waiverId,
      json: parsed.json,
      ...connection,
    };
  }

  return `Unknown action: ${subcommand}\n\n${MISSION_USAGE}`;
}

async function callBridgeRpc<T>(
  origin: string,
  token: string,
  method: MissionAuthorityHostMethod,
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

function resolveMissionDataDirectory(host: MissionAuthorityCliHost, explicitDataDir?: string): string {
  if (explicitDataDir) return path.resolve(explicitDataDir);
  if (host.dataDirectory) return path.resolve(host.dataDirectory);
  return resolveDataDirectory({
    platform: host.platform,
    env: host.env,
    homeDirectory: host.homeDirectory,
  });
}

async function withLocalAgentHost<T>(
  host: MissionAuthorityCliHost,
  explicitDataDir: string | undefined,
  action: (api: Awaited<ReturnType<typeof createAgentHost>>['host']) => Promise<T>,
): Promise<T> {
  const dataDirectory = resolveMissionDataDirectory(host, explicitDataDir);
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

async function invokeMissionMethod<T>(
  host: MissionAuthorityCliHost,
  connection: BridgeConnection,
  method: MissionAuthorityHostMethod,
  args: unknown[],
): Promise<T> {
  if (connection.origin && connection.token) {
    return callBridgeRpc<T>(
      connection.origin,
      connection.token,
      method,
      args,
      host.fetch ?? globalThis.fetch,
    );
  }
  return withLocalAgentHost(host, connection.dataDir, async api => {
    const fn = api[method] as ((...values: unknown[]) => Promise<T>) | undefined;
    if (typeof fn !== 'function') {
      throw new Error(`This host does not support ${method}.`);
    }
    return fn.apply(api, args);
  });
}

function formatTaskGateTable(taskGates: readonly MissionTaskGateEvaluation[], verifiedComplete: boolean): string[] {
  const headers = ['id', 'state', 'validation', 'acceptance', 'dependencyBlockedBy', 'verifiedComplete'];
  const rows = taskGates.map(gate => [
    gate.id,
    gate.state,
    gate.validation,
    gate.acceptance,
    gate.dependencyBlockedBy.length > 0 ? gate.dependencyBlockedBy.join(',') : '-',
    String(verifiedComplete),
  ]);
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)),
  );
  const formatRow = (row: readonly string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();
  return [formatRow(headers), formatRow(widths.map(w => '-'.repeat(w))), ...rows.map(formatRow)];
}

async function handleReconcilePreview(
  host: MissionAuthorityCliHost,
  parsed: Extract<ParsedMissionArgs, { action: 'reconcile-preview' }>,
): Promise<number> {
  const preview = await invokeMissionMethod<MissionReconciliationPreview>(
    host,
    parsed,
    'previewMissionReconciliation',
    [parsed.sessionId, parsed.missionId],
  );
  if (parsed.json) {
    host.out(JSON.stringify(preview, null, 2));
    return 0;
  }

  host.out(`Mission ${preview.missionId} (session=${preview.sessionId}, workspace=${preview.workspaceId})`);
  host.out(`State:              ${preview.currentState}${preview.recoverySource ? ` (${preview.recoverySource})` : ''}`);
  host.out(`Review digest:      ${preview.reviewDigest}`);
  host.out(`Eligible decisions: ${preview.eligibleDecisions.join(', ') || 'none'}`);
  host.out(`Active leases:      ${preview.activeLeaseIds.join(', ') || 'none'}`);
  host.out(`Quarantined leases: ${preview.quarantinedLeaseIds.join(', ') || 'none'}`);
  host.out(`Tasks (${preview.taskSummaries.length}):`);
  for (const task of preview.taskSummaries) {
    host.out(`  - ${task.id} (${task.taskId}) [${task.state}] acceptance=${task.acceptance} evidence=${task.evidenceCount}: ${task.title}`);
  }
  if (preview.existingReceipt) {
    host.out(
      `Existing receipt:   ${preview.existingReceipt.receiptId} (${preview.existingReceipt.decision}, key=${preview.existingReceipt.decisionKey})`,
    );
  }
  if (preview.warnings.length > 0) {
    host.out(`Warnings (${preview.warnings.length}):`);
    for (const warning of preview.warnings) {
      host.out(`  - ${warning}`);
    }
  }
  return 0;
}

async function handleReconcileCommit(
  host: MissionAuthorityCliHost,
  parsed: Extract<ParsedMissionArgs, { action: 'reconcile-commit' }>,
): Promise<number> {
  const result = await invokeMissionMethod<MissionReconciliationCommitResult>(
    host,
    parsed,
    'commitMissionReconciliation',
    [parsed.input],
  );
  if (parsed.json) {
    host.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  if (!result.ok) {
    host.err(`mission reconcile-commit failed [${result.code}]: ${result.detail}`);
    if (result.currentReviewDigest) {
      host.err(`Current review digest: ${result.currentReviewDigest}`);
    }
    return 1;
  }

  host.out(
    `Reconciliation committed: ${result.receipt.receiptId} (decision=${result.receipt.decision}, idempotentReplay=${result.idempotentReplay})`,
  );
  host.out(`Mission:       ${result.receipt.missionId} (${result.receipt.previousState} -> ${result.receipt.resultingState})`);
  host.out(`Review digest: ${result.receipt.reviewDigest}`);
  host.out(`Decision key:  ${result.receipt.decisionKey}`);
  host.out(`Committed at:  ${result.receipt.committedAt}`);
  return 0;
}

async function handleEvidence(
  host: MissionAuthorityCliHost,
  parsed: Extract<ParsedMissionArgs, { action: 'evidence' }>,
): Promise<number> {
  const overview = await invokeMissionMethod<MissionAuthorityOverview>(
    host,
    parsed,
    'missionAuthorityOverview',
    [parsed.sessionId, parsed.missionId],
  );
  if (parsed.json) {
    host.out(JSON.stringify(overview, null, 2));
    return 0;
  }

  host.out(`Mission ${overview.missionId} (session=${overview.sessionId}, workspace=${overview.workspaceId})`);
  host.out(`Review digest:    ${overview.reviewDigest}`);
  host.out(`verifiedComplete: ${overview.verifiedComplete}`);
  host.out(`Evidence records: ${overview.evidence.length}  Waivers: ${overview.waivers.length}`);
  if (overview.taskGates.length === 0) {
    host.out('No task gates recorded.');
    return 0;
  }
  for (const line of formatTaskGateTable(overview.taskGates, overview.verifiedComplete)) {
    host.out(line);
  }
  return 0;
}

async function handleWaive(
  host: MissionAuthorityCliHost,
  parsed: Extract<ParsedMissionArgs, { action: 'waive' }>,
): Promise<number> {
  const overview = await invokeMissionMethod<MissionAuthorityOverview>(
    host,
    parsed,
    'grantMissionWaiver',
    [parsed.input],
  );
  if (parsed.json) {
    host.out(JSON.stringify(overview, null, 2));
    return 0;
  }

  const latestWaiver = [...overview.waivers]
    .reverse()
    .find(w => w.taskId === parsed.input.taskId && w.revokedAt === undefined);
  host.out(`Waiver granted for task ${parsed.input.taskId} on mission ${overview.missionId}`);
  if (latestWaiver) {
    host.out(`Waiver ID:        ${latestWaiver.waiverId} (scope=${latestWaiver.scope}, expiresAt=${latestWaiver.expiresAt})`);
  }
  host.out(`Review digest:    ${overview.reviewDigest}`);
  host.out(`verifiedComplete: ${overview.verifiedComplete}`);
  return 0;
}

async function handleRevokeWaiver(
  host: MissionAuthorityCliHost,
  parsed: Extract<ParsedMissionArgs, { action: 'revoke-waiver' }>,
): Promise<number> {
  const overview = await invokeMissionMethod<MissionAuthorityOverview>(
    host,
    parsed,
    'revokeMissionWaiver',
    [parsed.sessionId, parsed.missionId, parsed.waiverId],
  );
  if (parsed.json) {
    host.out(JSON.stringify(overview, null, 2));
    return 0;
  }

  const revoked = overview.waivers.find(w => w.waiverId === parsed.waiverId);
  host.out(`Waiver revoked: ${parsed.waiverId} on mission ${overview.missionId}`);
  if (revoked?.revokedAt) {
    host.out(`Revoked at:       ${revoked.revokedAt}`);
  }
  host.out(`Review digest:    ${overview.reviewDigest}`);
  host.out(`verifiedComplete: ${overview.verifiedComplete}`);
  return 0;
}

/** Run `extalia mission <action>` and return the process exit code. */
export async function runMissionAuthority(
  argv: readonly string[],
  host: MissionAuthorityCliHost = defaultCliHost(),
): Promise<number> {
  const parsed = parseMissionArgs(argv, host.env);
  if (typeof parsed === 'string') {
    host.err(`mission: ${parsed}`);
    return 1;
  }
  if (parsed.action === 'help') {
    host.out(MISSION_USAGE);
    return 0;
  }

  try {
    if (parsed.action === 'reconcile-preview') return await handleReconcilePreview(host, parsed);
    if (parsed.action === 'reconcile-commit') return await handleReconcileCommit(host, parsed);
    if (parsed.action === 'evidence') return await handleEvidence(host, parsed);
    if (parsed.action === 'waive') return await handleWaive(host, parsed);
    return await handleRevokeWaiver(host, parsed);
  } catch (error) {
    host.err(`mission ${parsed.action}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
