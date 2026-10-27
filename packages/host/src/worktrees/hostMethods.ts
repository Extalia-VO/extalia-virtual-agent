import {
  normalizeDiscardConfirmation, normalizeIntegrationApproval, normalizeIntegrationRequest, normalizeProposalId, normalizeWorktreeId,
  type AgentHostApi,
} from '@extalia/platform';
import type { WorktreeHostApi } from '../service.js';
import { WorktreeError } from './git.js';

type WorktreeMethods = Required<Pick<AgentHostApi,
  'listWorktrees' | 'worktreeStatus' | 'worktreeDiff' | 'worktreeOrphans' | 'removeWorktree' | 'proposeIntegration' | 'integrationProposals' | 'applyIntegration'>>;

/**
 * The renderer's worktree methods (ADR 0028): every argument passes the platform validators
 * before the worktree manager or the integration queue sees it, and only messages meant for the
 * user leave the host. These are user actions; no agent tool registry includes them.
 */
export function worktreeHostMethods(worktrees: WorktreeHostApi, userError: (message: string) => Error): WorktreeMethods {
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      if (error instanceof WorktreeError || (error instanceof Error && error.name === 'WorktreeInputError')) throw userError(error.message);
      throw userError('The worktree action failed. Nothing was changed by this request.');
    }
  };
  return {
    listWorktrees: () => guarded(() => worktrees.list()),
    worktreeStatus: id => guarded(() => worktrees.status(normalizeWorktreeId(id))),
    worktreeDiff: id => guarded(() => worktrees.diff(normalizeWorktreeId(id))),
    worktreeOrphans: () => guarded(() => worktrees.orphans()),
    removeWorktree: (id, confirm) => guarded(async () => {
      const worktreeId = normalizeWorktreeId(id), confirmation = normalizeDiscardConfirmation(confirm);
      await worktrees.remove(worktreeId, confirmation);
    }),
    proposeIntegration: (id, request) => guarded(async () => {
      const worktreeId = normalizeWorktreeId(id), options = normalizeIntegrationRequest(request);
      return worktrees.propose(worktreeId, options);
    }),
    integrationProposals: () => guarded(() => worktrees.proposals()),
    applyIntegration: (id, approval) => guarded(async () => {
      const proposalId = normalizeProposalId(id), checked = normalizeIntegrationApproval(approval);
      return worktrees.apply(proposalId, checked);
    }),
  };
}
