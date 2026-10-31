/** Delegation intent claims. Conformance never resolves authority or admits a child. */
import { CONTROL_ENGINE_IDS, CONTROL_PROTOCOL_VERSION, CONTROL_SCHEMA_VERSION, type ControlEngineId } from './control.js';
import type { JsonSchema } from './jsonSchema.js';
import { array, count, digest, enumeration, identifier, literal, number, object, optional, positive, timestamp, uuid } from './rules.js';

export const CONTROL_DELEGATION_BUDGET_FIELDS = ['maxWallClockMs', 'maxTokens', 'maxToolCalls', 'maxEstimatedCostMicrousd'] as const;
/** Integer caps; a micro-USD is one millionth USD, and cost remains an estimate. */
export type ControlDelegationBudget = Record<typeof CONTROL_DELEGATION_BUDGET_FIELDS[number], number>;
export interface ControlDelegationAncestor { engineId: ControlEngineId; taskId: string }
export interface ControlDelegationEnvelope {
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  schemaVersion: typeof CONTROL_SCHEMA_VERSION;
  kind: 'delegation';
  delegationId: string;
  profileId: string;
  workspaceId: string;
  rootMissionId: string;
  rootRunId: string;
  rootEngineId: ControlEngineId;
  sourceEngineId: ControlEngineId;
  targetEngineId: ControlEngineId;
  parentTaskId: string;
  taskId: string;
  /** The delegating source execution, not proof of target execution or settlement. */
  executionId: string;
  /** Workspace generation, independently resolved at the eventual effect boundary. */
  engineGeneration: number;
  taskDefinitionVersion: number;
  taskDefinitionDigest: string;
  authorityRef: string;
  approvalRef?: string;
  /** Ordered ancestry, ending at the delegating source task; task identity cannot repeat. */
  lineage: ControlDelegationAncestor[];
  /** Remaining descendant allowance after this edge. Zero denotes a leaf. */
  hopRemaining: number;
  childRemaining: number;
  budget: ControlDelegationBudget;
  idempotencyKey: string;
  issuedAt: string;
  expiresAt: string;
}
const envelope = object({ protocol: literal(CONTROL_PROTOCOL_VERSION), schemaVersion: literal(CONTROL_SCHEMA_VERSION), kind: literal('delegation'),
  delegationId: uuid, profileId: uuid, workspaceId: uuid, rootMissionId: uuid, rootRunId: uuid,
  rootEngineId: enumeration(CONTROL_ENGINE_IDS), sourceEngineId: enumeration(CONTROL_ENGINE_IDS), targetEngineId: enumeration(CONTROL_ENGINE_IDS),
  parentTaskId: uuid, taskId: uuid, executionId: uuid, engineGeneration: positive, taskDefinitionVersion: positive, taskDefinitionDigest: digest,
  authorityRef: identifier, approvalRef: optional(identifier), lineage: array(object({ engineId: enumeration(CONTROL_ENGINE_IDS), taskId: uuid }), false, 1, 32),
  hopRemaining: number(0, true, 32), childRemaining: number(0, true, 1_000), budget: object(Object.fromEntries(CONTROL_DELEGATION_BUDGET_FIELDS.map(key => [key, count]))),
  idempotencyKey: identifier, issuedAt: timestamp, expiresAt: timestamp });
export function parseControlDelegationEnvelope(value: unknown): { ok: true; value: ControlDelegationEnvelope } | { ok: false; errors: string[] } {
  const errors: string[] = []; envelope.check(value, '$', errors);
  if (errors.length) return { ok: false, errors };
  const result = value as ControlDelegationEnvelope;
  if (Date.parse(result.expiresAt) <= Date.parse(result.issuedAt)) errors.push('$.expiresAt: must be after issuedAt.');
  if (result.lineage[0]!.engineId !== result.rootEngineId) errors.push('$.lineage: first engine must match rootEngineId.');
  const last = result.lineage.at(-1)!;
  if (last.engineId !== result.sourceEngineId || last.taskId !== result.parentTaskId) errors.push('$.lineage: last entry must identify the delegating source task.');
  const taskIds = result.lineage.map(entry => entry.taskId);
  if (new Set(taskIds).size !== taskIds.length || taskIds.includes(result.taskId)) errors.push('$.lineage: repeated task identity or target cycle.');
  return errors.length ? { ok: false, errors } : { ok: true, value: result };
}
export function controlDelegationJsonSchemaDefs(): Record<string, JsonSchema> { return { ControlDelegationEnvelope: envelope.schema }; }
