import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SkillMarketManifestPreview, SkillMarketPreview, SkillMarketPreviewInput, SkillMarketSearchResult } from '@extalia/platform';
import { DAEMON_SKILL_LIMITS, SKILL_CAPABILITIES, SKILL_PACKAGE_ID_PATTERN, SKILL_RISK_CLASSES } from '@extalia/protocol';
import type { DaemonProcess } from './client.js';

const SCHEMA = 'extalia.skill-market.v1' as const;
const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_QUERY = 120;
const CHILD_TIMEOUT_MS = 46_000;
const CLIENT_TIMEOUT_MS = 45_000;
const MAX_CHILDREN = 2;
const SHA256 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9._-]+$/;
const SAFE_PATH = /^(?!\/)[A-Za-z0-9._/-]{1,512}$/;
export interface SkillMarketStageResult { path: string; treeSha256: string; sourceRef: string }
const ERROR_CODES = ['invalid_request', 'network', 'timeout', 'rate_limited', 'not_found', 'invalid_tree', 'invalid_manifest', 'too_large', 'review_expired', 'integrity', 'storage', 'review_conflict'] as const;
export type SkillMarketErrorCode = (typeof ERROR_CODES)[number];
const errorCodes = new Set<string>(ERROR_CODES);
type Operation = 'search' | 'preview' | 'stage' | 'discard';
type Result = SkillMarketSearchResult | SkillMarketPreview | SkillMarketStageResult | { discarded: boolean };

