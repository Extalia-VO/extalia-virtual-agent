import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { constants, type Stats } from 'node:fs';
import path from 'node:path';
import { redact } from '@extalia/core';
import type { ContextToolOptimization, ContextToolOptimizer } from '@extalia/runtime';

export interface CavemanProcessOptions { cwd: string; env: NodeJS.ProcessEnv }
export interface CavemanContextOptimizerOptions {
  /** Explicitly selected local engine executable; no PATH lookup or shell command. */
  executable: string;
  /** Trusted host scratch parent. Each call creates a private, disposable CCR store. */
  directory: string;
  assertCurrent(): void | Promise<void>;
  timeoutMs?: number;
  /** Only system locale/Windows runtime entries are admitted from this environment. */
  env?: NodeJS.ProcessEnv;
  /** Host process seam for deterministic lifecycle/contract tests. */
  spawn?(executable: string, args: readonly string[], options: CavemanProcessOptions): ChildProcessWithoutNullStreams;
}

const MAX_INPUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const HANDLE = /^ccr_[a-f0-9]{32}$/;
const LABEL = /^[a-z0-9][a-z0-9_:./-]{0,95}$/i;
const REFERENCE = /^[a-f0-9]{64}$/;
class EngineFailure extends Error { constructor(readonly reason: string) { super(reason); } }
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000_000;
const defaultSpawn: NonNullable<CavemanContextOptimizerOptions['spawn']> = (binary, args, options) => spawn(binary, [...args], {
  ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
});

function privateEnvironment(source: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) {
    const value = source[key];
    if (typeof value === 'string' && value.length <= 4096 && !value.includes('\0')) env[key] = value;
  }
  // Never inherit provider keys, proxies, preload flags, real home paths, or a shared CCR.
  return { ...env, HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory, XDG_DATA_HOME: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory, CAVEMAN_HOME: directory,
    CAVEMAN_CCR_DB: path.join(directory, 'recovery.db'), NO_COLOR: '1', DO_NOT_TRACK: '1' };
}

async function run(options: CavemanContextOptimizerOptions, binary: string, args: readonly string[], input: Buffer,
  directory: string, env: NodeJS.ProcessEnv, signal: AbortSignal, timeoutMs: number, maxOutputBytes: number) {
  signal.throwIfAborted();
  return new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = (options.spawn ?? defaultSpawn)(binary, args, { cwd: directory, env }); }
    catch { reject(new EngineFailure('engine-start-failed')); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, errorBytes = 0, failure: EngineFailure | undefined;
    const stop = (reason: string) => {
      failure ??= new EngineFailure(reason);
      child.stdin.destroy();
      child.kill('SIGKILL');
    };
    const abort = () => stop('cancelled');
    const timer = setTimeout(() => stop('engine-timeout'), Math.max(1, timeoutMs));
    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (value: Buffer) => {
      outputBytes += value.length;
      if (outputBytes > maxOutputBytes) stop('engine-output-limit');
      else if (!failure) stdout.push(value);
    });
    child.stderr.on('data', (value: Buffer) => {
      errorBytes += value.length;
      if (errorBytes > MAX_STDERR_BYTES) stop('engine-report-limit');
      else if (!failure) stderr.push(value);
    });
    child.on('error', () => { failure ??= new EngineFailure('engine-start-failed'); });
    child.stdin.on('error', () => { failure ??= new EngineFailure('engine-input-failed'); });
    // Wait for close, not only exit: cancellation/failure never races live pipes or
    // ongoing child writes with CCR cleanup and the caller's next admission.
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (signal.aborted) { reject(signal.reason ?? new EngineFailure('cancelled')); return; }
      if (failure || code !== 0) { reject(failure ?? new EngineFailure('engine-exit-failed')); return; }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
    if (signal.aborted) abort();
    else child.stdin.end(input);
  });
}

/**
 * Optional Caveman Engine CLI adapter, verified against upstream b4ee71d (compress:
 * payload stdout + one JSON stderr report; retrieve HANDLE: exact source stdout).
 * It does not install Caveman, run a proxy, change agent config, or call a provider.
 * Extalia's acknowledged scoped archive remains the durable recovery owner after
 * the private engine CCR is verified and removed.
 */
