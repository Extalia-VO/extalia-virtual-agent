import { createHash, randomBytes } from 'node:crypto';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { isNotFound, readJson, writeJsonAtomic } from '../jsonStore.js';
import { ensurePrivateDirectory } from '../paths.js';
import { checkBranchName, COMMIT_CONFIG, GitRunner, isCommitId, WorktreeError, type GitRunnerOptions } from './git.js';

/**
 * Worktrees for write-capable mission workers (ADR 0028). Each worker gets its
 * own Git worktree under the Extalia data directory (never inside the user's
 * repository tree) on a unique branch created from a pinned base commit. The
 * registry records who owns each worktree; nothing with changes that were not
 * integrated is ever deleted without an explicit, fingerprint-bound user request.
 */

export interface WorktreeOwner { missionId: string; taskId: string; agentId?: string }

export interface WorktreeRecord {
  id: string;
  /** Real path of the repository working tree the worktree was created from (the user's checkout). */
  repository: string;
  /** The workspace folder relative to the repository root with `/` separators; `''` at the root. */
  prefix: string;
  /** The worktree folder under the data directory. */
  path: string;
  branch: string;
  /** Pinned base commit. */
  baseCommit: string;
  /** Branch the base came from; the default integration target. Absent for a detached or explicit-commit base. */
  baseBranch?: string;
  owner: WorktreeOwner;
  /** `active` while its task may write; `released` once the task ended and its changes were committed. */
  state: 'active' | 'released';
  /** Branch head when released. */
  head?: string;
  /** Merge commit that integrated this worktree's branch into its target. */
  integratedAs?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeHandle extends WorktreeRecord {
  /** Root for the worker's file tools: the worktree plus the workspace prefix. */
  root: string;
}

export interface WorktreeStatus {
  id: string;
  head: string;
  baseCommit: string;
  /** Uncommitted changes (tracked or untracked) in the worktree. */
  dirty: boolean;
  changedPaths: number;
  /** Commits on the worker branch since the base. */
  ahead: number;
  /** Commits on the target branch the worker branch does not have (0 without a target). */
  behind: number;
  targetBranch?: string;
  /** The branch head is contained in the target branch. */
  merged: boolean;
  /**
   * SHA-256 over the head, the porcelain status and the tracked working-tree diff. A user who
   * discards unmerged work must send back the fingerprint they were shown; any change invalidates it.
   */
  fingerprint: string;
}

export interface DiffFile { path: string; added?: number; deleted?: number; binary?: true }
export interface DiffSummary { from: string; to: string; files: DiffFile[]; truncated: boolean; digest: string }

export type OrphanReason = 'owner-ended' | 'missing' | 'unregistered';
export interface WorktreeOrphan {
  reason: OrphanReason;
  path: string;
  id?: string;
  branch?: string;
  owner?: WorktreeOwner;
  dirty?: boolean;
  /** True when the branch has commits not contained in its target (or the status could not be read). */
  unmerged?: boolean;
}

export interface WorktreeManagerOptions {
  /** Folder that holds every worktree, under the Extalia data directory. */
  directory: string;
  /** Registry file (private JSON). */
  registryFile: string;
  git?: GitRunnerOptions;
  /** Whether the owning mission task is still running; such worktrees are never removed. */
  isOwnerActive?(owner: WorktreeOwner): boolean;
}

const SCHEMA = 'extalia.worktrees.v1';
const MAX_RECORDS = 256;
const MAX_DIFF_FILES = 2_000;
export const DIFF_LIMIT = 32 * 1024 * 1024;
const ID = /^[wi]-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MERGE_DRIVERS_BUILT_IN = new Set(['text', 'binary', 'union']);
const sha256 = (...parts: (string | Buffer)[]) => {
  const hash = createHash('sha256');
  for (const part of parts) { hash.update(part); hash.update('\0'); }
  return `sha256:${hash.digest('hex')}`;
};

export const newWorktreeId = (kind: 'w' | 'i') => `${kind}-${randomBytes(6).toString('hex')}`;

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validRecord(raw: unknown): raw is WorktreeRecord {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as WorktreeRecord;
  return typeof record.id === 'string' && ID.test(record.id) && record.id.startsWith('w-')
    && typeof record.repository === 'string' && path.isAbsolute(record.repository) && typeof record.prefix === 'string' && !record.prefix.split('/').includes('..')
    && typeof record.path === 'string' && path.isAbsolute(record.path) && record.branch === `extalia/worker/${record.id}`
    && isCommitId(record.baseCommit) && (record.baseBranch === undefined || typeof record.baseBranch === 'string')
    && !!record.owner && typeof record.owner === 'object' && typeof record.owner.missionId === 'string' && UUID.test(record.owner.missionId)
    && typeof record.owner.taskId === 'string' && UUID.test(record.owner.taskId) && (record.owner.agentId === undefined || typeof record.owner.agentId === 'string' && UUID.test(record.owner.agentId))
    && (record.state === 'active' || record.state === 'released') && (record.head === undefined || isCommitId(record.head))
    && (record.integratedAs === undefined || isCommitId(record.integratedAs)) && typeof record.createdAt === 'string' && typeof record.updatedAt === 'string';
}

/** Tracked/untracked change records in `git status --porcelain=v2 -z` output (renames carry a second path). */
function countStatus(output: Buffer): number {
  const fields = output.toString('utf8').split('\0');
  let count = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (!field || field.startsWith('#')) continue;
    count++;
    if (field.startsWith('2 ')) index++;
  }
  return count;
}

