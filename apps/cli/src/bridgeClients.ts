import path from 'node:path';
import {
  BridgePairingInputError,
  normalizeBridgeClientId,
  normalizeBridgeClientName,
  normalizeBridgeClientScopes,
  resolveDataDirectory,
  type BridgeClientGrantView,
  type BridgeClientScope,
  type BridgePairingChallengeView,
} from '@extalia/platform';
import { BridgePairingStore } from './bridge/pairing';
import { TOKEN_HEADER } from './bridge/server';
import type { CliHost } from './cli';

const BRIDGE_USAGE = `Usage: extalia bridge <subcommand> [options]

Subcommands:
  clients [--json]
  pair --name <name> --scopes <csv> --url <loopback-url> --token <master-token> [--challenge-only] [--grant-ttl-ms <ms>]
  revoke <clientId> [--reason <text>] [--dry-run] [--yes|-y] [--url <loopback-url> --token <master-token>]`;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

export type ParsedBridgeArgs =
  | { action: 'help' }
  | { action: 'clients'; json: boolean }
  | {
    action: 'pair';
    name: string;
    scopes: BridgeClientScope[];
    origin: string;
    token: string;
    challengeOnly: boolean;
    grantTtlMs?: number;
  }
  | {
    action: 'revoke';
    clientId: string;
    reason?: string;
    dryRun: boolean;
    yes: boolean;
    origin?: string;
    token?: string;
  };

/**
 * Validate a Bridge base URL for CLI pairing/revocation calls.
 * Fail-closed: accepts only `http:` URLs targeting `127.0.0.1` or `localhost` without credentials, query, or non-root path.
 */
export function parseLoopbackBridgeUrl(raw: string): URL | undefined {
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

function splitFlag(arg: string): { flag: string; hasEquals: boolean; inlineValue?: string } {
  const equals = arg.indexOf('=');
  if (equals > 0) {
    return { flag: arg.slice(0, equals), hasEquals: true, inlineValue: arg.slice(equals + 1) };
  }
  return { flag: arg, hasEquals: false };
}

function readFlagValue(
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

function parseClientsArgs(rest: readonly string[]): ParsedBridgeArgs | string {
  let json = false;
  for (const arg of rest) {
    if (arg === '--help' || arg === '-h') return { action: 'help' };
    if (arg === '--json' && !json) {
      json = true;
    } else if (arg === '--json') {
      return 'Duplicate option: --json';
    } else {
      return `Unknown option for bridge clients: ${arg}`;
    }
  }
  return { action: 'clients', json };
}

function parsePairArgs(rest: readonly string[]): ParsedBridgeArgs | string {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let challengeOnly = false;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if (flag === '--challenge-only' && !hasEquals) {
      if (challengeOnly) return 'Duplicate option: --challenge-only';
      challengeOnly = true;
      continue;
    }
    if (['--name', '--scopes', '--url', '--token', '--grant-ttl-ms'].includes(flag)) {
      const read = readFlagValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return read.error;
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    return `Unknown option for bridge pair: ${arg}`;
  }

  const rawName = values.get('--name');
  const rawScopes = values.get('--scopes');
  const rawUrl = values.get('--url');
  const rawToken = values.get('--token');
  const rawGrantTtlMs = values.get('--grant-ttl-ms');

  if (rawName === undefined) return `Missing required option --name.\n\n${BRIDGE_USAGE}`;
  if (rawScopes === undefined) return `Missing required option --scopes.\n\n${BRIDGE_USAGE}`;
  if (rawUrl === undefined) return `Missing required option --url.\n\n${BRIDGE_USAGE}`;
  if (rawToken === undefined) return `Missing required option --token.\n\n${BRIDGE_USAGE}`;

  let name: string;
  let scopes: BridgeClientScope[];
  try {
    name = normalizeBridgeClientName(rawName);
    const scopeList = rawScopes.trim() === '' ? [] : rawScopes.split(',').map(item => item.trim());
    scopes = normalizeBridgeClientScopes(scopeList);
  } catch (error) {
    return error instanceof BridgePairingInputError ? error.message : 'Invalid Bridge pairing arguments.';
  }

  const parsedUrl = parseLoopbackBridgeUrl(rawUrl);
  if (!parsedUrl) {
    return '--url must be an http://127.0.0.1:<port> or http://localhost:<port> loopback URL.';
  }
  if (!rawToken.trim()) {
    return '--token must not be empty.';
  }

  let grantTtlMs: number | undefined;
  if (rawGrantTtlMs !== undefined) {
    if (!/^\d+$/.test(rawGrantTtlMs)) {
      return '--grant-ttl-ms must be a positive integer.';
    }
    const parsed = Number(rawGrantTtlMs);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      return '--grant-ttl-ms must be a positive integer.';
    }
    grantTtlMs = parsed;
  }

  return {
    action: 'pair',
    name,
    scopes,
    origin: parsedUrl.origin,
    token: rawToken,
    challengeOnly,
    ...(grantTtlMs !== undefined ? { grantTtlMs } : {}),
  };
}

function parseRevokeArgs(rest: readonly string[]): ParsedBridgeArgs | string {
  const values = new Map<string, string>();
  const seen = new Set<string>();
  let dryRun = false;
  let yes = false;
  let rawClientId: string | undefined;

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index] as string;
    const { flag, hasEquals, inlineValue } = splitFlag(arg);
    if ((flag === '--help' || flag === '-h') && !hasEquals) return { action: 'help' };
    if (flag === '--dry-run' && !hasEquals) {
      if (dryRun) return 'Duplicate option: --dry-run';
      dryRun = true;
      continue;
    }
    if ((flag === '--yes' || flag === '-y') && !hasEquals) {
      if (yes) return 'Duplicate option: --yes';
      yes = true;
      continue;
    }
    if (['--reason', '--url', '--token'].includes(flag)) {
      const read = readFlagValue(rest, index, flag, hasEquals, inlineValue, seen);
      if ('error' in read) return read.error;
      values.set(flag, read.value);
      index = read.nextIndex;
      continue;
    }
    if (arg.startsWith('-')) {
      return `Unknown option for bridge revoke: ${arg}`;
    }
    if (rawClientId !== undefined) {
      return `Unexpected argument for bridge revoke: ${arg}`;
    }
    rawClientId = arg;
  }

  if (rawClientId === undefined) return `Missing <clientId>.\n\n${BRIDGE_USAGE}`;

  let clientId: string;
  try {
    clientId = normalizeBridgeClientId(rawClientId);
  } catch (error) {
    return error instanceof BridgePairingInputError ? error.message : 'Invalid Bridge client id.';
  }

  const rawUrl = values.get('--url');
  const rawToken = values.get('--token');
  if ((rawUrl !== undefined) !== (rawToken !== undefined)) {
    return '--url and --token must be provided together.';
  }

  let origin: string | undefined;
  if (rawUrl !== undefined) {
    const parsedUrl = parseLoopbackBridgeUrl(rawUrl);
    if (!parsedUrl) {
      return '--url must be an http://127.0.0.1:<port> or http://localhost:<port> loopback URL.';
    }
    if (!rawToken?.trim()) {
      return '--token must not be empty.';
    }
    origin = parsedUrl.origin;
  }

  const reason = values.get('--reason');

  return {
    action: 'revoke',
    clientId,
    ...(reason !== undefined ? { reason } : {}),
    dryRun,
    yes,
    ...(origin !== undefined ? { origin } : {}),
    ...(rawToken !== undefined ? { token: rawToken } : {}),
  };
}