export function createCavemanContextOptimizer(options: CavemanContextOptimizerOptions): ContextToolOptimizer {
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs! > 0
    ? Math.min(options.timeoutMs!, 15_000) : 5000;
  return async request => {
    request.signal.throwIfAborted();
    const check = async () => {
      request.signal.throwIfAborted();
      try { await options.assertCurrent(); } catch { throw new EngineFailure('scope-unavailable'); }
      request.signal.throwIfAborted();
    };
    let temporary: string | undefined;
    let outcome: ContextToolOptimization;
    try {
      await check();
      if (!path.isAbsolute(options.executable) || options.executable.includes('\0')) throw new EngineFailure('engine-path-required');
      if (!path.isAbsolute(options.directory) || options.directory.includes('\0')) throw new EngineFailure('private-directory-required');
      if (!REFERENCE.test(request.recovery.reference) || !integer(request.recovery.messageIndex) || !integer(request.recovery.resultIndex)
        || !/^[a-z][a-z0-9_]{0,63}$/.test(request.recovery.readToolName)) throw new EngineFailure('recovery-receipt-required');
      if (!integer(request.maxCharacters) || request.maxCharacters < 1) throw new EngineFailure('invalid-output-budget');
      const content = redact(request.content), input = Buffer.from(content);
      if (input.length > MAX_INPUT_BYTES || input.toString('utf8') !== content) throw new EngineFailure('engine-input-limit');
      let binary: string, executableInfo: Stats;
      try {
        binary = await realpath(options.executable); executableInfo = await lstat(binary);
        if (!executableInfo.isFile() || executableInfo.isSymbolicLink()) throw new Error('Not an executable file');
        await access(binary, constants.X_OK);
      } catch { throw new EngineFailure('engine-unavailable'); }
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      const root = await lstat(options.directory), canonicalRoot = await realpath(options.directory);
      if (!root.isDirectory() || root.isSymbolicLink() || process.platform !== 'win32' && (root.mode & 0o077) !== 0) throw new EngineFailure('private-directory-required');
      const unchanged = async () => {
        await check();
        const current = await lstat(options.directory);
        if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== root.dev || current.ino !== root.ino
          || await realpath(options.directory) !== canonicalRoot || !same(executableInfo, await lstat(binary))) throw new EngineFailure('engine-or-directory-changed');
      };
      await unchanged();
      temporary = await mkdtemp(path.join(canonicalRoot, 'caveman-'));
      const env = privateEnvironment(options.env ?? process.env, temporary);
      const deadline = Date.now() + timeoutMs;
      const compressed = await run(options, binary, ['compress'], input, temporary, env, request.signal, timeoutMs, MAX_INPUT_BYTES);
      await unchanged();
      let report: Record<string, unknown>, output: string;
      try {
        report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(compressed.stderr)) as Record<string, unknown>;
        output = new TextDecoder('utf-8', { fatal: true }).decode(compressed.stdout);
      } catch { throw new EngineFailure('invalid-engine-report'); }
      if (!report || Array.isArray(report) || report.basis !== 'inferred' || !integer(report.tokens_before) || !integer(report.tokens_after)
        || typeof report.token_count_basis !== 'string' || !LABEL.test(report.token_count_basis)) throw new EngineFailure('invalid-engine-report');
      const accounting = { tokensBefore: report.tokens_before, tokensAfter: report.tokens_after, tokenCountBasis: report.token_count_basis };
      if (report.error !== undefined) throw new EngineFailure(report.error === 'cave_ccr_budget_exceeded' ? 'engine-recovery-capacity' : 'engine-recovery-failed');
      if (compressed.stdout.equals(input)) outcome = { status: 'unchanged', reason: 'engine-pass-through', ...accounting };
      else {
        if (typeof report.recovery_handle !== 'string' || !HANDLE.test(report.recovery_handle)
          || typeof report.method !== 'string' || !LABEL.test(report.method)
          || !output.length || output.length > request.maxCharacters || compressed.stdout.length >= input.length
          || report.tokens_after >= report.tokens_before || output !== redact(output)
          || output.includes(report.recovery_handle) || output.includes('caveman_retrieve')) throw new EngineFailure('invalid-engine-transform');
        if (Date.now() >= deadline) throw new EngineFailure('engine-timeout');
        const recovered = await run(options, binary, ['retrieve', report.recovery_handle], Buffer.alloc(0), temporary, env,
          request.signal, deadline - Date.now(), input.length + 1);
        await unchanged();
        if (!recovered.stdout.equals(input) || recovered.stderr.length) throw new EngineFailure('engine-recovery-mismatch');
        outcome = { status: 'compressed', content: output, method: report.method, ...accounting };
      }
      await unchanged();
    } catch (error) {
      if (request.signal.aborted) throw error;
      outcome = { status: 'unavailable', reason: error instanceof EngineFailure ? error.reason : 'engine-unavailable' };
    } finally {
      if (temporary) {
        // Never publish a candidate while its disposable local source cannot be cleared.
        try { await rm(temporary, { recursive: true, force: true }); }
        catch { outcome = { status: 'unavailable', reason: 'engine-cleanup-failed' }; }
      }
    }
    if (request.signal.aborted) request.signal.throwIfAborted();
    try { await check(); } catch (error) {
      if (request.signal.aborted) throw error;
      return { status: 'unavailable', reason: 'scope-unavailable' };
    }
    return outcome!;
  };
}
