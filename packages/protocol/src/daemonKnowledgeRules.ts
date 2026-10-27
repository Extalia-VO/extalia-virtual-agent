/**
 * Validator rules of the knowledge index operations (`daemonKnowledge.ts`). Internal to the
 * package: `daemonValidate.ts` merges them into the daemon frame rules and `$defs`.
 */
import {
  DAEMON_KNOWLEDGE_LIMITS as LIMITS, KNOWLEDGE_BODY_STATUSES, KNOWLEDGE_CONFLICT_REASONS, KNOWLEDGE_EDGE_TYPES, KNOWLEDGE_FOLDER_PATTERN,
  KNOWLEDGE_HISTORY_AUTHOR_PATTERN, KNOWLEDGE_HISTORY_KINDS, KNOWLEDGE_IMPORT_OUTCOMES, KNOWLEDGE_INDEX_STATES, KNOWLEDGE_LINK_STATUSES,
  KNOWLEDGE_NODE_ID_PATTERN, KNOWLEDGE_ORIGINS, KNOWLEDGE_PATH_PATTERN, KNOWLEDGE_RESOLUTIONS, KNOWLEDGE_SKIP_REASONS, KNOWLEDGE_SYNC_MODES,
  KNOWLEDGE_TRUST_STATUSES, KNOWLEDGE_VAULT_LABEL_PATTERN, KNOWLEDGE_WRITE_AUTHORS, KNOWLEDGE_WRITE_OUTCOMES, type DaemonKnowledgeOp,
} from './daemonKnowledge.js';
import { SKILL_WORKSPACE_ID_MAX_LENGTH, SKILL_WORKSPACE_ID_PATTERN } from './daemonSkills.js';
import { multiline, skillReason } from './daemonSkillRules.js';
import { schemaRef, type JsonSchema } from './jsonSchema.js';
import { array, boolean, count, digest, enumeration, fail, isPlainObject, number, object, optional, positive, rule, text, timestamp, withSchema, type Rule } from './rules.js';

const matching = (pattern: RegExp, message: string, maxLength: number) => rule((value, path, errors) => {
  if (typeof value !== 'string' || value.length > maxLength || !pattern.test(value)) fail(path, message, errors);
}, { type: 'string', maxLength, pattern: pattern.source });
const def = (name: string, field: Rule) => ({ name, field, ref: withSchema(field, schemaRef(name)) });

const vaultPath = def('KnowledgePath', matching(KNOWLEDGE_PATH_PATTERN, `expected a vault-relative path of at most ${LIMITS.path} characters`, LIMITS.path));
const nodeId = def('KnowledgeNodeId', matching(KNOWLEDGE_NODE_ID_PATTERN, 'expected a knowledge node id', LIMITS.nodeId));
const syncMode = def('KnowledgeSyncMode', enumeration(KNOWLEDGE_SYNC_MODES));
const edgeType = def('KnowledgeEdgeType', enumeration(KNOWLEDGE_EDGE_TYPES));
const title = text(LIMITS.title);
const nodeRef = def('KnowledgeNodeRef', object({ nodeId: nodeId.ref, path: vaultPath.ref, title }));
const counts = def('KnowledgeCounts', object({ notes: count, edges: count, unresolvedLinks: count, skipped: count }));
const summary = def('KnowledgeSyncSummary', object({
  mode: syncMode.ref, at: timestamp, generation: count, notes: count, added: count, updated: count, removed: count, unchanged: count,
  renamed: count, skipped: count, unresolvedLinks: count,
}));
const node = def('KnowledgeNode', object({
  nodeId: nodeId.ref, idFromFrontMatter: boolean, path: vaultPath.ref, kind: text(LIMITS.kind), title,
  aliases: array(text(LIMITS.alias), false, 0, LIMITS.listItems), tags: array(text(LIMITS.tag), false, 0, LIMITS.listItems),
  origin: enumeration(KNOWLEDGE_ORIGINS), trustStatus: enumeration(KNOWLEDGE_TRUST_STATUSES), sourceSha256: digest,
  sourceModifiedAt: optional(timestamp), observedAt: timestamp, declaredVerification: optional(text(LIMITS.verification)),
  declaredRevision: optional(count), declaredSourceTaskIds: array(text(LIMITS.taskId), false, 0, LIMITS.listItems),
}));