export function parseBridgeArgs(args: readonly string[]): ParsedBridgeArgs | string {
  const [subcommand, ...rest] = args;
  if (subcommand === undefined) return BRIDGE_USAGE;
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') return { action: 'help' };
  if (subcommand === 'clients') return parseClientsArgs(rest);
  if (subcommand === 'pair') return parsePairArgs(rest);
  if (subcommand === 'revoke') return parseRevokeArgs(rest);
  return `Unknown subcommand: ${subcommand}\n\n${BRIDGE_USAGE}`;
}

function grantsStorePath(host: CliHost): string {
  const dataDirectory = resolveDataDirectory({
    platform: host.platform,
    env: host.env,
    homeDirectory: host.homeDirectory,
  });
  return path.join(dataDirectory, 'state', 'bridge-grants.json');
}

function formatGrantLine(client: BridgeClientGrantView): string {
  const parts = [
    client.clientId,
    `[${client.state}]`,
    client.name,
    `scopes=${client.scopes.join(',')}`,
    `issued=${client.issuedAt}`,
  ];
  if (client.expiresAt) parts.push(`expires=${client.expiresAt}`);
  if (client.lastUsedAt) parts.push(`lastUsed=${client.lastUsedAt}`);
  if (client.revokedAt) parts.push(`revoked=${client.revokedAt}`);
  if (client.revokeReason) parts.push(`reason=${client.revokeReason}`);
  return parts.join('  ');
}

