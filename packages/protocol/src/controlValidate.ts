import {
  CONTROL_CAPABILITY_NAMES, CONTROL_ENGINE_IDS, CONTROL_PROTOCOL_VERSION,
  CONTROL_SCHEMA_VERSION, CONTROL_WORKER_IDS,
  type ControlIntegrationMode, type ControlManifestParseResult,
} from './control.js';
import { schemaRef, type JsonSchema } from './jsonSchema.js';
import {
  array, enumeration, identifier, isPlainObject, literal, object, rule,
  runtimeId, text, timestamp, uuid, withSchema, type Rule,
} from './rules.js';

/** Select a closed discriminated branch; unknown values are rejected, not coerced. */
function union(field: string, branches: Record<string, Rule>): Rule {
  return rule((value, path, errors) => {
    const key = isPlainObject(value) ? value[field] : undefined;
    const branch = typeof key === 'string' && Object.hasOwn(branches, key) ? branches[key] : undefined;
    if (branch) branch.check(value, path, errors);
    else errors.push(`${path}.${field}: unknown discriminant.`);
  }, { oneOf: Object.values(branches).map(branch => branch.schema) });
}
const interfaces = enumeration(['sdk', 'cli', 'acp', 'gateway', 'hook', 'otel', 'import', 'api']);
const verificationRule = object({
  runtimeVersion: text(128), policyRef: identifier, configurationRef: identifier,
  evidenceRefs: array(identifier, true, 1, 64), checkedAt: timestamp,
});
const verification = withSchema(verificationRule, schemaRef('ControlCapabilityVerification'));
const entryFields = { reason: text(2_000), interface: interfaces };
const inactiveStates = ['unsupported', 'disabled_by_policy', 'unavailable', 'needs_verification'] as const;
const inactiveBranches = Object.fromEntries(inactiveStates.map(state => [state, object({ ...entryFields, state: literal(state) })]));
const inactiveRule = union('state', inactiveBranches);
const inactive = withSchema(inactiveRule, schemaRef('ControlInactiveCapability'));
const capabilityRule = union('state', {
  ...inactiveBranches,
  supported: object({ ...entryFields, state: literal('supported'), verification }),
  experimental: object({ ...entryFields, state: literal('experimental'), verification, optInRequired: literal(true) }),
});
const capability = withSchema(capabilityRule, schemaRef('ControlCapability'));
const subjectRule = union('kind', {
  engine: object({ kind: literal('engine'), id: enumeration(CONTROL_ENGINE_IDS), adapterVersion: text(128) }),
  worker: object({ kind: literal('worker'), id: enumeration(CONTROL_WORKER_IDS), adapterVersion: text(128) }),
  provider: object({ kind: literal('provider'), id: runtimeId, adapterVersion: text(128) }),
});
const subject = withSchema(subjectRule, schemaRef('ControlSubject'));
// Observer approval relay can be real (ADR 0018); it is still a claim and never a
// grant to control an outside session. Import-only has no live command surface.
const observerNames = ['discover', 'observe', 'streamEvents', 'approvalRelay', 'readArtifacts', 'listSessions', 'usage', 'cost', 'gitDiff'];
const importNames = ['discover', 'readArtifacts', 'listSessions', 'usage', 'cost', 'gitDiff'];
const manifest = union('mode', Object.fromEntries((['managed', 'observer', 'import-only'] as const).map((mode): [ControlIntegrationMode, Rule] => {
  const permitted = (name: string) => mode === 'managed' || (mode === 'observer' ? observerNames : importNames).includes(name);
  return [mode, object({
    protocol: literal(CONTROL_PROTOCOL_VERSION), schemaVersion: literal(CONTROL_SCHEMA_VERSION),
    profileId: uuid, workspaceId: uuid, subject, mode: literal(mode),
    authMethod: enumeration(['none', 'external_official_login', 'user_api_key', 'user_oauth_authorized', 'local_model', 'gateway_scoped', 'enterprise_adc']),
    detectedAt: timestamp,
    capabilities: object(Object.fromEntries(CONTROL_CAPABILITY_NAMES.map(name => [name, permitted(name) ? capability : inactive]))),
  })];
})));

/** Shape/claim conformance only. No registry, policy, evidence or driver is consulted. */
export function parseControlCapabilityManifest(value: unknown): ControlManifestParseResult {
  const errors: string[] = [];
  manifest.check(value, '$', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: value as Extract<ControlManifestParseResult, { ok: true }>['value'] };
}
export function controlJsonSchemaDefs(): Record<string, JsonSchema> {
  return {
    ControlCapabilityManifest: manifest.schema, ControlSubject: subjectRule.schema,
    ControlCapability: capabilityRule.schema, ControlInactiveCapability: inactiveRule.schema,
    ControlCapabilityVerification: verificationRule.schema,
  };
}
