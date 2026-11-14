import type { SkillProposalResult } from './skillLearning.js';
import { SKILL_REVISION_STATES } from '@extalia/protocol';
import type { LearningArtifactReceipt, LearningFailure } from './rustLearning.js';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/\p{Cc}/u.test(value);

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
