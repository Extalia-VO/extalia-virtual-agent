import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { redact, safeText } from '@extalia/core';
import { readJson, writeJsonAtomic } from '../jsonStore.js';
import { ensurePrivateDirectory } from '../paths.js';
import { createCommandTool } from '../tools/command.js';
import { checkBranchName, COMMIT_CONFIG, isCommitId, WorktreeError } from './git.js';
import { diffSummary, isWithin, newWorktreeId, type DiffFile, type WorktreeManager } from './manager.js';

/**
 * Serial integration queue (ADR 0028). A proposal merges one released worker
 * branch onto the current target tip in a disposable integration worktree,
 * runs the workspace's test gate there and records the diff digest. Applying a
 * proposal needs the user's approval bound to that digest; it only ever moves
 * the target branch forward (fast-forward in a checkout, or compare-and-swap of
 * the ref), never with force. Conflicts are reported with their paths and
 * never resolved automatically.
 */

export interface IntegrationGate {
  /** The workspace's configured check (for example `pnpm test`). Never chosen by a model. */
  command: string;
  /** 1–1800 s, default 600 s. */
  timeoutSeconds?: number;
}

/**
 * Test gate outcome. `basis: 'verified_by_extalia'` (ADR 0027): Extalia ran the configured command
 * itself; the evidence is the exit code and a bounded, redacted log with its digest.
 */
export interface GateResult {
  command: string;
  exitCode: number;
  ok: boolean;
  durationMs: number;
  log: string;
  logDigest: string;
  observedAt: string;
  basis: 'verified_by_extalia';
}

/**
 * `ready`: merged cleanly and the gate passed; only this can be applied.
 * `conflict`: the merge stopped; `conflicts` lists the paths. `gate_failed` / `gate_missing`:
 * no approvable proposal. `empty`: nothing to integrate. `stale`: the target moved after the proposal.
 */
/** `request`: the caller named the gate; `workspace`: the host used the workspace's `integrationGate`. */
export type IntegrationGateSource = 'request' | 'workspace';

export type IntegrationStatus = 'ready' | 'conflict' | 'gate_failed' | 'gate_missing' | 'empty' | 'applied' | 'stale';

export interface IntegrationProposal {
  id: string;
  worktreeId: string;
  repository: string;
  workerBranch: string;
  workerHead: string;
  targetBranch: string;
  /** Target tip the proposal was computed on. */
  targetCommit: string;
  /** The integration merge commit, kept reachable by `refs/extalia/integration/<id>` until applied. */
  mergeCommit?: string;
  status: IntegrationStatus;
  conflicts?: string[];
  files: DiffFile[];
  /** Digest of the exact change `targetCommit → mergeCommit` the user approves. */
  diffDigest?: string;
  gate?: GateResult;
  /** Where the gate came from; absent without a gate and on records from older hosts. */
  gateSource?: IntegrationGateSource;
  createdAt: string;
  appliedAt?: string;
}

export interface IntegrationQueueOptions {
  registryFile: string;
  /** Environment for the gate command; credentials are removed before it runs. */
  env?: Readonly<Record<string, string | undefined>>;
}

const SCHEMA = 'extalia.integrations.v1';
const MAX_PROPOSALS = 256;
const MAX_CONFLICTS = 500;
const LOG_LIMIT = 16_000;
const proposalRef = (id: string) => `refs/extalia/integration/${id}`;

