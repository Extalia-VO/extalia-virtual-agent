import { array, boolean, count, enumeration, literal, number, object, optional, rule, fail, type Rule } from './rules.js';

const string = (max: number, min = 0) => rule((value, path, errors) => {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(path, 'expected bounded work memory text', errors);
}, { type: 'string', minLength: min, maxLength: max });
const id = string(200, 1), hash = string(64, 64);
const sourceKind = enumeration(['native', 'observed', 'knowledge', 'skill']);
const scope = object({ profileId: id, workspaceId: id, boundary: hash });
const sourceVariants = [
  object({ kind: enumeration(['native', 'knowledge', 'skill']), sourceId: id, sessionId: id, episodeId: id, revision: hash, accessKey: optional(hash) }),
  object({ kind: literal('observed'), sourceId: id, sessionId: id, episodeId: id, revision: hash, accessKey: hash }),
];
const source = rule((value, path, errors) => {
  if (!sourceVariants.some(candidate => { const found: string[] = []; candidate.check(value, path, found); return found.length === 0; })) fail(path, 'expected attributed source with current Observe access key', errors);
}, { oneOf: sourceVariants.map(candidate => candidate.schema) });
const entry = (max: number) => object({ id, kind: enumeration(['user', 'assistant', 'tool', 'file', 'status', 'knowledge', 'skill']), text: string(max), at: optional(string(80)) });
const coverage = object({ mode: enumeration(['partial', 'unknown']), omittedEntries: count, truncated: boolean, limits: array(string(500), false, 0, 8) });
const outcome = enumeration(['completed', 'failed', 'cancelled']);
const record = object({ id: hash, revision: hash, scope, source, outcome, title: string(200, 1), summary: string(2000), capturedAt: string(80, 1), entries: number(1, true, 32), trust: literal('attributed-evidence'), coverage });
const observedSourceKeys = optional(array(hash, true, 0, 32));

export const workMemoryActions: Record<string, [Rule, Rule]> = {
  'memory.capture': [object({ scope, source, outcome, title: string(200, 1), summary: string(2000), entries: array(entry(8000), false, 1, 32), coverage }), object({ record, created: boolean })],
  'memory.search': [object({ scope, query: string(500), limit: optional(number(1, true, 12)), observedSourceKeys }), object({ hits: array(object({ record, excerpt: string(1000) }), false, 0, 12), omitted: count })],
  'memory.read': [object({ scope, id: hash, revision: hash, offset: optional(number(0, true, 32)), limit: optional(number(1, true, 32)), observedSourceKeys }), object({ record, entries: array(entry(2000), false, 0, 32), offset: count, total: number(1, true, 32), nextOffset: optional(count) })],
  'memory.revoke': [object({ scope, sourceKind: optional(sourceKind), sourceId: optional(id), sessionId: optional(id), episodeId: optional(id), accessKey: optional(hash) }), object({ removed: count })],
};
