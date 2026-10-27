import { execFile } from 'node:child_process';
import { safeLabel } from '@extalia/core';
import { GIT_SAFETY_CONFIG, gitEnvironment } from '../inspect.js';

/**
 * Git for write-capable mission workers (ADR 0028). Runs the `git` CLI without a
 * shell, with a timeout and an output limit, with only the few environment
 * variables Git needs (no credentials, no `GIT_*` overrides), and with every
 * repository setting that can start a program switched off (hooks, fsmonitor,
 * external diff, pager, credential helper; filter drivers per repository).
 */

export type WorktreeErrorCode =
  | 'git_unavailable' | 'git_failed' | 'timeout' | 'too_large' | 'not_git' | 'unsupported' | 'location'
  | 'not_found' | 'in_use' | 'unmerged_changes' | 'confirmation_mismatch' | 'invalid' | 'not_ready' | 'stale';

/** A refusal or failure whose message is safe to show to the user. */
export class WorktreeError extends Error {
  override name = 'WorktreeError';
  constructor(readonly code: WorktreeErrorCode, message: string) { super(message); }
}

export interface GitRunnerOptions {
  /** Environment Git inherits a few variables from (PATH, HOME, …). Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The Git executable; defaults to `git` on the PATH. */
  binary?: string;
  /** Per invocation, default 60 s. */
  timeoutMs?: number;
}

export interface GitOutput { stdout: Buffer; stderr: string; exitCode: number }

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_LIMIT = 4 * 1024 * 1024;
const MAX_FILTER_DRIVERS = 64;

/** Commits Extalia makes in worker and integration worktrees: fixed identity, never signed (no external program). */
export const COMMIT_CONFIG = ['-c', 'user.name=Extalia worker', '-c', 'user.email=worker@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'merge.renames=true'];

export class GitRunner {
  constructor(private readonly options: GitRunnerOptions = {}) {}

  /** Run Git in `cwd`. Exit codes outside `accept` throw `WorktreeError('git_failed')`. */
  run(cwd: string, args: readonly string[], extra: { limit?: number; config?: readonly string[]; accept?: readonly number[]; timeoutMs?: number } = {}): Promise<GitOutput> {
    const limit = extra.limit ?? DEFAULT_LIMIT, timeoutMs = extra.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const accept = extra.accept ?? [0];
    return new Promise((resolve, reject) => {
      const child = execFile(this.options.binary ?? 'git', ['--no-pager', ...GIT_SAFETY_CONFIG, ...(extra.config ?? []), ...args], {
        cwd, env: gitEnvironment(this.options.env ?? process.env), timeout: timeoutMs, maxBuffer: limit, encoding: 'buffer', windowsHide: true,
      }, (error, stdout, stderr) => {
        const errorText = stderr.toString('utf8');
        if (!error) { resolve({ stdout, stderr: errorText, exitCode: 0 }); return; }
        const code = (error as { code?: unknown }).code;
        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { reject(new WorktreeError('too_large', 'Git produced more output than Extalia accepts for this repository.')); return; }
        if (code === 'ENOENT') { reject(new WorktreeError('git_unavailable', 'Git is not installed or not on the PATH. Install Git to use write-capable workers.')); return; }
        if (error.killed) { reject(new WorktreeError('timeout', `Git did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`)); return; }
        if (typeof code === 'number' && accept.includes(code)) { resolve({ stdout, stderr: errorText, exitCode: code }); return; }
        reject(gitFailure(errorText));
      });
      child.stdin?.end();
    });
  }

  async text(cwd: string, args: readonly string[], extra: Parameters<GitRunner['run']>[2] = {}): Promise<string> {
    return (await this.run(cwd, args, extra)).stdout.toString('utf8');
  }

  /**
   * Switch off every configured filter driver (`filter.<name>.clean/smudge/process`): they run programs on
   * file content. Repositories whose attributes select a filter are refused before this matters (ADR 0028).
   */
  async filterOverrides(cwd: string): Promise<string[]> {
    const { stdout, exitCode } = await this.run(cwd, ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], { limit: 256 * 1024, accept: [0, 1] });
    if (exitCode === 1) return [];
    const names = new Set<string>();
    for (const key of stdout.toString('utf8').split('\0')) {
      const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
      if (match?.[1]) names.add(match[1]);
    }
    if (names.size > MAX_FILTER_DRIVERS || [...names].some(name => /[=\n\0]/.test(name))) {
      throw new WorktreeError('unsupported', 'This repository configures content filters Extalia cannot switch off safely, so write-capable workers are not available for it.');
    }
    return [...names].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
  }
}

export function gitFailure(stderr: string): WorktreeError {
  if (/dubious ownership/i.test(stderr)) return new WorktreeError('git_failed', 'Git refuses this repository because the folder belongs to another user.');
  if (/not a git repository/i.test(stderr)) return new WorktreeError('not_git', 'The project folder is not a Git repository.');
  const line = stderr.split('\n').find(item => item.trim())?.replace(/^(?:fatal|error): /, '').trim() || 'Git failed.';
  return new WorktreeError('git_failed', `Git failed: ${safeLabel(line, 240)}`);
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const isCommitId = (value: unknown): value is string => typeof value === 'string' && SHA.test(value);

/**
 * A local branch name a caller may name as an integration target. Conservative subset of
 * `git check-ref-format --branch`; the full check still runs in Git.
 */
export function checkBranchName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock') || value.split('/').some(part => part.startsWith('.'))) {
    throw new WorktreeError('invalid', 'Choose a plain local branch name.');
  }
  return value;
}