export class IntegrationQueue {
  private proposals: IntegrationProposal[] = [];
  /** One proposal or apply at a time. Separate from worktree creation, so a long gate never delays a mission start. */
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly worktrees: WorktreeManager, private readonly options: IntegrationQueueOptions) {}

  static async open(worktrees: WorktreeManager, options: IntegrationQueueOptions): Promise<IntegrationQueue> {
    const queue = new IntegrationQueue(worktrees, options);
    const stored = await readJson<{ schema?: unknown; proposals?: unknown } | undefined>(options.registryFile, undefined);
    if (stored !== undefined) {
      if (stored.schema !== SCHEMA || !Array.isArray(stored.proposals) || stored.proposals.length > MAX_PROPOSALS || !stored.proposals.every(validProposal)) throw new WorktreeError('invalid', 'The integration registry is unreadable. It was left unchanged.');
      queue.proposals = stored.proposals as IntegrationProposal[];
    }
    return queue;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  list(): IntegrationProposal[] { return structuredClone(this.proposals); }

  get(id: string): IntegrationProposal {
    const proposal = this.proposals.find(item => item.id === id);
    if (!proposal) throw new WorktreeError('not_found', 'This integration proposal does not exist.');
    return structuredClone(proposal);
  }

  private async persist(): Promise<void> {
    // Oldest finished proposals go first; ready ones are kept until applied or superseded.
    while (this.proposals.length > MAX_PROPOSALS) {
      const index = this.proposals.findIndex(item => item.status !== 'ready');
      this.proposals.splice(index === -1 ? 0 : index, 1);
    }
    await ensurePrivateDirectory(path.dirname(this.options.registryFile));
    await writeJsonAtomic(this.options.registryFile, { schema: SCHEMA, proposals: this.proposals }, { mode: 0o600 });
  }

  /**
   * Queue one proposal. Runs after every earlier proposal or apply (one at a time).
   * The worker must be released (its task ended). Without a gate the proposal is `gate_missing`
   * (there is no ungated integration). `gateSource` records where the caller took the gate from.
   */
  propose(worktreeId: string, options: { targetBranch?: string; gate?: IntegrationGate; gateSource?: IntegrationGateSource } = {}): Promise<IntegrationProposal> {
    return this.serial(async () => {
      const record = this.worktrees.get(worktreeId);
      if (record.state !== 'released' || !record.head) throw new WorktreeError('not_ready', 'This worker is still running or was not released. Wait for its task to end.');
      const targetBranch = checkBranchName(options.targetBranch ?? record.baseBranch ?? '');
      const gate = options.gate === undefined ? undefined : checkGate(options.gate);
      const git = this.worktrees.git, repository = record.repository;
      const tip = await git.run(repository, ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}^{commit}`], { accept: [0, 1] });
      const targetCommit = tip.stdout.toString('utf8').trim();
      if (tip.exitCode !== 0 || !isCommitId(targetCommit)) throw new WorktreeError('not_found', 'The target branch does not exist.');
      const workerHead = (await git.text(record.path, ['rev-parse', 'HEAD'])).trim();
      if (workerHead !== record.head) throw new WorktreeError('stale', 'The worker branch changed after its task ended. Review the worktree first.');
      const proposal: IntegrationProposal = {
        id: newWorktreeId('i'), worktreeId, repository, workerBranch: record.branch, workerHead, targetBranch, targetCommit,
        status: 'empty', files: [], createdAt: new Date().toISOString(),
      };
      const contained = await git.run(repository, ['merge-base', '--is-ancestor', workerHead, targetCommit], { accept: [0, 1] });
      if (contained.exitCode === 0) return this.record(proposal);
      const workspace = path.join(this.worktrees.directory, proposal.id);
      const filters = await git.filterOverrides(repository);
      await git.run(repository, ['worktree', 'add', '--detach', workspace, targetCommit], { config: filters, timeoutMs: 180_000 });
      try {
        if (!isWithin(await realpath(this.worktrees.directory), await realpath(workspace))) throw new WorktreeError('location', 'The integration worktree is outside the data folder.');
        const merge = await git.run(workspace, ['merge', '--no-ff', '--no-edit', '-m', `Integrate ${record.branch}`, workerHead], { config: [...filters, ...COMMIT_CONFIG], accept: [0, 1], timeoutMs: 180_000 });
        if (merge.exitCode !== 0) {
          const unmerged = (await git.run(workspace, ['diff', '--name-only', '--diff-filter=U', '-z'], { config: filters })).stdout.toString('utf8').split('\0').filter(Boolean);
          await git.run(workspace, ['merge', '--abort'], { accept: [0, 128] });
          if (!unmerged.length) throw new WorktreeError('git_failed', 'Git could not merge the worker branch.');
          proposal.status = 'conflict';
          proposal.conflicts = unmerged.slice(0, MAX_CONFLICTS);
          return this.record(proposal);
        }
        const mergeCommit = (await git.text(workspace, ['rev-parse', 'HEAD'])).trim();
        const diff = await diffSummary(git, workspace, targetCommit, mergeCommit);
        proposal.mergeCommit = mergeCommit; proposal.files = diff.files; proposal.diffDigest = diff.digest;
        await git.run(repository, ['update-ref', proposalRef(proposal.id), mergeCommit, '']);
        if (!gate) proposal.status = 'gate_missing';
        else {
          proposal.gate = await this.runGate(gate, this.worktrees.root({ path: workspace, prefix: record.prefix }));
          proposal.gateSource = options.gateSource ?? 'request';
          proposal.status = proposal.gate.ok ? 'ready' : 'gate_failed';
        }
        return this.record(proposal);
      } finally {
        // The disposable integration worktree may hold build output from the gate; the merge
        // commit survives through its ref.
        await git.run(repository, ['worktree', 'remove', '--force', workspace], { accept: [0, 128], timeoutMs: 120_000 }).catch(() => undefined);
      }
    });
  }

  private async record(proposal: IntegrationProposal): Promise<IntegrationProposal> {
    this.proposals.push(proposal);
    await this.persist();
    return structuredClone(proposal);
  }

  private async runGate(gate: Required<IntegrationGate>, root: string): Promise<GateResult> {
    const tool = createCommandTool(root, { env: this.options.env ?? process.env });
    let exitCode: number | undefined;
    const started = Date.now();
    const outcome = await tool.run({ command: gate.command, timeout_seconds: gate.timeoutSeconds }, {
      signal: new AbortController().signal, toolCallId: 'integration-gate',
      emit: body => { if (body.type === 'command.completed') exitCode = body.exitCode; },
    });
    const log = safeText(redact(outcome.output), LOG_LIMIT);
    return {
      command: gate.command, exitCode: exitCode ?? 1, ok: outcome.ok && exitCode === 0, durationMs: Date.now() - started, log,
      logDigest: `sha256:${createHash('sha256').update(log).digest('hex')}`, observedAt: new Date().toISOString(), basis: 'verified_by_extalia',
    };
  }

  /**
   * Apply a `ready` proposal after the user approved exactly `diffDigest`. The target must still be at
   * the proposal's base; otherwise the proposal becomes `stale` and nothing changes. A checked-out
   * target is fast-forwarded in its checkout (`merge --ff-only`, which refuses to overwrite local
   * changes); otherwise the branch ref is compare-and-swapped. Never forced.
   */
  apply(proposalId: string, approval: { diffDigest: string }): Promise<IntegrationProposal> {
    return this.serial(async () => {
      const proposal = this.proposals.find(item => item.id === proposalId);
      if (!proposal) throw new WorktreeError('not_found', 'This integration proposal does not exist.');
      if (proposal.status !== 'ready' || !proposal.mergeCommit || !proposal.diffDigest) throw new WorktreeError('not_ready', 'Only a proposal that merged cleanly and passed its test gate can be applied.');
      if (typeof approval?.diffDigest !== 'string' || approval.diffDigest !== proposal.diffDigest) throw new WorktreeError('confirmation_mismatch', 'The approval does not match this proposal’s changes. Review the proposal again.');
      const git = this.worktrees.git, repository = proposal.repository, ref = `refs/heads/${proposal.targetBranch}`;
      const tip = (await git.run(repository, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { accept: [0, 1] })).stdout.toString('utf8').trim();
      if (tip !== proposal.targetCommit) {
        proposal.status = 'stale';
        await git.run(repository, ['update-ref', '-d', proposalRef(proposal.id), proposal.mergeCommit], { accept: [0, 128] }).catch(() => undefined);
        await this.persist();
        return structuredClone(proposal);
      }
      const kept = (await git.run(repository, ['rev-parse', '--verify', '--quiet', proposalRef(proposal.id)], { accept: [0, 1] })).stdout.toString('utf8').trim();
      if (kept !== proposal.mergeCommit) throw new WorktreeError('stale', 'The integration commit is no longer available. Propose the integration again.');
      const digest = (await diffSummary(git, repository, proposal.targetCommit, proposal.mergeCommit)).digest;
      if (digest !== proposal.diffDigest) throw new WorktreeError('confirmation_mismatch', 'The integration changes no longer match the approved digest.');
      const checkout = await checkedOut(this.worktrees, repository, ref);
      if (checkout) {
        const filters = await git.filterOverrides(checkout);
        try { await git.run(checkout, ['merge', '--ff-only', '--no-edit', proposal.mergeCommit], { config: filters, timeoutMs: 180_000 }); } catch (error) {
          throw new WorktreeError('in_use', `Your checkout of ${proposal.targetBranch} could not be fast-forwarded (${error instanceof Error ? error.message : 'Git failed'}). Nothing was changed; commit or stash local changes and approve again.`);
        }
      } else {
        await git.run(repository, ['update-ref', '-m', `extalia: integrate ${proposal.workerBranch}`, ref, proposal.mergeCommit, proposal.targetCommit]);
      }
      const after = (await git.text(repository, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
      if (after !== proposal.mergeCommit) throw new WorktreeError('git_failed', 'The target branch did not move to the approved commit.');
      await git.run(repository, ['update-ref', '-d', proposalRef(proposal.id), proposal.mergeCommit], { accept: [0, 128] }).catch(() => undefined);
      proposal.status = 'applied'; proposal.appliedAt = new Date().toISOString();
      await this.persist();
      await this.worktrees.markIntegrated(proposal.worktreeId, proposal.mergeCommit);
      return structuredClone(proposal);
    });
  }
}

const STATUSES = new Set<IntegrationStatus>(['ready', 'conflict', 'gate_failed', 'gate_missing', 'empty', 'applied', 'stale']);
function validProposal(raw: unknown): raw is IntegrationProposal {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const value = raw as IntegrationProposal;
  return typeof value.id === 'string' && /^i-[0-9a-f]{12}$/.test(value.id) && typeof value.worktreeId === 'string' && path.isAbsolute(value.repository ?? '')
    && typeof value.targetBranch === 'string' && isCommitId(value.targetCommit) && isCommitId(value.workerHead) && (value.mergeCommit === undefined || isCommitId(value.mergeCommit))
    && STATUSES.has(value.status) && Array.isArray(value.files) && (value.gateSource === undefined || value.gateSource === 'request' || value.gateSource === 'workspace') && (value.diffDigest === undefined || /^sha256:[0-9a-f]{64}$/.test(value.diffDigest));
}

function checkGate(gate: IntegrationGate): Required<IntegrationGate> {
  if (!gate || typeof gate.command !== 'string' || !gate.command.trim() || gate.command.length > 4_000) throw new WorktreeError('invalid', 'The test gate needs a command.');
  const timeoutSeconds = gate.timeoutSeconds ?? 600;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 1_800) throw new WorktreeError('invalid', 'The test gate timeout must be 1–1800 seconds.');
  return { command: gate.command, timeoutSeconds };
}

/** The worktree (the user's checkout or another one) that has `ref` checked out, if any. */
async function checkedOut(worktrees: WorktreeManager, repository: string, ref: string): Promise<string | undefined> {
  const listing = (await worktrees.git.run(repository, ['worktree', 'list', '--porcelain', '-z'])).stdout.toString('utf8');
  let current: string | undefined;
  for (const field of listing.split('\0')) {
    if (field.startsWith('worktree ')) current = field.slice('worktree '.length);
    else if (field === `branch ${ref}` && current) return current;
  }
  return undefined;
}