export class WorktreeManager {
  readonly git: GitRunner;
  private records: WorktreeRecord[] = [];
  private chain: Promise<unknown> = Promise.resolve();
  /** Worktrees a previous run left `active`: their task cannot still be running in this process. */
  private readonly startupOrphans = new Set<string>();

  private constructor(private readonly options: WorktreeManagerOptions) {
    this.git = new GitRunner(options.git);
  }

  get directory(): string { return path.resolve(this.options.directory); }

  /** Load the registry. Records left `active` by a previous process are orphans (detected, never deleted). */
  static async open(options: WorktreeManagerOptions): Promise<WorktreeManager> {
    const manager = new WorktreeManager(options);
    const stored = await readJson<{ schema?: unknown; worktrees?: unknown } | undefined>(options.registryFile, undefined);
    if (stored !== undefined) {
      if (stored.schema !== SCHEMA || !Array.isArray(stored.worktrees) || stored.worktrees.length > MAX_RECORDS || !stored.worktrees.every(validRecord)) {
        throw new WorktreeError('invalid', 'The worktree registry is unreadable. It was left unchanged; nothing was deleted.');
      }
      manager.records = stored.worktrees;
    }
    for (const record of manager.records) if (record.state === 'active') manager.startupOrphans.add(record.id);
    return manager;
  }

  /** Serialize registry changes and Git administration (worktree add/remove, ref updates). */
  serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async persist(): Promise<void> {
    await ensurePrivateDirectory(path.dirname(this.options.registryFile));
    await writeJsonAtomic(this.options.registryFile, { schema: SCHEMA, worktrees: this.records }, { mode: 0o600 });
  }

  private ownerActive(record: WorktreeRecord): boolean {
    if (this.startupOrphans.has(record.id)) return false;
    return this.options.isOwnerActive?.(record.owner) ?? record.state === 'active';
  }

  list(): WorktreeRecord[] { return structuredClone(this.records); }

  get(id: string): WorktreeRecord {
    const record = typeof id === 'string' ? this.records.find(item => item.id === id) : undefined;
    if (!record) throw new WorktreeError('not_found', 'This worktree does not exist.');
    return structuredClone(record);
  }

  /** Tool root of a worktree: the worktree folder plus the workspace prefix. */
  root(record: Pick<WorktreeRecord, 'path' | 'prefix'>): string {
    return record.prefix ? path.join(record.path, ...record.prefix.split('/')) : record.path;
  }