const linkFields = object({
  sourceNodeId: nodeId.ref, ordinal: count, edgeType: edgeType.ref, embed: boolean, line: positive, target: text(LIMITS.linkText),
  heading: optional(text(LIMITS.linkText)), display: optional(text(LIMITS.linkText)), status: enumeration(KNOWLEDGE_LINK_STATUSES),
  via: optional(enumeration(KNOWLEDGE_RESOLUTIONS)), targetNodeId: optional(nodeId.ref),
  candidates: optional(array(nodeId.ref, true, 1, LIMITS.candidates)),
});
const RESOLUTION_FIELDS = { resolved: ['via', 'targetNodeId'], ambiguous: ['candidates'], missing: [] } as const;
const absent = (keys: readonly string[]): JsonSchema[] => keys.map(key => ({ not: { required: [key] } }));
/** `resolved` ⇔ `via` and `targetNodeId`; `ambiguous` ⇔ `candidates`; `missing` has none of them. */
const link = def('KnowledgeLink', rule((value, path, errors) => {
  const before = errors.length;
  linkFields.check(value, path, errors);
  if (errors.length !== before || !isPlainObject(value)) return;
  const wanted: readonly string[] = RESOLUTION_FIELDS[value.status as keyof typeof RESOLUTION_FIELDS];
  for (const key of ['via', 'targetNodeId', 'candidates']) {
    if (wanted.includes(key) !== Object.hasOwn(value, key)) fail(`${path}.${key}`, `${wanted.includes(key) ? 'required' : 'not allowed'} for a ${String(value.status)} link`, errors);
  }
}, {
  ...linkFields.schema,
  allOf: Object.entries(RESOLUTION_FIELDS).map(([status, keys]) => ({
    if: { required: ['status'], properties: { status: { const: status } } },
    then: { ...(keys.length ? { required: [...keys] } : {}), allOf: absent(['via', 'targetNodeId', 'candidates'].filter(key => !(keys as readonly string[]).includes(key))) },
  })),
}));
const linkPage = def('KnowledgeLinkPage', object({
  generation: count, nodeId: nodeId.ref, links: array(link.ref, false, 0, LIMITS.pageLimit),
  nodes: array(nodeRef.ref, false, 0, LIMITS.pageLimit), nextCursor: optional(positive),
}));
const overviewNode = def('KnowledgeOverviewNode', object({
  nodeId: nodeId.ref, title, path: vaultPath.ref, kind: optional(text(LIMITS.kind)),
  folder: matching(KNOWLEDGE_FOLDER_PATTERN, `expected a vault-relative folder of at most ${LIMITS.path} characters or the empty root`, LIMITS.path),
  tags: array(text(LIMITS.overviewTag), false, 0, LIMITS.overviewTags), degree: count, inDegree: count, outDegree: count, modifiedAt: timestamp,
}));
const overviewEdge = def('KnowledgeOverviewEdge', object({ source: nodeId.ref, target: nodeId.ref, type: edgeType.ref }));
const page = object({ nodeId: nodeId.ref, cursor: optional(count), limit: optional(number(1, true, LIMITS.pageLimit)) });

/**
 * UTF-8 byte length of well-formed UTF-16 text, or `undefined` for a lone surrogate (not
 * representable in UTF-8; the daemon's JSON parser rejects it).
 */
export function utf8Length(value: string): number | undefined {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return undefined;
      bytes += 4;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined;
    else bytes += 3;
  }
  return bytes;
}
/**
 * Note text exactly as stored (any character, front matter included): well-formed, at most
 * `maxBytes` UTF-8 bytes. The schema can only bound UTF-16 units (never fewer than the bytes).
 */
const noteText = (maxBytes: number) => rule((value, path, errors) => {
  const bytes = typeof value === 'string' ? utf8Length(value) : undefined;
  if (bytes === undefined || bytes > maxBytes) fail(path, `expected well-formed text of at most ${maxBytes} UTF-8 bytes`, errors);
}, { type: 'string', maxLength: maxBytes });
/** A hash, or `null` for "the note must not exist". */
const expected = rule((value, path, errors) => {
  if (value !== null) digest.check(value, path, errors);
}, { oneOf: [digest.schema, { type: 'null' }] });
const workspaceId = matching(SKILL_WORKSPACE_ID_PATTERN, 'expected a workspace id (w_… or a lowercase UUID)', SKILL_WORKSPACE_ID_MAX_LENGTH);
const author = matching(KNOWLEDGE_HISTORY_AUTHOR_PATTERN, 'expected a journal author', LIMITS.author);