export interface SkillMarketProcess extends DaemonProcess {
  readonly pid?: number;
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}
export type SpawnSkillMarket = (binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => SkillMarketProcess;
interface Pending { abort(): void; done: Promise<unknown> }
const spawnChild: SpawnSkillMarket = (binary, args, options) => spawn(binary, args, {
  ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});

const unavailable = (code: string) => new Error(`Native skill market unavailable (${errorCodes.has(code) ? code : 'invalid_response'}).`);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasControl = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !hasControl(value);
const safeRelative = (value: unknown): value is string => typeof value === 'string' && value.length <= 512 && (value === '' || (SAFE_PATH.test(value) && !value.split('/').some(part => part === '.' || part === '..' || !part)));
const portableSkillPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value.split('/').length <= 8 && value.split('/').every(part => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(part)
    && !part.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(part));
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
const count = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const member = <T extends string>(items: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && items.includes(value as T);

function parseManifestPreview(value: unknown): SkillMarketManifestPreview | undefined {
  if (!object(value) || !onlyKeys(value, ['id', 'version', 'inferred', 'riskClass', 'permissions', 'permissionsTotal', 'compatibility', 'compatibilityTotal'])
    || typeof value.id !== 'string' || !SKILL_PACKAGE_ID_PATTERN.test(value.id)
    || !text(value.version, 128) || !/^[0-9A-Za-z.+-]+$/.test(value.version)
    || typeof value.inferred !== 'boolean' || !member(SKILL_RISK_CLASSES, value.riskClass)
    || !count(value.permissionsTotal, DAEMON_SKILL_LIMITS.permissions) || !Array.isArray(value.permissions)
    || value.permissions.length !== Math.min(value.permissionsTotal, 32)
    || !count(value.compatibilityTotal, 64) || !Array.isArray(value.compatibility)
    || value.compatibility.length !== Math.min(value.compatibilityTotal, 16)
    || (value.inferred && (value.permissionsTotal !== 0 || value.compatibilityTotal !== 0 || value.riskClass === 'tool_using'))) return;
  const permissions: SkillMarketManifestPreview['permissions'] = [];
  const permissionKeys = new Set<string>();
  for (const row of value.permissions) {
    if (!object(row) || !onlyKeys(row, ['capability', 'scope']) || !member(SKILL_CAPABILITIES, row.capability)
      || !text(row.scope, 256) || /\p{Cc}/u.test(row.scope)) return;
    const key = `${row.capability}:\0${row.scope}`;
    if (permissionKeys.has(key)) return;
    permissionKeys.add(key);
    permissions.push({ capability: row.capability, scope: row.scope });
  }
  const compatibility: SkillMarketManifestPreview['compatibility'] = [];
  const factIds = new Set<string>();
  for (const row of value.compatibility) {
    if (!object(row) || !onlyKeys(row, ['id', 'range']) || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(row.id)
      || !text(row.range, 128) || /\p{Cc}/u.test(row.range) || factIds.has(row.id)) return;
    factIds.add(row.id);
    compatibility.push({ id: row.id, range: row.range });
  }
  return { id: value.id, version: value.version, inferred: value.inferred, riskClass: value.riskClass,
    permissions, permissionsTotal: value.permissionsTotal, compatibility, compatibilityTotal: value.compatibilityTotal };
}
function parseResult(operation: Operation, value: unknown, fields: Record<string, unknown>): Result | undefined {
  if (!object(value)) return;
  if (operation === 'search') {
    if (!onlyKeys(value, ['provider', 'query', 'entries', 'fetchedAt', 'cached', 'stale', 'problem']) || value.provider !== 'skills-sh' || !text(value.query, MAX_QUERY)
      || !Array.isArray(value.entries) || value.entries.length > 50 || typeof value.cached !== 'boolean' || typeof value.stale !== 'boolean'
      || value.fetchedAt !== undefined && (typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt)))
      || value.problem !== undefined && (typeof value.problem !== 'string' || !errorCodes.has(value.problem))) return;
    const entries = [];
    for (const row of value.entries) {
      if (!object(row) || !onlyKeys(row, ['id', 'name', 'source', 'installs', 'url']) || !text(row.id, 512) || !text(row.name, 200)
        || !REPOSITORY.test(String(row.source)) || !Number.isSafeInteger(row.installs) || (row.installs as number) < 0 || !text(row.url, 2048)) return;
      try { const url = new URL(row.url); if (url.protocol !== 'https:' || url.hostname !== 'skills.sh' || url.username || url.password || url.port || url.search || url.hash) return; } catch { return; }
      entries.push({ id: row.id, name: row.name, source: row.source as string, installs: row.installs as number, url: row.url });
    }
    return { provider: 'skills-sh', query: value.query, entries, ...(value.fetchedAt ? { fetchedAt: value.fetchedAt as string } : {}), cached: value.cached, stale: value.stale, ...(value.problem ? { problem: value.problem as string } : {}) };
  }
  if (operation === 'preview') {
    if (!onlyKeys(value, ['reviewId', 'expiresAt', 'repository', 'commit', 'directory', 'sourceRef', 'files', 'totalBytes', 'treeSha256', 'license', 'warnings', 'manifest'])
      || !UUID.test(String(value.reviewId)) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))
      || !REPOSITORY.test(String(value.repository)) || !/^[a-f0-9]{40}$/i.test(String(value.commit)) || !safeRelative(value.directory)
      || value.directory !== '' && !portableSkillPath(value.directory)
      || value.sourceRef !== `github:${value.repository}@${value.commit}#${value.directory}` || !Array.isArray(value.files) || value.files.length > 128
      || !Number.isSafeInteger(value.totalBytes) || (value.totalBytes as number) < 0 || (value.totalBytes as number) > 2 * 1024 * 1024
      || !SHA256.test(String(value.treeSha256)) || value.license !== undefined && !text(value.license, 1024)
      || !Array.isArray(value.warnings) || value.warnings.length > 32 || !value.warnings.every(item => typeof item === 'string' && item.length <= 500 && !hasControl(item))) return;
    let bytes = 0;
    const files = [];
    const seen = new Set<string>();
    for (const file of value.files) {
      if (!object(file) || !onlyKeys(file, ['path', 'size', 'sha256']) || !safeRelative(file.path) || file.path === '' || seen.has(file.path)
        || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.size as number) > 512 * 1024 || !SHA256.test(String(file.sha256))) return;
      seen.add(file.path); bytes += file.size as number;
      if (bytes > 2 * 1024 * 1024) return;
      files.push({ path: file.path, size: file.size as number, sha256: file.sha256 as string });
    }
    if (bytes !== value.totalBytes) return;
    const manifest = value.manifest === undefined ? undefined : parseManifestPreview(value.manifest);
    if (value.manifest !== undefined && !manifest) return;
    return { reviewId: value.reviewId as string, expiresAt: value.expiresAt, repository: value.repository as string, commit: value.commit as string,
      directory: value.directory, sourceRef: value.sourceRef as string, files, totalBytes: bytes, treeSha256: value.treeSha256 as string,
      ...(value.license ? { license: value.license as string } : {}), ...(manifest ? { manifest } : {}), warnings: value.warnings as string[] };
  }
  if (operation === 'stage') {
    if (!onlyKeys(value, ['path', 'treeSha256', 'sourceRef']) || value.path !== `market-${String(fields.reviewId)}`
      || !SHA256.test(String(value.treeSha256)) || !text(value.sourceRef, 1024)) return;
    return { path: value.path, treeSha256: value.treeSha256 as string, sourceRef: value.sourceRef };
  }
  if (!onlyKeys(value, ['discarded']) || typeof value.discarded !== 'boolean') return;
  return { discarded: value.discarded };
}

/** Bounded, one-shot Rust bridge for the independent Skills Market catalog and staging area. */
export class RustSkillMarket {
  private readonly pending = new Set<Pending>();
  private closed = false;
  constructor(private readonly options: {
    binary(): string | undefined; directory: string; workingDirectory?: string; clientVersion: string; env?: Readonly<Record<string, string | undefined>>; spawn?: SpawnSkillMarket;
  }) {}
  get pendingCount(): number { return this.pending.size; }