async function postBridgeJson<T>(
  origin: string,
  pathname: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(`${origin}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : String(error);
    return { ok: false, error: `Could not reach Bridge at ${origin}: ${detail}` };
  }

  const parsed = (await response.json().catch(() => undefined)) as { error?: unknown } | T | undefined;
  if (!response.ok) {
    const message = parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
      ? parsed.error
      : `Bridge request failed with HTTP ${response.status}.`;
    return { ok: false, error: message };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: `Bridge returned an invalid response for ${pathname}.` };
  }
  return { ok: true, data: parsed as T };
}

async function handleClients(host: CliHost, json: boolean): Promise<number> {
  const store = await BridgePairingStore.open({ filePath: grantsStorePath(host) });
  let clients: BridgeClientGrantView[];
  try {
    clients = store.list();
  } finally {
    await store.close();
  }

  if (json) {
    host.out(JSON.stringify({ clients }, null, 2));
    return 0;
  }
  if (clients.length === 0) {
    host.out('No scoped Bridge clients paired yet.');
    return 0;
  }
  for (const client of clients) {
    host.out(formatGrantLine(client));
  }
  return 0;
}

async function handlePair(
  host: CliHost,
  parsed: Extract<ParsedBridgeArgs, { action: 'pair' }>,
): Promise<number> {
  const challengeResult = await postBridgeJson<{ challenge: BridgePairingChallengeView }>(
    parsed.origin,
    '/api/bridge/pair/challenge',
    parsed.token,
    { name: parsed.name, scopes: parsed.scopes },
  );
  if (!challengeResult.ok) {
    host.err(`bridge pair: ${challengeResult.error}`);
    return 1;
  }

  const { challenge } = challengeResult.data;
  if (parsed.challengeOnly) {
    host.out(`Challenge ID: ${challenge.challengeId}`);
    host.out(`Code:         ${challenge.code}`);
    host.out(`Expires at:   ${challenge.expiresAt}`);
    return 0;
  }

  const confirmResult = await postBridgeJson<{ client: BridgeClientGrantView; token: string }>(
    parsed.origin,
    '/api/bridge/pair/confirm',
    parsed.token,
    {
      challengeId: challenge.challengeId,
      code: challenge.code,
      ...(parsed.grantTtlMs !== undefined ? { grantTtlMs: parsed.grantTtlMs } : {}),
    },
  );
  if (!confirmResult.ok) {
    host.err(`bridge pair: ${confirmResult.error}`);
    return 1;
  }

  const { client, token } = confirmResult.data;
  host.out(`Client ID:    ${client.clientId}`);
  host.out(`Name:         ${client.name}`);
  host.out(`Scopes:       ${client.scopes.join(', ')}`);
  host.out(`Token:        ${token}`);
  if (client.expiresAt) {
    host.out(`Expires at:   ${client.expiresAt}`);
  }
  host.out('Warning: Save this token now; it will not be shown again.');
  return 0;
}

async function handleRevoke(
  host: CliHost,
  parsed: Extract<ParsedBridgeArgs, { action: 'revoke' }>,
): Promise<number> {
  const reasonSuffix = parsed.reason ? ` (reason: ${parsed.reason})` : '';
  const filePath = grantsStorePath(host);

  if (parsed.dryRun) {
    if (parsed.origin) {
      host.out(`Would revoke Bridge client ${parsed.clientId} via ${parsed.origin}${reasonSuffix}.`);
      host.out('Dry run complete. No grants were modified.');
    } else {
      host.out(`Would revoke Bridge client ${parsed.clientId} in ${filePath}${reasonSuffix}.`);
      host.out('Dry run complete. No files were changed.');
    }
    return 0;
  }

  if (!parsed.yes) {
    const confirmed = host.prompt ? await host.prompt(`Revoke Bridge client ${parsed.clientId}? [y/N] `) : false;
    if (!confirmed) {
      host.err('Cancelled. Nothing was changed (pass --yes to apply non-interactively).');
      return 1;
    }
  }

  if (parsed.origin && parsed.token) {
    const revokeResult = await postBridgeJson<{ client: BridgeClientGrantView }>(
      parsed.origin,
      '/api/bridge/clients/revoke',
      parsed.token,
      {
        clientId: parsed.clientId,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      },
    );
    if (!revokeResult.ok) {
      host.err(`bridge revoke: ${revokeResult.error}`);
      return 1;
    }
    const { client } = revokeResult.data;
    host.out(
      `Revoked Bridge client ${client.clientId} (${client.name}, state=${client.state}${client.revokedAt ? `, revokedAt=${client.revokedAt}` : ''}).`,
    );
    if (client.revokeReason) host.out(`Reason: ${client.revokeReason}`);
    return 0;
  }

  const store = await BridgePairingStore.open({ filePath });
  let client: BridgeClientGrantView;
  try {
    client = await store.revoke(parsed.clientId, parsed.reason);
  } finally {
    await store.close();
  }

  host.out(
    `Revoked Bridge client ${client.clientId} (${client.name}, state=${client.state}${client.revokedAt ? `, revokedAt=${client.revokedAt}` : ''}).`,
  );
  if (client.revokeReason) host.out(`Reason: ${client.revokeReason}`);
  host.out('Note: Active SSE clients also require --url/--token or Settings UI to disconnect immediately.');
  return 0;
}

/** Manage scoped Bridge client pairing grants (`clients`, `pair`, `revoke`). */
export async function runBridgeClients(host: CliHost, args: readonly string[]): Promise<number> {
  const parsed = parseBridgeArgs(args);
  if (typeof parsed === 'string') {
    host.err(`bridge: ${parsed}`);
    return 2;
  }
  if (parsed.action === 'help') {
    host.out(BRIDGE_USAGE);
    return 0;
  }

  try {
    if (parsed.action === 'clients') return await handleClients(host, parsed.json);
    if (parsed.action === 'pair') return await handlePair(host, parsed);
    return await handleRevoke(host, parsed);
  } catch (error) {
    host.err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