/** Fields allowed per value of `key`: required ones, and the optional ones; the rest of `managed` must be absent. */
function consistent(fields: Rule, key: string, managed: readonly string[], cases: Record<string, { required: readonly string[]; optional?: readonly string[] }>): Rule {
  return rule((value, path, errors) => {
    const before = errors.length;
    fields.check(value, path, errors);
    if (errors.length !== before || !isPlainObject(value)) return;
    const wanted = cases[value[key] as string];
    if (!wanted) return;
    for (const field of managed) {
      const present = Object.hasOwn(value, field);
      if (wanted.required.includes(field) && !present) fail(`${path}.${field}`, `required for ${key} ${String(value[key])}`, errors);
      if (!wanted.required.includes(field) && !(wanted.optional ?? []).includes(field) && present) fail(`${path}.${field}`, `not allowed for ${key} ${String(value[key])}`, errors);
    }
  }, {
    ...fields.schema,
    allOf: Object.entries(cases).map(([name, { required, optional: allowed = [] }]) => ({
      if: { required: [key], properties: { [key]: { const: name } } },
      then: {
        ...(required.length ? { required: [...required] } : {}),
        allOf: absent(managed.filter(field => !required.includes(field) && !allowed.includes(field))),
      },
    })),
  });
}

const writeResult = def('KnowledgeWriteResult', consistent(object({
  outcome: enumeration(KNOWLEDGE_WRITE_OUTCOMES), path: vaultPath.ref, sha256: optional(digest), previousSha256: optional(digest),
  conflictPath: optional(vaultPath.ref), conflictReason: optional(enumeration(KNOWLEDGE_CONFLICT_REASONS)),
}), 'outcome', ['sha256', 'previousSha256', 'conflictPath', 'conflictReason'], {
  written: { required: ['sha256'], optional: ['previousSha256'] },
  unchanged: { required: ['sha256'] },
  conflict: { required: ['conflictPath', 'conflictReason'], optional: ['sha256'] },
}));
const historyEntry = def('KnowledgeHistoryEntry', consistent(object({
  sha256: digest, at: timestamp, kind: enumeration(KNOWLEDGE_HISTORY_KINDS), author, previousSha256: optional(digest), conflictPath: optional(vaultPath.ref),
}), 'kind', ['previousSha256', 'conflictPath'], {
  write: { required: [], optional: ['previousSha256'] },
  rollback: { required: [], optional: ['previousSha256'] },
  conflict: { required: ['conflictPath'], optional: ['previousSha256'] },
  external: { required: [] },
}));
const importedNote = def('KnowledgeImportedNote', consistent(object({
  name: text(LIMITS.importName), vaultPath: optional(vaultPath.ref), outcome: enumeration(KNOWLEDGE_IMPORT_OUTCOMES), masked: count,
  reason: optional(enumeration(KNOWLEDGE_SKIP_REASONS)),
}), 'outcome', ['vaultPath', 'reason'], Object.fromEntries(KNOWLEDGE_IMPORT_OUTCOMES.map(outcome => [
  outcome, outcome === 'skipped' ? { required: ['reason'], optional: ['vaultPath'] } : { required: ['vaultPath'] },
]))));
const importCounts = def('KnowledgeImportCounts', object({
  total: count, created: count, updated: count, unchanged: count, conflict: count, pendingConflict: count, missingInVault: count, skipped: count, masked: count,
}));

const nodeParamsFields = object({ nodeId: optional(nodeId.ref), path: optional(vaultPath.ref) });
const nodeParams = rule((value, path, errors) => {
  const before = errors.length;
  nodeParamsFields.check(value, path, errors);
  if (errors.length === before && isPlainObject(value) && Object.hasOwn(value, 'nodeId') === Object.hasOwn(value, 'path')) {
    fail(path, 'expected exactly one of nodeId and path', errors);
  }
}, { ...nodeParamsFields.schema, oneOf: [{ required: ['nodeId'] }, { required: ['path'] }] });

