import type { SkillProposalResult } from './skillLearning.js';
import { SKILL_REVISION_STATES } from '@extalia/protocol';
import type { LearningArtifactReceipt, LearningFailure } from './rustLearning.js';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);

const PUBLICATION_REASONS: Readonly<Record<string, string>> = {
  knowledge_source_changed: 'A referenced Knowledge note changed before publication. Review the finding against its current contents.',
  knowledge_read_unavailable: 'A referenced Knowledge note could not be confirmed. Refresh Knowledge before reviewing this finding again.',
  knowledge_scope_changed: 'The Knowledge profile changed before publication. The finding was not moved to another profile.',
  refinement_base_required: 'This skill already exists. Read the current candidate and provide its revision, hash and review receipt before refining it.',
  refinement_base_changed: 'A newer or changed skill revision was found. Review the current candidate before submitting another refinement.',
  candidate_not_latest: 'The selected skill revision is no longer current. Review the latest candidate.',
  candidate_scope_mismatch: 'The skill candidate does not belong to this learning profile and workspace.',
  candidate_references_unread: 'Read every existing Markdown reference, manifest and verification fixture before submitting a replacement skill package.',
  generated_duplicate_candidate: 'An equivalent generated skill already exists. Review and refine its current package instead of creating an alias.',
  generated_possible_duplicate: 'A generated skill with overlapping purpose already exists. Review that candidate before proposing a separate class.',
  invalid_skill_quality: 'Include valid categories, task intents, populated procedure sections and verification cases before submitting the candidate.',
  skill_metadata_invalid: 'Provide bounded category slugs and task intent identifiers before submitting the generated candidate.',
  incomplete_skill_instructions: 'Populate When to Use, Procedure, Pitfalls and Verification outside code fences before submitting the candidate.',
  skill_instructions_incomplete: 'Populate When to Use, Procedure, Pitfalls and Verification outside code fences before submitting the candidate.',
  verification_cases_invalid: 'Provide bounded verification inputs and expected assertions before submitting a generated skill.',
  refinement_tests_changed: 'Retain every existing verification case and assertion when refining a skill; add new regression cases instead of weakening prior tests.',
  refinement_references_removed: 'Retain every existing reference path when refining a skill; improve the referenced content instead of removing it.',
  candidate_references_missing: 'Retain every existing reference path when refining a skill; improve the referenced content instead of removing it.',
  candidate_catalog_incomplete: 'The generated-skill catalog could not be checked completely. Refresh it before creating another class.',
  learned_evaluation_required: 'The candidate needs revision-bound tests before approval or activation. The current active version is retained.',
  learned_evaluation_stale: 'The candidate or its active baseline changed. Run the tests again before replacing the active version.',
};

/** Only stable owner reason codes are user-visible; arbitrary error messages and paths are never copied. */
export function learningPublicationReason(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && (object(current) || current instanceof Error); depth++) {
    const value = current as { reason?: unknown; cause?: unknown };
    if (typeof value.reason === 'string' && Object.hasOwn(PUBLICATION_REASONS, value.reason)) return PUBLICATION_REASONS[value.reason];
    current = value.cause;
  }
  return undefined;
}

/** Decode acknowledged host results only; a claim or curator sentence is never a receipt. */
export function readLearningArtifact(receipt: LearningArtifactReceipt, kind: 'note', workspaceId: string): { path: string };
export function readLearningArtifact(receipt: LearningArtifactReceipt, kind: 'skill', workspaceId: string): SkillProposalResult;
export function readLearningArtifact(receipt: LearningArtifactReceipt, kind: 'note' | 'skill', workspaceId: string): { path: string } | SkillProposalResult {
  if (receipt.kind !== kind || Buffer.byteLength(receipt.data, 'utf8') > 8192) throw new Error('The learning artifact confirmation is invalid.');
  const value: unknown = JSON.parse(receipt.data);
  if (!object(value)) throw new Error('The learning artifact confirmation is invalid.');
  if (kind === 'note') {
    if (!text(value.path, 4096) || !value.path.startsWith(`Learning/${workspaceId}/`) || !/^[^\\:]+\.md$/.test(value.path)
      || value.path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The learning note belongs to another destination.');
    return { path: value.path };
  }
  if (!text(value.packageId, 200) || !text(value.revisionId, 200) || !text(value.state, 100) || !(SKILL_REVISION_STATES as readonly string[]).includes(value.state)
    || typeof value.created !== 'boolean' || !['recorded', 'unavailable'].includes(String(value.inspection))
    || value.activationPerformed !== false || typeof value.cancellationObserved !== 'boolean') throw new Error('The saved skill confirmation is invalid.');
  return { packageId: value.packageId, revisionId: value.revisionId, state: value.state as SkillProposalResult['state'], created: false,
    inspection: value.inspection as SkillProposalResult['inspection'], activationPerformed: false, cancellationObserved: value.cancellationObserved,
    ...(text(value.inspectionOutcome, 500) ? { inspectionOutcome: value.inspectionOutcome } : {}),
    ...(text(value.stateReason, 1000) ? { stateReason: value.stateReason } : {}) };
}

/** Expose useful categories without copying provider responses, URLs or credentials into activity. */
export function learningFailureCode(error: unknown): LearningFailure['code'] {
  const value = object(error) || error instanceof Error ? error as { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown } : {};
  const status = value.status ?? value.statusCode;
  if (status === 429) return 'rate-limited';
  if (status === 400 || status === 422) return 'invalid-request';
  if (status === 401 || status === 403 || status === 404 || typeof status === 'number' && status >= 500) return 'unavailable';
  const message = typeof value.message === 'string' ? value.message.slice(0, 2000) : '';
  if (value.name === 'TimeoutError' || /timeout|timed out/i.test(message)) return 'timeout';
  if (value.name === 'AbortError') return 'cancelled';
  if (/\b429\b|rate.?limit/i.test(message)) return 'rate-limited';
  if (/\b(400|422)\b|invalid.{0,30}(schema|request)|schema.{0,30}(invalid|properties)/i.test(message)) return 'invalid-request';
  return 'unknown';
}
