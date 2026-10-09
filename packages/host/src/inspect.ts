import { execFile } from 'node:child_process';
import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { safeLabel } from '@extalia/core';
import type { FileContent, FileEntry, FileListing, GitChange, GitChangeKind, GitDiff, GitStatus } from '@extalia/platform';
import { errorCode } from './jsonStore.js';
import { IGNORED_DIRECTORIES, isCredentialPath, isGitInternalPath, resolveInside, type ResolvedPath } from './workspaceFs.js';

/**
 * Read-only views of a workspace for the Files and Git pages. Everything stays
 * inside the project folder, credential files are never read and Git runs
 * without a shell, with every repository setting that can start a program
 * (fsmonitor, hooks, external diff, textconv, filter drivers, pagers) switched off.
 */

export const LIST_LIMIT = 1000;
export const READ_LIMIT = 512 * 1024;
export const DIFF_LIMIT = 1024 * 1024;
const CHANGE_LIMIT = 2000;
const STATUS_BYTES = 4 * 1024 * 1024;
const UNTRACKED_DIFF_LIMIT = 200;
const MAX_FILTER_DRIVERS = 64;
const MAX_EXCLUDES = 500;
const GIT_TIMEOUT_MS = 10_000;

/** A refusal or failure whose message is safe to show to the user. */
export class InspectError extends Error {
  override name = 'InspectError';
}

export interface GitOptions {
  /** Environment Git inherits a few variables from (PATH, HOME, …). Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** The Git executable; tests use a missing one. */
  binary?: string;
  timeoutMs?: number;
}

const label = (value: string) => safeLabel(value, 160);

function fsError(error: unknown, name: string): Error {
  const code = errorCode(error);
  if (code === 'ENOENT') return new InspectError(`"${label(name)}" does not exist.`);
  if (code === 'EACCES' || code === 'EPERM') return new InspectError(`"${label(name)}" cannot be read (permission denied).`);
  if (code === 'ENOTDIR') return new InspectError(`"${label(name)}" is not a folder.`);
  if (code === 'EISDIR') return new InspectError(`"${label(name)}" is a folder.`);
  if (code === 'ELOOP') return new InspectError(`"${label(name)}" is a symbolic link loop.`);
  return error instanceof Error ? error : new Error(String(error));
}

/** `resolveInside` for reading, which also keeps `.git` internals out of reach (also through symbolic links). */
async function resolveReadable(root: string, requested: string): Promise<ResolvedPath> {
  const resolved = await resolveInside(root, requested, 'read');
  let internal = isGitInternalPath(resolved.relative);
  if (!internal) {
    const real = await realpath(resolved.absolute).catch(() => undefined);
    if (real) internal = isGitInternalPath(path.relative(await realpath(root), real));
  }
  if (internal) throw new InspectError(`"${label(resolved.relative)}" is inside .git. Use the Git view to see repository changes.`);
  return resolved;
}

const requestedPath = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value : fallback);

// ---------------------------------------------------------------------------
// Files

const compareNames = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);

function compareEntries(a: FileEntry, b: FileEntry): number {
  const folder = (entry: FileEntry) => entry.kind === 'dir' || entry.target === 'dir';
  return folder(a) === folder(b) ? compareNames(a.name, b.name) : folder(a) ? -1 : 1;
}

async function linkTarget(root: string, relative: string): Promise<FileEntry['target']> {
  try {
    const info = await stat((await resolveReadable(root, relative)).absolute);
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : undefined;
  } catch { return undefined; }
}

async function describe(root: string, folder: ResolvedPath, entry: Dirent): Promise<FileEntry | undefined> {
  const kind = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'symlink' : entry.isFile() ? 'file' : undefined;
  if (!kind) return undefined; // sockets, pipes and devices
  const relative = folder.relative === '.' ? entry.name : `${folder.relative}/${entry.name}`;
  const item: FileEntry = { name: entry.name, path: relative, kind };
  if (isCredentialPath(relative)) item.credential = true;
  if (kind === 'dir' && IGNORED_DIRECTORIES.has(entry.name)) item.generated = true;
  if (kind === 'file') {
    const size = (await lstat(path.join(folder.absolute, entry.name)).catch(() => undefined))?.size;
    if (size !== undefined) item.size = size;
  }
  if (kind === 'symlink' && !item.credential) {
    const target = await linkTarget(root, relative);
    if (target) item.target = target;
  }
  return item;
}

