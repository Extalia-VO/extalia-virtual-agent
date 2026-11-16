import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SkillMarketProcess } from './skillMarket.js';

const SCHEMA = 'extalia.learning-source.v1';
const MAX_RESPONSE_BYTES = 256 * 1024;
const CHILD_TIMEOUT_MS = 16_000;
const MAX_CHILDREN = 2;
let activeChildren = 0;
const CODES = new Set(['invalid_url', 'blocked_address', 'network', 'timeout', 'too_large', 'unsupported_content', 'invalid_redirect', 'redirect_limit', 'http_status']);

/** Hash and byte count describe the full admitted response body, not trust or scanner evidence. */
export interface SourceReadResult {
  sourceUrl: string;
  finalUrl: string;
  contentType: string;
  bytes: number;
  sha256: string;
  excerpt: string;
  truncated: boolean;
}
export type SpawnLearningSource = (binary: string, args: string[], options: { cwd: string; env: Record<string, string> }) => SkillMarketProcess;
const spawnChild: SpawnLearningSource = (binary, args, options) => spawn(binary, args, {
  ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});
const failure = (code: string) => new Error(`Source read did not complete (${code}).`);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const hasControl = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** Exact URL scope normalization. Public-address admission and pinned DNS belong to Rust. */
export function normalizeLearningSourceUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw) > 2048 || /\s/u.test(raw) || hasControl(raw) || raw.includes('\\')) throw failure('invalid_url');
  let url: URL;
  try { url = new URL(raw); } catch { throw failure('invalid_url'); }
  const authority = raw.split('://')[1]?.split(/[/?#]/)[0];
  if (!['https:', 'http:'].includes(url.protocol) || !authority || authority.includes('@') || url.username || url.password || url.port || url.search || raw.split('#')[0]?.includes('?')) throw failure('invalid_url');
  url.hash = '';
  return url.href;
}

export function parseLearningSourceResult(raw: unknown, sourceUrl: string): SourceReadResult | undefined {
  if (!object(raw) || !keys(raw, ['sourceUrl', 'finalUrl', 'contentType', 'bytes', 'sha256', 'excerpt', 'truncated'])
    || raw.sourceUrl !== sourceUrl || typeof raw.finalUrl !== 'string'
    || typeof raw.contentType !== 'string' || raw.contentType.length === 0 || raw.contentType.length > 256 || hasControl(raw.contentType)
    || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0 || (raw.bytes as number) > 128 * 1024
    || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)
    || typeof raw.excerpt !== 'string' || !raw.excerpt.trim() || Buffer.byteLength(raw.excerpt) > 32 * 1024 || hasControl(raw.excerpt)
    || typeof raw.truncated !== 'boolean') return;
  try { if (normalizeLearningSourceUrl(raw.finalUrl) !== raw.finalUrl) return; } catch { return; }
  return { sourceUrl, finalUrl: raw.finalUrl, contentType: raw.contentType, bytes: raw.bytes as number,
    sha256: raw.sha256, excerpt: raw.excerpt, truncated: raw.truncated };
}

/** One bounded child per call; cancellation settles only after actual child close. */
export function readLearningSource(binary: string, rawUrl: string, signal: AbortSignal, options: { spawn?: SpawnLearningSource } = {}): Promise<SourceReadResult> {
  let url: string;
  try { url = normalizeLearningSourceUrl(rawUrl); } catch (error) { return Promise.reject(error); }
  if (!path.isAbsolute(binary)) return Promise.reject(failure('unavailable'));
  if (signal.aborted) return Promise.reject(failure('cancelled'));
  if (activeChildren >= MAX_CHILDREN) return Promise.reject(failure('busy'));
  const requestId = randomUUID();
  const payload = JSON.stringify({ schema: SCHEMA, requestId, url });
  if (Buffer.byteLength(payload) > 4096) return Promise.reject(failure('invalid_url'));
  const env: Record<string, string> = {};
  // No inherited credentials, proxy variables, home/profile paths, or Node/Rust options.
  for (const key of ['SystemRoot', 'windir']) if (process.env[key]) env[key] = process.env[key];
  let child: SkillMarketProcess;
  activeChildren++;
  try { child = (options.spawn ?? spawnChild)(binary, ['--learning-source'], { cwd: path.parse(binary).root, env }); }
  catch { activeChildren--; return Promise.reject(failure('unavailable')); }
  return new Promise((resolve, reject) => {
    let output = Buffer.alloc(0), stderrBytes = 0, failed: Error | undefined, finished = false, spawned = false;
    const stop = (code: string) => {
      failed ??= failure(code);
      try { child.kill('SIGKILL'); } catch { /* retain ownership until close */ }
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), CHILD_TIMEOUT_MS);
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true; activeChildren--; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failed || code !== 0) { reject(failed ?? failure('unavailable')); return; }
      let value: unknown;
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)); } catch { /* rejected below */ }
      if (!object(value) || value.schema !== SCHEMA || value.requestId !== requestId) { reject(failure('invalid_response')); return; }
      if (value.outcome === 'error' && keys(value, ['schema', 'requestId', 'outcome', 'code']) && typeof value.code === 'string' && CODES.has(value.code)) { reject(failure(value.code)); return; }
      const result = value.outcome === 'ok' && keys(value, ['schema', 'requestId', 'outcome', 'result']) ? parseLearningSourceResult(value.result, url) : undefined;
      if (!result) { reject(failure('invalid_response')); return; }
      resolve(result);
    };
    child.once('spawn', () => { spawned = true; });
    child.once('error', () => {
      if (!spawned && child.pid === undefined) { failed = failure('unavailable'); finish(null); }
      else stop('unavailable');
    });
    child.once('close', (code: number | null) => finish(code));
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed || finished) return;
      if (output.length + chunk.length > MAX_RESPONSE_BYTES) { stop('too_large'); return; }
      output = Buffer.concat([output, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 4096) stop('too_large'); });
    child.stdin.on('error', () => stop('unavailable')); child.stdout.on('error', () => stop('unavailable')); child.stderr.on('error', () => stop('unavailable'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort(); else child.stdin.end(payload);
  });
}