  search(query: string, refresh = false, signal?: AbortSignal): Promise<SkillMarketSearchResult> {
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) return Promise.reject(unavailable('invalid_request'));
    return this.request('search', { query: query.trim(), refresh }, signal) as Promise<SkillMarketSearchResult>;
  }
  preview(input: SkillMarketPreviewInput, signal?: AbortSignal): Promise<SkillMarketPreview> {
    if (!object(input) || !REPOSITORY.test(input.repository) || !portableSkillPath(input.skill)) return Promise.reject(unavailable('invalid_request'));
    return this.request('preview', { repository: input.repository, skill: input.skill }, signal) as Promise<SkillMarketPreview>;
  }
  stage(reviewId: string, signal?: AbortSignal): Promise<SkillMarketStageResult> {
    if (!UUID.test(reviewId)) return Promise.reject(unavailable('invalid_request'));
    return this.request('stage', { reviewId }, signal) as Promise<SkillMarketStageResult>;
  }
  async discard(reviewId: string): Promise<void> {
    if (!UUID.test(reviewId)) throw unavailable('invalid_request');
    await this.request('discard', { reviewId });
  }

  private request(operation: Operation, fields: Record<string, unknown>, signal?: AbortSignal): Promise<Result> {
    if (this.closed || signal?.aborted) return Promise.reject(unavailable('timeout'));
    if (this.pending.size >= MAX_CHILDREN) return Promise.reject(unavailable('storage'));
    if (!path.isAbsolute(this.options.directory)) return Promise.reject(unavailable('invalid_request'));
    const binary = this.options.binary();
    if (!binary) return Promise.reject(unavailable('storage'));
    const requestId = randomUUID();
    const payload = JSON.stringify({ schema: SCHEMA, requestId, clientVersion: this.options.clientVersion.slice(0, 64), operation,
      directory: this.options.directory, timeoutMs: CLIENT_TIMEOUT_MS, ...fields });
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) return Promise.reject(unavailable('invalid_request'));
    const env: Record<string, string> = {};
    for (const key of ['SystemRoot', 'windir', 'TMPDIR', 'TEMP', 'TMP']) { const value = this.options.env?.[key]; if (value) env[key] = value; }
    let child: SkillMarketProcess;
    const cwd = this.options.workingDirectory ?? path.parse(this.options.directory).root;
    if (!path.isAbsolute(cwd)) return Promise.reject(unavailable('invalid_request'));
    try { child = (this.options.spawn ?? spawnChild)(binary, ['--skill-market'], { cwd, env }); }
    catch { return Promise.reject(unavailable('storage')); }
    const pending: Pending = { abort: () => undefined, done: Promise.resolve(undefined) };
    this.pending.add(pending);
    const done = new Promise<Result>((resolve, reject) => {
      let output = Buffer.alloc(0), stderrBytes = 0, failure: Error | undefined, finished = false, spawned = false;
      const stop = (code: string) => {
        failure ??= unavailable(code);
        try { child.kill('SIGKILL'); } catch { /* retain admission until the child actually closes */ }
      };
      const abort = () => stop('timeout'); pending.abort = abort;
      const timer = setTimeout(() => stop('timeout'), CHILD_TIMEOUT_MS);
      const finish = (code: number | null) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(pending);
        if (failure || code !== 0) { reject(failure ?? unavailable('storage')); return; }
        let value: unknown;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)); } catch { /* invalid reply */ }
        if (!object(value) || value.schema !== SCHEMA || value.requestId !== requestId) { reject(unavailable('invalid_response')); return; }
        if (value.outcome === 'error') {
          // The Rust error envelope intentionally omits `operation`; correlation is
          // provided by the one-shot child and requestId, while success replies echo it.
          if (!onlyKeys(value, ['schema', 'requestId', 'outcome', 'code', 'status'])) { reject(unavailable('invalid_response')); return; }
          if (!text(value.code, 64) || !errorCodes.has(value.code) || value.status !== undefined && (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599)) { reject(unavailable('invalid_response')); return; }
          reject(unavailable(value.code)); return;
        }
        if (value.outcome !== 'ok' || value.operation !== operation || !onlyKeys(value, ['schema', 'requestId', 'outcome', 'operation', 'result'])) { reject(unavailable('invalid_response')); return; }
        const result = value.outcome === 'ok' ? parseResult(operation, value.result, fields) : undefined;
        if (!result) { reject(unavailable('invalid_response')); return; }
        resolve(result);
      };
      child.once('spawn', () => { spawned = true; });
      child.once('error', () => { if (!spawned && child.pid === undefined) { failure = unavailable('storage'); finish(null); } else stop('storage'); });
      child.once('close', (code: number | null) => finish(code));
      child.stdout.on('data', (chunk: Buffer) => { if (failure || finished) return; if (output.length + chunk.length > MAX_RESPONSE_BYTES) { stop('too_large'); return; } output = Buffer.concat([output, chunk]); });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 4096) stop('too_large'); });
      child.stdin.on('error', () => stop('storage')); child.stdout.on('error', () => stop('storage')); child.stderr.on('error', () => stop('storage'));
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); else child.stdin.end(payload);
    });
    pending.done = done; return done;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const operation of this.pending) operation.abort();
    await Promise.allSettled([...this.pending].map(operation => operation.done));
  }
}