/** One folder level, folders first. `.git` is hidden; credential files are listed but marked. */
export async function listFiles(root: string, dir?: unknown): Promise<FileListing> {
  const folder = await resolveReadable(root, requestedPath(dir, '.'));
  let dirents: Dirent[];
  try { dirents = await readdir(folder.absolute, { withFileTypes: true }); }
  catch (error) { throw fsError(error, folder.relative); }
  const visible = dirents.filter(entry => !isGitInternalPath(entry.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? compareNames(a.name, b.name) : a.isDirectory() ? -1 : 1));
  const described = await Promise.all(visible.slice(0, LIST_LIMIT).map(entry => describe(root, folder, entry)));
  // Links to folders sort with the folders.
  const entries = described.filter((item): item is FileEntry => Boolean(item)).sort(compareEntries);
  return { path: folder.relative, entries, truncated: visible.length > LIST_LIMIT };
}

export function countLines(text: string): number {
  if (!text) return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/** A text file up to `READ_LIMIT` bytes. Binary files (NUL bytes) return no content; credential files are refused. */
export async function readWorkspaceFile(root: string, file: unknown): Promise<FileContent> {
  if (typeof file !== 'string' || !file.trim()) throw new InspectError('Choose a file to open.');
  const target = await resolveReadable(root, file);
  let handle;
  // O_NONBLOCK: opening a named pipe must not wait for a writer.
  try { handle = await open(target.absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { throw fsError(error, target.relative); }
  try {
    const info = await handle.stat();
    if (info.isDirectory()) throw new InspectError(`"${label(target.relative)}" is a folder.`);
    if (!info.isFile()) throw new InspectError(`"${label(target.relative)}" is not a regular file.`);
    const buffer = Buffer.alloc(Math.min(info.size, READ_LIMIT));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const data = buffer.subarray(0, length);
    const truncated = info.size > length;
    if (data.includes(0)) return { path: target.relative, size: info.size, binary: true, lines: 0, truncated: false };
    // Streaming decode drops a multi-byte character cut off by the limit.
    const content = new TextDecoder('utf-8').decode(data, { stream: truncated });
    return { path: target.relative, size: info.size, binary: false, content, lines: countLines(content), truncated };
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Git

/** Applied to every Git invocation: a repository's own configuration can name programs to run. */
export const GIT_SAFETY_CONFIG = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'credential.helper=',
  '-c', 'status.submoduleSummary=false', '-c', 'core.quotePath=false',
];
const DIFF_SAFETY = ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=dirty', '--submodule=short'];
const INHERITED = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'SYSTEMROOT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'TMPDIR', 'TEMP', 'TMP'];

/** Only what Git needs to find itself and the user's global settings; every other `GIT_*` variable is dropped. */
export function gitEnvironment(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
}

class GitCommandError extends Error {
  override name = 'GitCommandError';
  constructor(readonly exitCode: number | undefined, readonly stderr: string) {
    super(stderr.split('\n').find(line => line.trim())?.replace(/^(?:fatal|error): /, '').trim() || 'Git failed.');
  }
}

interface GitResult { stdout: string; truncated: boolean }

function runGit(root: string, args: readonly string[], options: GitOptions, limit: number, config: readonly string[] = []): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(options.binary ?? 'git', ['--no-pager', ...GIT_SAFETY_CONFIG, ...config, ...args], {
      cwd: root, env: gitEnvironment(options.env), timeout: options.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: limit, encoding: 'buffer', windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) { resolve({ stdout: stdout.toString('utf8'), truncated: false }); return; }
      const code = (error as { code?: unknown }).code;
      // Output over the limit: keep what fits, ending at a complete line.
      if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { resolve({ stdout: stdout.toString('utf8'), truncated: true }); return; }
      if (code === 'ENOENT') { reject(new InspectError('Git is not installed or not on the PATH. Install Git to see repository changes.')); return; }
      if (error.killed) { reject(new InspectError(`Git did not answer within ${Math.round((options.timeoutMs ?? GIT_TIMEOUT_MS) / 1000)} seconds and was stopped.`)); return; }
      reject(new GitCommandError(typeof code === 'number' ? code : undefined, stderr.toString('utf8')));
    });
    child.stdin?.end();
  });
}

const literal = (value: string) => `:(literal)${value}`;
const excluded = (value: string) => `:(exclude,literal)${value}`;

interface Repository { prefix: string; config: string[] }

/** Filter drivers (`filter.<name>.clean`, `.smudge`, `.process`) run programs on file content; switch every configured one off. */
async function filterOverrides(root: string, options: GitOptions): Promise<string[]> {
  let output: string;
  try { output = (await runGit(root, ['config', '-z', '--name-only', '--get-regexp', '^filter\\.'], options, 256 * 1024)).stdout; }
  catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) return []; // no filter configured
    throw error;
  }
  const names = new Set<string>();
  for (const key of output.split('\0')) {
    const match = /^filter\.(.+)\.[^.]+$/s.exec(key);
    if (match?.[1]) names.add(match[1]);
  }
  if (names.size > MAX_FILTER_DRIVERS || [...names].some(name => /[=\n\0]/.test(name))) {
    throw new InspectError('This repository configures content filters Extalia cannot switch off safely, so its changes are not shown.');
  }
  return [...names].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.smudge=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
}

