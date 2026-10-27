import {
  normalizeDiscardConfirmation, normalizeIntegrationApproval, normalizeIntegrationRequest, normalizeProposalId, normalizeWorktreeId,
  type HostMissionRun, type IntegrationGateInput, type IntegrationProposalView, type WorktreeDiffFile, type WorktreeDiffView, type WorktreeOrphanView, type WorktreeStatusView, type WorktreeView,
} from '@extalia/platform';

/**
 * Development-only worktrees for the mock host (ADR 0028): write tasks of mock missions get a
 * released worktree with a small demo diff, and the seeded demo shows every integration outcome
 * (ready, conflict with paths, failed gate with a log excerpt, stale, applied) plus orphans.
 * Nothing touches a disk or Git; digests and commits are deterministic fake hashes.
 */

/** Deterministic lowercase hex of `length` characters (FNV-1a rounds); demo data only. */
export function fakeHex(seed: string, length: number): string {
  let out = '', round = 0;
  while (out.length < length) {
    let hash = 0x811c9dc5 ^ round++;
    for (const character of `${seed}:${round}`) hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
    out += hash.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}
const commit = (seed: string) => fakeHex(seed, 40);
const digest = (seed: string) => `sha256:${fakeHex(seed, 64)}`;

interface RegisterOption { at?: string; outcome?: 'ready' | 'conflict' | 'gate_failed'; conflicts?: string[]; targetMoves?: boolean; dirty?: number }

interface Entry {
  record: WorktreeView;
  /** The mission's workspace: its integration gate runs when a request names none. */
  workspaceId: string;
  files: WorktreeDiffFile[];
  dirty: number;
  /** Demo outcome of the next proposal. */
  outcome: 'ready' | 'conflict' | 'gate_failed';
  conflicts?: string[];
  /** The target moves before the next apply (demo of `stale`). */
  targetMoves?: boolean;
}

const FILE_SETS: WorktreeDiffFile[][] = [
  [{ path: 'src/login/validate.ts', added: 24, deleted: 6 }, { path: 'src/login/validate.test.ts', added: 41, deleted: 0 }],
  [{ path: 'test/login.flaky.test.ts', added: 12, deleted: 18 }, { path: 'test/helpers/clock.ts', added: 9, deleted: 2 }],
  [{ path: 'src/login/LoginForm.tsx', added: 33, deleted: 27 }, { path: 'src/login/form.css', added: 4, deleted: 4 }, { path: 'public/login-hero.png', binary: true }],
  [{ path: 'docs/login.md', added: 15, deleted: 3 }],
];
const GATE_LOG = [
  '> demo-app@1.4.0 test', '> vitest run', '',
  ' ✓ src/login/validate.test.ts (12 tests) 41ms',
  ' ✗ test/login.flaky.test.ts > signs in after a slow clock tick',
  '   AssertionError: expected "pending" to be "signed-in"',
  '    at test/login.flaky.test.ts:38:24', '',
  ' Test Files  1 failed | 7 passed (8)', '      Tests  1 failed | 63 passed (64)',
].join('\n');

export function createMockWorktrees(dataDirectory: string, projectFor: (workspaceId: string) => string | undefined,
  gateFor: (workspaceId: string) => IntegrationGateInput | undefined = () => undefined) {
  const entries = new Map<string, Entry>();
  const proposals: IntegrationProposalView[] = [];
  const orphans: WorktreeOrphanView[] = [];
  /** Seeded missions: demo outcomes per write task and what to do once their worktrees exist. */
  const planned = new Map<string, { options: RegisterOption[]; then?(records: WorktreeView[]): void }>();
  let created = 0;

  const entry = (id: unknown) => {
    const found = entries.get(normalizeWorktreeId(id));
    if (!found) throw new Error('This worktree does not exist.');
    return found;
  };
  const status = (item: Entry): WorktreeStatusView => {
    const head = item.record.head ?? item.record.baseCommit;
    const merged = Boolean(item.record.integratedAs) || item.files.length === 0;
    return {
      id: item.record.id, head, baseCommit: item.record.baseCommit, dirty: item.dirty > 0, changedPaths: item.dirty, ahead: item.files.length ? 1 : 0, behind: item.targetMoves ? 1 : 0,
      ...(item.record.baseBranch ? { targetBranch: item.record.baseBranch } : {}), merged, fingerprint: digest(`fingerprint:${item.record.id}:${head}:${item.dirty}`),
    };
  };

  /** A released worktree per write task of a finished mock mission. */
  function register(run: HostMissionRun, given?: RegisterOption[]) {
    const plan = planned.get(run.id);
    planned.delete(run.id);
    const options = given ?? plan?.options ?? [];
    const repository = projectFor(run.workspaceId) ?? '/demo/project';
    const records: WorktreeView[] = [];
    run.tasks.filter(task => task.access === 'write').forEach((task, index) => {
      const id = `w-${fakeHex(`${run.id}:${task.taskId}`, 12)}`;
      if (entries.has(id)) return;
      const option = options[index] ?? {};
      const at = option.at ?? run.updatedAt;
      const baseCommit = commit(`base:${run.id}`);
      const record: WorktreeView = {
        id, repository, prefix: '', path: `${dataDirectory}/worktrees/${id}`, branch: `extalia/worker/${id}`, baseCommit, baseBranch: 'main',
        owner: { missionId: run.id, taskId: task.taskId, agentId: task.agentId }, state: 'released', head: commit(`head:${id}`), createdAt: run.createdAt, updatedAt: at,
      };
      entries.set(id, { record, workspaceId: run.workspaceId, files: FILE_SETS[(created++) % FILE_SETS.length]!, dirty: option.dirty ?? 0, outcome: option.outcome ?? 'ready', ...(option.conflicts ? { conflicts: option.conflicts } : {}), ...(option.targetMoves ? { targetMoves: true } : {}) });
      records.push(record);
    });
    plan?.then?.(records);
    return records;
  }

  function propose(id: unknown, raw: unknown, at = new Date().toISOString()): IntegrationProposalView {
    const item = entry(id), request = normalizeIntegrationRequest(raw);
    if (item.record.state !== 'released' || !item.record.head) throw new Error('This worker is still running or was not released. Wait for its task to end.');
    const targetBranch = request.targetBranch ?? item.record.baseBranch;
    if (!targetBranch) throw new Error('The target branch does not exist.');
    const proposalId = `i-${fakeHex(`${item.record.id}:${proposals.length}:${at}`, 12)}`;
    const base: IntegrationProposalView = {
      id: proposalId, worktreeId: item.record.id, repository: item.record.repository, workerBranch: item.record.branch, workerHead: item.record.head,
      targetBranch, targetCommit: commit(`target:${targetBranch}:${proposals.length}`), status: 'empty', files: [], createdAt: at,
    };
    let proposal: IntegrationProposalView;
    if (!item.files.length || item.record.integratedAs) proposal = base;
    else if (item.outcome === 'conflict') proposal = { ...base, status: 'conflict', conflicts: item.conflicts ?? [item.files[0]!.path] };
    else {
      const merged = { ...base, mergeCommit: commit(`merge:${proposalId}`), files: structuredClone(item.files), diffDigest: digest(`diff:${proposalId}`) };
      // Like the host: the request's gate, else the workspace setting, else `gate_missing` (never ungated).
      const workspaceGate = request.gate ? undefined : gateFor(item.workspaceId);
      const gate = request.gate ?? workspaceGate;
      if (!gate) proposal = { ...merged, status: 'gate_missing' };
      else {
        const failed = item.outcome === 'gate_failed';
        proposal = { ...merged, status: failed ? 'gate_failed' : 'ready', gateSource: workspaceGate ? 'workspace' : 'request', gate: {
          command: gate.command, exitCode: failed ? 1 : 0, ok: !failed, durationMs: failed ? 8_420 : 6_310,
          log: failed ? GATE_LOG : GATE_LOG.split('\n').slice(0, 4).join('\n'), logDigest: digest(`log:${proposalId}`), observedAt: at, basis: 'verified_by_extalia',
        } };
      }
    }
    proposals.push(proposal);
    return structuredClone(proposal);
  }

  return {
    register, propose,
    /** Demo outcomes for a mission that is about to finish (applied when `register` runs). */
    plan(missionId: string, options: RegisterOption[], then?: (records: WorktreeView[]) => void) { planned.set(missionId, { options, ...(then ? { then } : {}) }); },
    /** Seeded orphans: one worktree whose task ended without release, one unknown folder. */
    addOrphans(run: HostMissionRun) {
      const task = run.tasks.find(item => item.access === 'write');
      if (task) orphans.push({ reason: 'owner-ended', id: `w-${fakeHex(`orphan:${run.id}`, 12)}`, path: `${dataDirectory}/worktrees/w-${fakeHex(`orphan:${run.id}`, 12)}`, branch: `extalia/worker/w-${fakeHex(`orphan:${run.id}`, 12)}`, owner: { missionId: run.id, taskId: task.taskId }, dirty: true, unmerged: true });
      orphans.push({ reason: 'unregistered', path: `${dataDirectory}/worktrees/w-${fakeHex('stray', 12)}` });
    },
    /** Seeded history: a ready proposal that was applied, or whose target moved before applying (stale). */
    settle(proposalId: string, outcome: 'applied' | 'stale', at: string) {
      const proposal = proposals.find(item => item.id === proposalId);
      const item = proposal && entries.get(proposal.worktreeId);
      if (!proposal || !item || proposal.status !== 'ready') return;
      proposal.status = outcome;
      if (outcome === 'applied') { proposal.appliedAt = at; item.record.integratedAs = proposal.mergeCommit!; }
    },
    list: (): WorktreeView[] => structuredClone([...entries.values()].map(item => item.record)),
    status: (id: unknown): WorktreeStatusView => status(entry(id)),
    diff: (id: unknown): WorktreeDiffView => {
      const item = entry(id), to = item.record.head ?? item.record.baseCommit;
      return { from: item.record.baseCommit, to, files: structuredClone(item.files), truncated: false, digest: digest(`worktree:${item.record.id}:${to}`) };
    },
    orphans: (): WorktreeOrphanView[] => structuredClone(orphans),
    remove(id: unknown, confirm?: unknown) {
      const worktreeId = normalizeWorktreeId(id), confirmation = normalizeDiscardConfirmation(confirm);
      const orphan = orphans.findIndex(item => item.id === worktreeId);
      const item = entries.get(worktreeId);
      if (!item && orphan === -1) throw new Error('This worktree does not exist.');
      if (item) {
        const current = status(item);
        const unmerged = current.dirty || !current.merged;
        if (unmerged && !confirmation) throw new Error('This worktree has changes that were not integrated. Review them, then discard them explicitly to remove it.');
        if (unmerged && confirmation?.fingerprint !== current.fingerprint) throw new Error('The worktree changed since you reviewed it. Review it again before discarding.');
        entries.delete(worktreeId);
      }
      if (orphan !== -1) orphans.splice(orphan, 1);
    },
    proposals: (): IntegrationProposalView[] => structuredClone(proposals),
    apply(id: unknown, raw: unknown): IntegrationProposalView {
      const proposalId = normalizeProposalId(id), approval = normalizeIntegrationApproval(raw);
      const proposal = proposals.find(item => item.id === proposalId);
      if (!proposal) throw new Error('This integration proposal does not exist.');
      if (proposal.status !== 'ready' || !proposal.diffDigest) throw new Error('Only a proposal that merged cleanly and passed its test gate can be applied.');
      if (approval.diffDigest !== proposal.diffDigest) throw new Error('The approval does not match this proposal’s changes. Review the proposal again.');
      const item = entries.get(proposal.worktreeId);
      if (item?.targetMoves) { proposal.status = 'stale'; delete item.targetMoves; return structuredClone(proposal); }
      proposal.status = 'applied'; proposal.appliedAt = new Date().toISOString();
      if (item) item.record.integratedAs = proposal.mergeCommit!;
      return structuredClone(proposal);
    },
  };
}
