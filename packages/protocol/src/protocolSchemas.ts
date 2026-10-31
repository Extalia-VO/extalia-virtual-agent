import { daemonJsonSchemaDefs } from './daemonValidate.js';
import { workerJsonSchemaDefs } from './workerProtocol.js';
import { workerBundleJsonSchemaDefs } from './workerBundle.js';
import { controlJsonSchemaDefs } from './controlValidate.js';
import { controlIdentityJsonSchemaDefs } from './controlIdentity.js';
import { controlTaskJsonSchemaDefs } from './controlTask.js';
import { controlDelegationJsonSchemaDefs } from './controlDelegation.js';
import { JSON_SCHEMA_DIALECT, type JsonSchema } from './jsonSchema.js';
import { orchestrationJsonSchemaDefs } from './orchestrationValidate.js';
import { PRIMITIVE_SCHEMA_DEFS } from './rules.js';
import { missionJournalAdmissionJson } from './missionJournal.js';
import { transitionTablesJson } from './transitions.js';

const REFERENCE = 'Generated from @extalia/protocol by tooling/generate-schemas.mjs; do not edit. The TypeScript validators remain the reference.';
const LENGTHS = 'string lengths in UTF-16 code units (maxLength here counts code points)';
/** Contract files emitted to `packages/protocol/schemas/`: root `$defs` entry and the validator-only checks receivers must add. */
const FILES: Record<string, { root: string; title: string; validatorOnly: string }> = {
  'worker-bundle-manifest.schema.json': { root: 'WorkerBundleManifest', title: 'Health-only worker bundle manifest v1', validatorOnly: 'sorted unique case-folded paths without file/directory collisions, exact role/reference correspondence, nonempty interpreter/script and aggregate byte limit; raw byte limits, duplicate JSON members, independently trusted digest and actual filesystem observations are separate receiver checks; no launch authority' },
  'python-worker-frame.schema.json': { root: 'PythonWorkerFrame', title: 'Probe-only Python worker NDJSON frame v1', validatorOnly: 'UTF-8 byte/NDJSON limits, direction, handshake and request correlation, deadlines and stream lifetime are enforced by the receiver; health success is not scanner readiness or process settlement' },
  'control-delegation-envelope.schema.json': { root: 'ControlDelegationEnvelope', title: 'Delegation intent v1 (unresolved authority)', validatorOnly: `expiry after issue; root/source/parent correspondence and unique acyclic task lineage; ${LENGTHS}` },
  'control-task-snapshot.schema.json': { root: 'ControlTaskSnapshot', title: 'Control task snapshot v1 (claims only)', validatorOnly: LENGTHS },
  'control-identity-map.schema.json': { root: 'ControlIdentityMap', title: 'Scoped identity map v1 (no authority)', validatorOnly: `unique exact source tuples and canonical IDs; ${LENGTHS}` },
  'control-capability-manifest.schema.json': { root: 'ControlCapabilityManifest', title: 'Control capability manifest v1 (claims only)', validatorOnly: LENGTHS },
  'mission.schema.json': { root: 'Mission', title: 'Mission', validatorOnly: `updatedAt not before createdAt; ${LENGTHS}` },
  'task.schema.json': { root: 'Task', title: 'Task', validatorOnly: `no dependsOn or parentTaskId reference to the task itself; ${LENGTHS}` },
  'agent-event.schema.json': { root: 'AgentEvent', title: 'Orchestration AgentEvent (native control and inherited v0 bodies)', validatorOnly: LENGTHS },
  'approval.schema.json': { root: 'Approval', title: 'Approval', validatorOnly: `expiresAt after requestedAt; decidedAt within the request window; decidedBy differs from actorId; ${LENGTHS}` },
  'permission.schema.json': { root: 'Permission', title: 'Permission', validatorOnly: LENGTHS },
  'daemon-frame.schema.json': { root: 'DaemonFrame', title: 'Daemon wire frame v1', validatorOnly: `mission.create graph belongs to the mission; mission.snapshot unique task/lease IDs, task/holder/state lease correspondence and lease time order; TaskGraph unique task IDs, known references, acyclic dependsOn/parentTaskId and completed dependencies for started work; planning connection IDs sorted by ASCII order, inspection observation identity/digest correspondence and observation time not before admission; planning receipts grant no execution or settlement authority; routing preview status/count/score/identity/pin/rationale correspondence, report-wide exact revision metadata consistency and 512 KiB result budget; the checks of each nested contract; ${LENGTHS}` },
};

function references(schema: unknown, found: Set<string>): void {
  if (Array.isArray(schema)) { for (const item of schema) references(item, found); return; }
  if (typeof schema !== 'object' || schema === null) return;
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') found.add(value.replace('#/$defs/', ''));
    else references(value, found);
  }
}

/** Self-contained JSON Schema documents by file name, with only the `$defs` each one reaches. */
export function protocolJsonSchemas(): Record<string, JsonSchema> {
  const defs: Record<string, JsonSchema> = { ...PRIMITIVE_SCHEMA_DEFS, ...controlJsonSchemaDefs(), ...controlIdentityJsonSchemaDefs(), ...controlTaskJsonSchemaDefs(), ...controlDelegationJsonSchemaDefs(), ...orchestrationJsonSchemaDefs(), ...daemonJsonSchemaDefs(), ...workerJsonSchemaDefs(), ...workerBundleJsonSchemaDefs() };
  return Object.fromEntries(Object.entries(FILES).map(([file, { root, title, validatorOnly }]) => {
    const reached = new Set([root]), queue = [root];
    while (queue.length) {
      const found = new Set<string>();
      const def = defs[queue.shift()!];
      if (!def) throw new Error(`Unknown schema definition in ${file}.`);
      references(def, found);
      for (const name of found) if (!reached.has(name)) { reached.add(name); queue.push(name); }
    }
    const name = file.replace('.schema.json', '');
    return [file, {
      $schema: JSON_SCHEMA_DIALECT, $id: `urn:extalia:protocol:${name}:v1`, title,
      description: `${REFERENCE} Validator-only checks: ${validatorOnly}.`,
      $ref: `#/$defs/${root}`,
      $defs: Object.fromEntries([...reached].sort().map(item => [item, defs[item]!])),
    }];
  }));
}

/** Stable file text: two-space JSON, non-ASCII escaped, trailing newline. */
export function serializeJsonSchema(schema: JsonSchema): string {
  return `${JSON.stringify(schema, null, 2).replace(/[\u007f-￿]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`;
}

/** Every generated file of `packages/protocol/schemas/` by name: the JSON Schemas, the shared transition tables and the journal admission table. */
export function protocolContractFiles(): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(protocolJsonSchemas()).map(([file, schema]) => [file, serializeJsonSchema(schema)])),
    'transitions.json': serializeJsonSchema(transitionTablesJson()),
    'journal-admission.json': serializeJsonSchema(missionJournalAdmissionJson()),
  };
}