function gitFailure(error: unknown): Error {
  if (error instanceof GitCommandError) {
    if (/dubious ownership/i.test(error.stderr)) return new InspectError('Git refuses to read this repository because the folder belongs to another user.');
    return new InspectError(`Git could not read this repository: ${safeLabel(error.message, 240)}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** The repository the project folder belongs to, or undefined. The folder may be a subfolder of it. */
async function repository(root: string, options: GitOptions): Promise<Repository | undefined> {
  await resolveInside(root, '.', 'read');
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--is-inside-work-tree', '--show-prefix'], options, 64 * 1024);
    const [inside, prefix = ''] = stdout.split('\n');
    if (inside?.trim() !== 'true') return undefined;
    return { prefix: prefix.trim(), config: await filterOverrides(root, options) };
  } catch (error) {
    if (error instanceof GitCommandError && /not a git repository/i.test(error.stderr)) return undefined;
    throw gitFailure(error);
  }
}

const KINDS: Record<string, GitChangeKind> = { '.': 'unmodified', M: 'modified', T: 'type-changed', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'unmerged' };
const kindOf = (code: string | undefined): GitChangeKind => KINDS[code ?? '.'] ?? 'modified';

export interface ParsedStatus {
  branch?: string;
  commit?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

/**
 * Parse `git status --porcelain=v2 --branch -z`. Paths in that format are
 * relative to the repository root; `prefix` (from `rev-parse --show-prefix`)
 * makes them relative to the project folder. `partial` drops a record cut off
 * by an output limit.
 */
export function parseGitStatus(output: string, prefix = '', partial = false): ParsedStatus {
  const result: ParsedStatus = { ahead: 0, behind: 0, changes: [] };
  const fields = output.split('\0');
  if (partial || fields.at(-1) === '') fields.pop();
  const local = (value: string | undefined) => (value !== undefined && value.startsWith(prefix) && value.length > prefix.length ? value.slice(prefix.length) : undefined);
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i]!;
    if (record.startsWith('# ')) {
      const [, key, ...rest] = record.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid' && value !== '(initial)') result.commit = value.slice(0, 12);
      else if (key === 'branch.head' && value !== '(detached)') result.branch = value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) { result.ahead = Number(match[1]); result.behind = Number(match[2]); }
      }
      continue;
    }
    const type = record[0];
    let change: GitChange | undefined;
    if (type === '?') {
      const file = local(record.slice(2));
      if (file) change = { path: file, index: 'unmodified', worktree: 'unmodified', untracked: true };
    } else if (type === '1' || type === '2' || type === 'u') {
      // 1 XY sub mH mI mW hH hI path | 2 XY sub mH mI mW hH hI Xscore path\0orig | u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = record.split(' ');
      const skip = type === '1' ? 8 : type === '2' ? 9 : 10;
      const file = local(parts.slice(skip).join(' '));
      const xy = parts[1] ?? '..';
      const original = type === '2' ? local(fields[++i]) : undefined;
      if (file) {
        change = { path: file, index: kindOf(xy[0]), worktree: kindOf(xy[1]) };
        if (original) change.originalPath = original;
        if (type === 'u') change.conflicted = true;
      }
    }
    if (!change) continue;
    if (isCredentialPath(change.path) || (change.originalPath && isCredentialPath(change.originalPath))) change.credential = true;
    result.changes.push(change);
  }
  return result;
}

/** Branch, upstream, ahead/behind and changed files; `{ repository: false }` outside a Git repository. */
export async function gitStatus(root: string, options: GitOptions = {}): Promise<GitStatus> {
  const repo = await repository(root, options);
  if (!repo) return { repository: false };
  let result: GitResult;
  try {
    result = await runGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--ignore-submodules=dirty', '--', '.'], options, STATUS_BYTES, repo.config);
  } catch (error) { throw gitFailure(error); }
  const parsed = parseGitStatus(result.stdout, repo.prefix, result.truncated);
  return {
    repository: true, ...parsed,
    changes: parsed.changes.slice(0, CHANGE_LIMIT),
    truncated: result.truncated || parsed.changes.length > CHANGE_LIMIT,
  };
}

/** `diff --git` text that shows an untracked file as an addition, as `git diff` would after `git add -N`. */
async function untrackedPatch(root: string, file: string): Promise<string> {
  const target = await resolveReadable(root, file);
  const info = await lstat(target.absolute);
  const header = (mode: string) => `diff --git a/${file} b/${file}\nnew file mode ${mode}\n`;
  if (info.isSymbolicLink()) {
    const link = await readlink(target.absolute);
    return `${header('120000')}--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${link}\n\\ No newline at end of file\n`;
  }
  if (!info.isFile()) return '';
  const mode = info.mode & 0o111 ? '100755' : '100644';
  const content = await readWorkspaceFile(root, file);
  if (content.binary) return `${header(mode)}Binary files /dev/null and b/${file} differ\n`;
  if (!content.content) return header(mode);
  const lines = content.content.split('\n');
  const complete = lines.at(-1) === '';
  if (complete) lines.pop();
  const body = lines.map(line => `+${line}\n`).join('');
  const note = content.truncated ? '\\ Extalia: file truncated at 512 KB\n' : complete ? '' : '\\ No newline at end of file\n';
  return `${header(mode)}--- /dev/null\n+++ b/${file}\n@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@\n${body}${note}`;
}

interface NameStatus { path: string; original?: string }

/** `git diff --name-status -z -M`: "R100\0old\0new\0", "M\0path\0". */
function parseNameStatus(output: string, partial: boolean): NameStatus[] {
  const fields = output.split('\0');
  if (partial || fields.at(-1) === '') fields.pop();
  const result: NameStatus[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i] ?? '';
    if (/^[RC]/.test(code)) { const original = fields[++i]; const file = fields[++i]; if (file) result.push({ path: file, ...(original ? { original } : {}) }); }
    else { const file = fields[++i]; if (file) result.push({ path: file }); }
  }
  return result;
}

const cutAtLine = (text: string) => text.slice(0, text.lastIndexOf('\n') + 1);

/**
 * Unified diff of the working tree against HEAD (staged and unstaged) for one
 * path or everything, with untracked files as additions. Credential files are
 * never part of it; the result is bounded to `DIFF_LIMIT` bytes.
 */
export async function gitDiff(root: string, requested?: unknown, options: GitOptions = {}): Promise<GitDiff> {
  const target = requested === undefined || requested === null || requested === '' ? undefined : (await resolveReadable(root, requestedPath(requested, '.'))).relative;
  const repo = await repository(root, options);
  if (!repo) throw new InspectError('This project folder is not a Git repository.');
  try {
    const git = (args: string[], limit: number) => runGit(root, args, options, limit, repo.config);
    const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], 4096).then(() => true, () => false);
    // Before the first commit, compare with the empty tree.
    const base = head ? 'HEAD' : (await git(['hash-object', '-t', 'tree', '--stdin'], 4096)).stdout.trim();
    const names = await git(['diff', base, '--name-status', '-z', '-M', '--relative', ...DIFF_SAFETY, '--', '.'], STATUS_BYTES);
    if (names.truncated) throw new InspectError('There are too many changes to show at once.');
    const changed = parseNameStatus(names.stdout, false);
    const credentials = [...new Set(changed.flatMap(item => [item.path, item.original ?? '']).filter(item => item && isCredentialPath(item)))];
    if (credentials.length > MAX_EXCLUDES) throw new InspectError('There are too many changed credential files to show a diff safely.');
    const scope = target && target !== '.' ? target : undefined;
    const original = scope ? changed.find(item => item.path === scope)?.original : undefined;
    const pathspecs = scope ? [literal(scope), ...(original && !isCredentialPath(original) ? [literal(original)] : [])] : ['.'];
    const tracked = await git(['diff', base, '--relative', '-M', ...DIFF_SAFETY, '--', ...pathspecs, ...credentials.map(excluded)], DIFF_LIMIT);
    let diff = tracked.truncated ? cutAtLine(tracked.stdout) : tracked.stdout;
    let truncated = tracked.truncated;
    if (!truncated) {
      const others = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', scope ? literal(scope) : '.'], STATUS_BYTES);
      const files = parseList(others.stdout, others.truncated).filter(file => !isCredentialPath(file) && !isGitInternalPath(file));
      truncated = others.truncated || files.length > UNTRACKED_DIFF_LIMIT;
      for (const file of files.slice(0, UNTRACKED_DIFF_LIMIT)) {
        const patch = await untrackedPatch(root, file).catch(() => '');
        if (Buffer.byteLength(diff) + Buffer.byteLength(patch) > DIFF_LIMIT) { truncated = true; break; }
        diff += patch;
      }
    }
    return { ...(scope ? { path: scope } : {}), diff, truncated };
  } catch (error) { throw gitFailure(error); }
}

function parseList(output: string, partial: boolean): string[] {
  const items = output.split('\0');
  if (partial || items.at(-1) === '') items.pop();
  return items.filter(Boolean);
}