  /**
   * Create a worktree for one worker. `base` is `HEAD` (default), a local branch or a commit id; it is
   * resolved to a commit once and pinned. Refuses non-Git folders, bare repositories, repositories with
   * submodules, Git LFS or other filter/merge drivers, and any layout that would put the worktree inside the repository.
   */
  create(input: { workspaceRoot: string; owner: WorktreeOwner; base?: string }): Promise<WorktreeHandle> {
    return this.serial(async () => {
      if (!UUID.test(input.owner?.missionId ?? '') || !UUID.test(input.owner?.taskId ?? '') || (input.owner.agentId !== undefined && !UUID.test(input.owner.agentId))) throw new WorktreeError('invalid', 'A worktree needs a mission task as owner.');
      if (this.records.length >= MAX_RECORDS) throw new WorktreeError('in_use', 'Too many worker worktrees exist. Integrate or remove some first.');
      let workspace: string;
      try { workspace = await realpath(input.workspaceRoot); } catch { throw new WorktreeError('not_found', 'The project folder is not available.'); }
      await ensurePrivateDirectory(this.directory);
      const directory = await realpath(this.directory);
      if (isWithin(directory, workspace)) throw new WorktreeError('location', 'This folder is already an Extalia worktree; workers cannot create worktrees from it.');
      let info: string[];
      try {
        info = (await this.git.text(workspace, ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir', '--show-prefix'])).split('\n');
      } catch (error) {
        if (error instanceof WorktreeError && error.code === 'not_git') throw notGit();
        throw error;
      }
      if (info[0]?.trim() === 'true' || info[1]?.trim() !== 'true') throw notGit();
      const repository = await realpath(info[2]!.trim());
      const commonDir = await realpath(path.resolve(workspace, info[3]!.trim()));
      const prefix = (info[4] ?? '').trim().replace(/\/+$/, '');
      if (isWithin(repository, directory) || isWithin(commonDir, directory)) {
        throw new WorktreeError('location', 'The Extalia data folder is inside this repository, so worker worktrees would land in the project. Move the data folder (EXTALIA_HOME) outside the repository.');
      }
      if (isWithin(directory, repository) || isWithin(directory, commonDir)) throw new WorktreeError('location', 'This repository lives inside the Extalia data folder; workers cannot use it.');
      const base = input.base ?? 'HEAD';
      if (base !== 'HEAD' && !isCommitId(base)) checkBranchName(base);
      const resolved = await this.git.run(repository, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${base === 'HEAD' || isCommitId(base) ? base : `refs/heads/${base}`}^{commit}`], { accept: [0, 1] });
      const baseCommit = resolved.stdout.toString('utf8').trim();
      if (resolved.exitCode !== 0 || !isCommitId(baseCommit)) throw new WorktreeError('not_found', base === 'HEAD' ? 'The repository has no commit yet. Make a first commit before running write-capable workers.' : 'The base branch or commit does not exist.');
      let baseBranch: string | undefined;
      if (base === 'HEAD') {
        const symbolic = await this.git.run(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { accept: [0, 1] });
        const name = symbolic.stdout.toString('utf8').trim();
        if (symbolic.exitCode === 0 && name) baseBranch = name;
      } else if (!isCommitId(base)) baseBranch = base;
      await this.assertSupported(repository, baseCommit);
      const id = newWorktreeId('w'), branch = `extalia/worker/${id}`, target = path.join(directory, id);
      const exists = await this.git.run(repository, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { accept: [0, 1] });
      if (exists.exitCode === 0) throw new WorktreeError('in_use', 'A worker branch with this name already exists; nothing was overwritten.');
      const filters = await this.git.filterOverrides(repository);
      try {
        await this.git.run(repository, ['worktree', 'add', '--no-track', '-b', branch, target, baseCommit], { config: filters, timeoutMs: 180_000 });
        const head = (await this.git.text(target, ['rev-parse', 'HEAD'])).trim();
        if (head !== baseCommit || !isWithin(directory, await realpath(target))) throw new WorktreeError('git_failed', 'The worktree was not created at the pinned base commit.');
      } catch (error) {
        // Only this call's fresh worktree and branch are undone; they hold nothing yet.
        await this.git.run(repository, ['worktree', 'remove', '--force', target], { accept: [0, 128] }).catch(() => undefined);
        await this.git.run(repository, ['update-ref', '-d', `refs/heads/${branch}`, baseCommit], { accept: [0, 128] }).catch(() => undefined);
        throw error;
      }
      const at = new Date().toISOString();
      const record: WorktreeRecord = {
        id, repository, prefix, path: target, branch, baseCommit, ...(baseBranch ? { baseBranch } : {}),
        owner: { missionId: input.owner.missionId, taskId: input.owner.taskId, ...(input.owner.agentId ? { agentId: input.owner.agentId } : {}) },
        state: 'active', createdAt: at, updatedAt: at,
      };
      this.records.push(record);
      await this.persist();
      return { ...structuredClone(record), root: this.root(record) };
    });
  }

  /** Submodules and attribute-selected filter or custom merge drivers are refused (documented in ADR 0028). */
  private async assertSupported(repository: string, commit: string): Promise<void> {
    const modules = await this.git.run(repository, ['cat-file', '-e', `${commit}:.gitmodules`], { accept: [0, 128] });
    if (modules.exitCode === 0) throw new WorktreeError('unsupported', 'This repository uses Git submodules, which write-capable workers do not support yet. Run the task read-only.');
    const attributes = await this.git.run(repository, ['grep', '-I', '-h', '-E', '-e', '(filter|merge)=', commit, '--', '.gitattributes', '*/.gitattributes'], { accept: [0, 1], limit: 1024 * 1024 });
    for (const token of attributes.stdout.toString('utf8').split(/\s+/)) {
      const filter = /^filter=(.+)$/.exec(token);
      if (filter) throw new WorktreeError('unsupported', filter[1] === 'lfs' ? 'This repository uses Git LFS, which write-capable workers do not support yet. Run the task read-only.' : 'This repository selects content filters in .gitattributes, which write-capable workers do not support. Run the task read-only.');
      const merge = /^merge=(.+)$/.exec(token);
      if (merge && !MERGE_DRIVERS_BUILT_IN.has(merge[1]!)) throw new WorktreeError('unsupported', 'This repository selects a custom merge driver in .gitattributes, which integration does not run. Run the task read-only.');
    }
    const drivers = await this.git.run(repository, ['config', '--name-only', '--get-regexp', '^merge\\..*\\.driver$'], { accept: [0, 1] });
    if (drivers.exitCode === 0 && drivers.stdout.toString('utf8').trim()) throw new WorktreeError('unsupported', 'This repository configures a custom merge driver, which integration does not run. Run the task read-only.');
  }

  private async existing(record: WorktreeRecord): Promise<boolean> {
    try { return (await stat(record.path)).isDirectory(); } catch (error) { if (isNotFound(error)) return false; throw error; }
  }

  private async targetTip(record: WorktreeRecord): Promise<string | undefined> {
    if (!record.baseBranch) return undefined;
    const tip = await this.git.run(record.repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${record.baseBranch}^{commit}`], { accept: [0, 1] });
    const value = tip.stdout.toString('utf8').trim();
    return tip.exitCode === 0 && isCommitId(value) ? value : undefined;
  }

  /** Dirty state, commits ahead of the base and behind the target, and a fingerprint for confirmations. */
  async status(id: string): Promise<WorktreeStatus> {
    const record = this.get(id);
    if (!await this.existing(record)) throw new WorktreeError('not_found', 'This worktree folder is missing.');
    const filters = await this.git.filterOverrides(record.path);
    const head = (await this.git.text(record.path, ['rev-parse', 'HEAD'])).trim();
    const porcelain = (await this.git.run(record.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all'], { config: filters })).stdout;
    const tracked = (await this.git.run(record.path, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD'], { config: filters, limit: DIFF_LIMIT })).stdout;
    const changedPaths = countStatus(porcelain);
    const ahead = Number((await this.git.text(record.path, ['rev-list', '--count', `${record.baseCommit}..HEAD`])).trim()) || 0;
    const tip = await this.targetTip(record);
    let behind = 0, merged = head === record.baseCommit && ahead === 0;
    if (tip) {
      behind = Number((await this.git.text(record.path, ['rev-list', '--count', `HEAD..${tip}`])).trim()) || 0;
      merged = (await this.git.run(record.path, ['merge-base', '--is-ancestor', head, tip], { accept: [0, 1] })).exitCode === 0;
    }
    return {
      id, head, baseCommit: record.baseCommit, dirty: changedPaths > 0, changedPaths, ahead, behind, ...(record.baseBranch ? { targetBranch: record.baseBranch } : {}), merged,
      fingerprint: sha256(head, porcelain, tracked),
    };
  }

  /** Committed changes between two commits (default: base → worker head) with a digest over the exact binary diff. */
  async diff(id: string, range?: { from: string; to: string; cwd?: string }): Promise<DiffSummary> {
    const record = this.get(id);
    const cwd = range?.cwd ?? record.path;
    const from = range?.from ?? record.baseCommit;
    const to = range?.to ?? (await this.git.text(cwd, ['rev-parse', 'HEAD'])).trim();
    return diffSummary(this.git, cwd, from, to);
  }

  /**
   * The task ended: commit whatever the worker wrote (hooks and signing off, fixed identity) and mark
   * the worktree `released`. A failure leaves it `active`, which orphan detection reports.
   */
  release(id: string, message: string): Promise<WorktreeRecord> {
    return this.serial(async () => {
      const record = this.records.find(item => item.id === id);
      if (!record) throw new WorktreeError('not_found', 'This worktree does not exist.');
      const filters = await this.git.filterOverrides(record.path);
      const porcelain = (await this.git.run(record.path, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { config: filters })).stdout;
      if (countStatus(porcelain) > 0) {
        await this.git.run(record.path, ['add', '-A', '--', '.'], { config: filters, timeoutMs: 120_000 });
        await this.git.run(record.path, ['commit', '--no-verify', '--quiet', '-m', message.slice(0, 200)], { config: [...filters, ...COMMIT_CONFIG], timeoutMs: 120_000 });
      }
      record.head = (await this.git.text(record.path, ['rev-parse', 'HEAD'])).trim();
      record.state = 'released';
      record.updatedAt = new Date().toISOString();
      this.startupOrphans.delete(record.id);
      await this.persist();
      return structuredClone(record);
    });
  }

  /** Recorded by the integration queue after a user-approved merge. */
  markIntegrated(id: string, commit: string): Promise<void> {
    return this.serial(async () => {
      const record = this.records.find(item => item.id === id);
      if (!record || !isCommitId(commit)) return;
      record.integratedAs = commit; record.updatedAt = new Date().toISOString();
      await this.persist();
    });
  }

  /**
   * Remove a worktree and its branch. Refused while its task runs. A worktree with uncommitted changes
   * or commits its target does not contain is removed only when the caller passes the exact
   * `fingerprint` from `status()` — the explicit user path ("discard these changes"). Never called by
   * workers or tools.
   */
  remove(id: string, confirm?: { fingerprint: string }): Promise<void> {
    return this.serial(async () => {
      const record = this.records.find(item => item.id === id);
      if (!record) throw new WorktreeError('not_found', 'This worktree does not exist.');
      if (this.ownerActive(record)) throw new WorktreeError('in_use', 'This worktree belongs to a task that is still running.');
      if (await this.existing(record)) {
        const status = await this.status(id);
        const unmerged = status.dirty || !status.merged;
        if (unmerged && !confirm) throw new WorktreeError('unmerged_changes', 'This worktree has changes that were not integrated. Review them, then discard them explicitly to remove it.');
        if (unmerged && confirm?.fingerprint !== status.fingerprint) throw new WorktreeError('confirmation_mismatch', 'The worktree changed since you reviewed it. Review it again before discarding.');
        await this.git.run(record.repository, ['worktree', 'remove', ...(status.dirty ? ['--force'] : []), record.path], { timeoutMs: 120_000 });
        // Compare-and-delete: only the head that was reviewed (or merged) is removed.
        await this.git.run(record.repository, ['update-ref', '-d', `refs/heads/${record.branch}`, status.head], { accept: [0, 128] });
      }
      // A missing folder: the branch (and its commits) stay; Git prunes its own administrative entry later.
      this.records = this.records.filter(item => item !== record);
      this.startupOrphans.delete(record.id);
      await this.persist();
    });
  }

  /**
   * Worktrees whose task is no longer running but were never released (a crash or an
   * interrupted host), registered worktrees whose folder is missing, and folders under the
   * worktree directory the registry does not know. Reported only; nothing is deleted.
   */
  async orphans(): Promise<WorktreeOrphan[]> {
    const found: WorktreeOrphan[] = [];
    for (const record of this.list()) {
      if (!await this.existing(record)) { found.push({ reason: 'missing', id: record.id, path: record.path, branch: record.branch, owner: record.owner }); continue; }
      if (record.state !== 'active' || this.ownerActive(record)) continue;
      let dirty: boolean | undefined, unmerged = true;
      try { const status = await this.status(record.id); dirty = status.dirty; unmerged = status.dirty || !status.merged; } catch { /* reported as unmerged */ }
      found.push({ reason: 'owner-ended', id: record.id, path: record.path, branch: record.branch, owner: record.owner, ...(dirty !== undefined ? { dirty } : {}), unmerged });
    }
    let entries: string[] = [];
    try { entries = await readdir(this.directory); } catch (error) { if (!isNotFound(error)) throw error; }
    const known = new Set(this.records.map(record => path.basename(record.path)));
    for (const name of entries.sort()) if (!known.has(name)) found.push({ reason: 'unregistered', path: path.join(this.directory, name) });
    return found;
  }
}

function notGit(): WorktreeError {
  return new WorktreeError('not_git', 'Write-capable workers need a Git repository with at least one commit. Initialize one (git init, first commit) or run the task read-only.');
}

/** `from..to` file list and digest. The digest covers the exact binary diff, so any byte change alters it. */
export async function diffSummary(git: GitRunner, cwd: string, from: string, to: string): Promise<DiffSummary> {
  if (!isCommitId(from) || !isCommitId(to)) throw new WorktreeError('invalid', 'A diff needs two commits.');
  const config = await git.filterOverrides(cwd);
  const flags = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--ignore-submodules=all'];
  const patch = (await git.run(cwd, ['diff', '--binary', '--full-index', ...flags, from, to, '--'], { config, limit: DIFF_LIMIT })).stdout;
  const numstat = (await git.run(cwd, ['diff', '--numstat', '-z', ...flags, from, to, '--'], { config, limit: 8 * 1024 * 1024 })).stdout.toString('utf8');
  const files: DiffFile[] = [];
  let truncated = false;
  for (const entry of numstat.split('\0')) {
    if (!entry) continue;
    const [added, deleted, ...rest] = entry.split('\t');
    const file = rest.join('\t');
    if (!file) continue;
    if (files.length >= MAX_DIFF_FILES) { truncated = true; break; }
    files.push(added === '-' ? { path: file, binary: true } : { path: file, added: Number(added), deleted: Number(deleted) });
  }
  return { from, to, files, truncated, digest: sha256('extalia.diff.v1', from, to, patch) };
}