export const KNOWLEDGE_PARAMS: Record<DaemonKnowledgeOp, Rule> = {
  'knowledge.status': object({}),
  'knowledge.sync': object({ mode: syncMode.ref }),
  'knowledge.node': nodeParams,
  'knowledge.links': page,
  'knowledge.backlinks': page,
  'knowledge.search': object({ query: text(LIMITS.query), limit: optional(number(1, true, LIMITS.searchLimit)) }),
  'knowledge.graph': object({ nodeId: nodeId.ref, depth: optional(number(1, true, LIMITS.graphDepth)), limit: optional(number(1, true, LIMITS.graphNodes)) }),
  'knowledge.overview': object({ nodeLimit: optional(number(1, true, LIMITS.overviewNodes)), edgeLimit: optional(number(1, true, LIMITS.overviewEdges)) }),
  'knowledge.read': object({ path: vaultPath.ref }),
  'knowledge.write': object({
    path: vaultPath.ref, content: noteText(LIMITS.contentBytes), expectedSha256: optional(expected), author: enumeration(KNOWLEDGE_WRITE_AUTHORS),
  }),
  'knowledge.history': object({ path: vaultPath.ref, limit: optional(number(1, true, LIMITS.historyLimit)) }),
  'knowledge.rollback': object({ path: vaultPath.ref, toSha256: digest, expectedSha256: expected }),
  'knowledge.importMemory': object({ workspaceId, dryRun: optional(boolean) }),
};
export const KNOWLEDGE_RESULTS: Record<DaemonKnowledgeOp, Rule> = {
  'knowledge.status': object({
    state: enumeration(KNOWLEDGE_INDEX_STATES), reason: optional(skillReason.ref), vaultRoot: matching(KNOWLEDGE_VAULT_LABEL_PATTERN, 'expected a vault label (vaults/<profile> or custom:<folder name>)', 7 + LIMITS.customLabel), vaultPresent: boolean,
    schemaVersion: optional(positive), generation: count, counts: optional(counts.ref), lastSync: optional(summary.ref),
  }),
  'knowledge.sync': object({
    mode: syncMode.ref, at: timestamp, generation: count, notes: count, added: count, updated: count, removed: count, unchanged: count,
    unresolvedLinks: count, renamed: array(object({ from: vaultPath.ref, to: vaultPath.ref }), false, 0, LIMITS.reportItems), renamedTotal: count,
    skipped: array(object({ path: vaultPath.ref, reason: enumeration(KNOWLEDGE_SKIP_REASONS) }), false, 0, LIMITS.reportItems), skippedTotal: count,
    vaultCreated: boolean,
  }),
  'knowledge.node': object({
    generation: count, node: node.ref, body: optional(multiline(LIMITS.bodyBytes, false)), bodyStatus: enumeration(KNOWLEDGE_BODY_STATUSES),
    bodyTruncated: boolean,
  }),
  'knowledge.links': linkPage.ref,
  'knowledge.backlinks': linkPage.ref,
  'knowledge.search': object({
    generation: count,
    hits: array(object({ nodeId: nodeId.ref, path: vaultPath.ref, title, snippet: optional(text(LIMITS.snippet)) }), false, 0, LIMITS.searchLimit),
  }),
  'knowledge.graph': object({
    generation: count, rootNodeId: nodeId.ref, depth: number(1, true, LIMITS.graphDepth),
    nodes: array(object({ nodeId: nodeId.ref, title }), false, 1, LIMITS.graphNodes),
    edges: array(object({ source: nodeId.ref, target: nodeId.ref, edgeType: edgeType.ref }), false, 0, LIMITS.graphEdges), truncated: boolean,
  }),
  'knowledge.overview': object({
    generation: count, totalNodes: count, totalEdges: count, truncated: boolean,
    nodes: array(overviewNode.ref, false, 0, LIMITS.overviewNodes), edges: array(overviewEdge.ref, false, 0, LIMITS.overviewEdges),
  }),
  'knowledge.read': object({ path: vaultPath.ref, sha256: digest, managed: boolean, body: noteText(LIMITS.readBytes), truncated: boolean }),
  'knowledge.write': writeResult.ref,
  'knowledge.history': object({ path: vaultPath.ref, entries: array(historyEntry.ref, false, 0, LIMITS.historyLimit) }),
  'knowledge.rollback': writeResult.ref,
  'knowledge.importMemory': object({ notes: array(importedNote.ref, false, 0, LIMITS.importNotes), counts: importCounts.ref, truncated: optional(boolean) }),
};

/** Named `$defs` of the knowledge rules. */
export function knowledgeJsonSchemaDefs(): Record<string, JsonSchema> {
  const named = [
    vaultPath, nodeId, syncMode, edgeType, nodeRef, counts, summary, node, link, linkPage, overviewNode, overviewEdge, writeResult, historyEntry,
    importedNote, importCounts,
  ];
  return Object.fromEntries(named.map(({ name, field }) => [name, field.schema]));
}
