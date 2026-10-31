import { CONTROL_PROTOCOL_VERSION, CONTROL_SCHEMA_VERSION } from './control.js';
import type { JsonSchema } from './jsonSchema.js';
import { array, enumeration, identifier, literal, object, rule, runtimeId, uuid } from './rules.js';

export type ControlEntityKind = 'session' | 'workspace';
export interface ControlIdentitySource {
  family: 'extalia.v0' | 'orchestration.v1' | 'external';
  system: string;
  instanceId: string;
  workspaceId: string;
  id: string;
}
export interface ControlIdentityReference { entityKind: ControlEntityKind; source: ControlIdentitySource }
export interface ControlIdentityBinding extends ControlIdentityReference { canonicalId: string }
/** Explicit, one-to-one boundary mappings; no ID generation, migration or authority. */
export interface ControlIdentityMap {
  protocol: typeof CONTROL_PROTOCOL_VERSION;
  schemaVersion: typeof CONTROL_SCHEMA_VERSION;
  kind: 'identity-map';
  profileId: string;
  workspaceId: string;
  bindings: ControlIdentityBinding[];
}
type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const sources = {
  'extalia.v0': object({ family: literal('extalia.v0'), system: literal('extalia'), instanceId: identifier, workspaceId: identifier, id: identifier }),
  'orchestration.v1': object({ family: literal('orchestration.v1'), system: literal('extalia'), instanceId: identifier, workspaceId: uuid, id: uuid }),
  external: object({ family: literal('external'), system: runtimeId, instanceId: identifier, workspaceId: identifier, id: identifier }),
};
const source = rule((value, path, errors) => {
  const family = value && typeof value === 'object' ? (value as Record<string, unknown>).family : undefined;
  if (typeof family !== 'string' || !Object.hasOwn(sources, family)) { errors.push(`${path}.family: unknown source family.`); return; }
  sources[family as keyof typeof sources].check(value, path, errors);
}, { oneOf: Object.values(sources).map(item => item.schema) });
const fields = { entityKind: enumeration(['session', 'workspace']), source };
const reference = object(fields);
const binding = object({ ...fields, canonicalId: uuid });
const map = object({ protocol: literal(CONTROL_PROTOCOL_VERSION), schemaVersion: literal(CONTROL_SCHEMA_VERSION), kind: literal('identity-map'), profileId: uuid, workspaceId: uuid, bindings: array(binding, false, 0, 1_000) });

/** Tuple encoding preserves separators and source IDs exactly; no alias inference. */
export function controlIdentityKey(value: ControlIdentityReference): string {
  const { source } = value;
  return JSON.stringify([value.entityKind, source.family, source.system, source.instanceId, source.workspaceId, source.id]);
}
export function parseControlIdentityReference(value: unknown): ParseResult<ControlIdentityReference> {
  const errors: string[] = [];
  reference.check(value, '$', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: value as ControlIdentityReference };
}
export function parseControlIdentityMap(value: unknown): ParseResult<ControlIdentityMap> {
  const errors: string[] = [];
  map.check(value, '$', errors);
  if (errors.length) return { ok: false, errors };
  const result = value as ControlIdentityMap;
  const sourceKeys = new Set<string>(), canonicalIds = new Set<string>();
  for (const [index, entry] of result.bindings.entries()) {
    const key = controlIdentityKey(entry);
    if (sourceKeys.has(key) || canonicalIds.has(entry.canonicalId)) errors.push(`$.bindings[${index}]: ambiguous identity binding.`);
    sourceKeys.add(key); canonicalIds.add(entry.canonicalId);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: result };
}
export function controlIdentityJsonSchemaDefs(): Record<string, JsonSchema> {
  return { ControlIdentityMap: map.schema };
}
