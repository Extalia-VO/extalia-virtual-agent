import { createHash } from 'node:crypto';
import type { LearningSkillNotice, SkillRegistryReport, SkillRevisionSummary } from '@extalia/platform';
import type { AutomaticLearningResult } from './automaticLearning.js';
import type { SkillProposalResult } from './skillLearning.js';

export interface SkillLearningNoticeOrigin {
  profileId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  createdAt: string;
}

/** Optional metadata already obtained from this profile's registry, never model-authored history. */
export interface SkillLearningRegistryHistory {
  profileId: string;
  mode: SkillRegistryReport['mode'];
  status: SkillRegistryReport['status'];
  truncated: boolean;
  revisions: readonly Pick<SkillRevisionSummary, 'packageId' | 'revisionId' | 'createdAt'>[];
}

function savedChange(receipt: SkillProposalResult, profileId: string, history?: SkillLearningRegistryHistory): LearningSkillNotice['change'] {
  if (!history || history.profileId !== profileId || history.mode !== 'registry' || history.status !== 'ready') return 'saved';
  // A stale snapshot taken before this import cannot establish the new revision's history.
  const current = history.revisions.find(revision => revision.packageId === receipt.packageId && revision.revisionId === receipt.revisionId);
  if (!current) return 'saved';
  const others = history.revisions.filter(revision => revision.packageId === receipt.packageId && revision.revisionId !== receipt.revisionId);
  const importedAt = Date.parse(current.createdAt);
  if (Number.isFinite(importedAt) && others.some(revision => Date.parse(revision.createdAt) < importedAt)) return 'revised';
  // Missing rows never prove a first revision. Equal or later timestamps do not prove an update.
  if (!history.truncated && others.length === 0) return 'new';
  return 'saved';
}

/**
 * Project an acknowledged artifact, not the curator's prose or overall job status.
 * `created` means a new immutable revision; false is an identical existing revision,
 * never evidence of an update. A later note/export failure cannot undo this receipt.
 * This helper performs no registry, scanner or provider work and grants no activation.
 */
export function automaticLearningNotice(
  result: AutomaticLearningResult,
  origin: SkillLearningNoticeOrigin,
  history?: SkillLearningRegistryHistory,
): LearningSkillNotice | undefined {
  const receipt = result.skill.receipt;
  if (result.skill.status !== 'recorded' || !receipt || receipt.created !== true) return undefined;
  const digest = createHash('sha256').update(JSON.stringify([origin.profileId, receipt.packageId, receipt.revisionId])).digest('hex');
  return {
    id: `skill-${digest}`,
    profileId: origin.profileId,
    workspaceId: origin.workspaceId,
    sessionId: origin.sessionId,
    runId: origin.runId,
    createdAt: origin.createdAt,
    kind: 'skill-candidate',
    packageId: receipt.packageId,
    revisionId: receipt.revisionId,
    state: receipt.state,
    change: savedChange(receipt, origin.profileId, history),
    activationPerformed: false,
    ...(result.outcome === 'failed' || result.outcome === 'cancelled' ? { partial: true } : {}),
  };
}
