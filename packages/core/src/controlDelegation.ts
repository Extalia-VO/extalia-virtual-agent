import { CONTROL_DELEGATION_BUDGET_FIELDS, isUtcTimestamp, parseControlDelegationEnvelope } from '@extalia/protocol';

type Inspection = { ok: true; authorityVerified: false; dispatchEligible: false } | { ok: false; reason: string };
const consistent = (): Inspection => ({ ok: true, authorityVerified: false, dispatchEligible: false });
const refused = (reason: string): Inspection => ({ ok: false, reason });

/** Pure necessary checks only. No grant lookup, shared reservation, revocation or driver call. */
export function inspectControlDelegationExtension(parentValue: unknown, childValue: unknown, now: unknown): Inspection {
  const parent = parseControlDelegationEnvelope(parentValue), child = parseControlDelegationEnvelope(childValue);
  if (!parent.ok) return refused('invalid-parent');
  if (!child.ok) return refused('invalid-child');
  if (typeof now !== 'string' || !isUtcTimestamp(now)) return refused('invalid-time');
  const p = parent.value, c = child.value, time = Date.parse(now);
  if ([p, c].some(value => time < Date.parse(value.issuedAt) || time >= Date.parse(value.expiresAt))) return refused('inactive-window');
  for (const key of ['profileId', 'workspaceId', 'rootMissionId', 'rootRunId', 'rootEngineId', 'engineGeneration'] as const) if (p[key] !== c[key]) return refused('foreign-scope');
  if (c.sourceEngineId !== p.targetEngineId || c.parentTaskId !== p.taskId) return refused('broken-parent');
  if (c.delegationId === p.delegationId || c.executionId === p.executionId || c.authorityRef === p.authorityRef || c.idempotencyKey === p.idempotencyKey) return refused('reused-identity');
  const lineage = [...p.lineage, { engineId: p.targetEngineId, taskId: p.taskId }];
  if (lineage.length !== c.lineage.length || lineage.some((entry, index) => entry.engineId !== c.lineage[index]!.engineId || entry.taskId !== c.lineage[index]!.taskId)) return refused('broken-lineage');
  if (p.hopRemaining === 0 || p.childRemaining === 0 || c.hopRemaining > p.hopRemaining - 1 || c.childRemaining > p.childRemaining - 1) return refused('exhausted-or-expanded-limits');
  if (Date.parse(c.issuedAt) < Date.parse(p.issuedAt) || Date.parse(c.expiresAt) > Date.parse(p.expiresAt)) return refused('expanded-window');
  for (const key of CONTROL_DELEGATION_BUDGET_FIELDS) if (c.budget[key] > p.budget[key]) return refused('expanded-budget');
  return consistent();
}

/** Canonical comparison of validated JSON intent; includes nonenumerable declared fields. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.getOwnPropertyNames(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
/** Same intent is not replay permission. A durable scoped receipt/ledger remains mandatory. */
export function compareControlDelegationReplay(previousValue: unknown, candidateValue: unknown): Inspection {
  const previous = parseControlDelegationEnvelope(previousValue), candidate = parseControlDelegationEnvelope(candidateValue);
  if (!previous.ok) return refused('invalid-previous');
  if (!candidate.ok) return refused('invalid-candidate');
  const p = previous.value, c = candidate.value;
  for (const key of ['profileId', 'workspaceId', 'rootMissionId', 'rootRunId'] as const) if (p[key] !== c[key]) return refused('foreign-scope');
  if (p.idempotencyKey !== c.idempotencyKey) return refused('different-key');
  return JSON.stringify(canonical(p)) === JSON.stringify(canonical(c)) ? consistent() : refused('conflicting-intent');
}
