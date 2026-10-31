import { SKILL_PACKAGE_ID_PATTERN, SKILL_PREFLIGHT_CODES, SKILL_REVISION_ID_PATTERN, SKILL_WORKSPACE_ID_PATTERN } from './daemonSkills.js';
import { utf8Length } from './daemonKnowledgeRules.js';
import { SKILL_ROUTING_INPUT_ISSUES, SKILL_ROUTING_MAX_BYTES, type SkillRoutingReport } from './daemonSkillRouting.js';
import { array, boolean, enumeration, fail, isPlainObject, literal, number, object, optional, rule } from './rules.js';

const id = (pattern: RegExp, max: number) => rule((value, path, errors) => {
  if (typeof value !== 'string' || value.length > max || /[\r\n\u2028\u2029]/.test(value) || !pattern.test(value)) fail(path, 'invalid routing identity', errors);
}, { type: 'string', maxLength: max, pattern: pattern.source, not: { pattern: '[\\r\\n\\u2028\\u2029]' } });
const packageId = id(SKILL_PACKAGE_ID_PATTERN, 64), revisionId = id(SKILL_REVISION_ID_PATTERN, 68);
const category = id(/^[a-z0-9][a-z0-9_-]{0,31}(?:\.[a-z0-9][a-z0-9_-]{0,31}){0,5}$/, 128);
const intent = id(/^[a-z][a-z0-9_]{0,63}$/, 64);
const pins = rule((value, path, errors) => {
  if (!isPlainObject(value) || Reflect.ownKeys(value).length > 128) { fail(path, 'expected at most 128 exact pins', errors); return; }
  for (const key of Reflect.ownKeys(value)) {
    packageId.check(key, `${path}.packageId`, errors);
    revisionId.check(typeof key === 'string' ? value[key] : undefined, `${path}.revisionId`, errors);
  }
}, { type: 'object', maxProperties: 128, propertyNames: packageId.schema, additionalProperties: revisionId.schema });
const inputShape = object({ categories: array(category, true, 0, 32), intents: array(intent, true, 0, 32), candidateRevisionIds: array(revisionId, true, 0, 16), pins,
  workspaceId: optional(id(SKILL_WORKSPACE_ID_PATTERN, 36)), maxResults: number(1, true, 16) });
export const skillRoutingParams = rule((value, path, errors) => {
  const before = errors.length; inputShape.check(value, path, errors);
  if (errors.length === before && !(value as SkillRoutingReport['input']).categories.length && !(value as SkillRoutingReport['input']).intents.length) fail(path, 'choose a category or intent', errors);
}, { ...inputShape.schema, allOf: [{ if: { properties: { categories: { maxItems: 0 } } }, then: { properties: { intents: { minItems: 1 } } } }] });
const sha = id(/^[a-f0-9]{64}$/, 64);
const version = id(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, 128);
const identity = object({ packageId, version, revisionId, treeSha256: sha, permissionDigest: sha });
const issue = object({ code: enumeration(SKILL_PREFLIGHT_CODES), packageId: optional(packageId), relatedPackageId: optional(packageId) });
const score = object({ exactIntents: number(0, true, 32), exactCategories: number(0, true, 32), descendantCategories: number(0, true, 32) });
const candidate = object({ identity, score, matches: object({ exactIntents: array(intent, true, 0, 32), exactCategories: array(category, true, 0, 32),
  descendantCategories: array(object({ requested: category, declared: category }), false, 0, 32), rationaleTruncated: boolean }), plan: array(identity, false, 1, 128) });
const shape = object({ input: skillRoutingParams, dispatchEligible: literal(false), status: enumeration(['invalid', 'no_safe_skill', 'matched', 'ambiguous']),
  candidates: array(candidate, false, 0, 16), exclusions: array(object({ identity, reason: enumeration(['selector_mismatch', 'root_inactive', 'root_unavailable', 'inconsistent_preflight']),
    diagnostics: array(issue, false, 0, 32), omittedDiagnostics: number(0, true) }), false, 0, 16), issues: array(enumeration(SKILL_ROUTING_INPUT_ISSUES), true, 0, SKILL_ROUTING_INPUT_ISSUES.length),
  eligibleCount: number(0, true, 16), topTieCount: number(0, true, 16) });
const same = (a: unknown, b: unknown) => {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key]);
};
export const skillRoutingResult = rule((value, path, errors) => {
  const before = errors.length; shape.check(value, path, errors); if (errors.length !== before) return;
  const r = value as SkillRoutingReport;
  const bad = () => fail(path, 'inconsistent routing diagnostics', errors);
  const bytes = utf8Length(JSON.stringify(value));
  if (bytes === undefined || bytes > SKILL_ROUTING_MAX_BYTES) bad();
  if (r.status === 'invalid') {
    if (!r.issues.length || r.candidates.length || r.exclusions.length || r.eligibleCount || r.topTieCount) bad();
    return;
  }
  if (r.issues.length || r.eligibleCount + r.exclusions.length !== r.input.candidateRevisionIds.length
    || r.candidates.length !== Math.min(r.eligibleCount, r.input.maxResults) || r.topTieCount > r.eligibleCount
    || r.status !== (r.topTieCount === 0 ? 'no_safe_skill' : r.topTieCount === 1 ? 'matched' : 'ambiguous') || (!!r.eligibleCount !== !!r.topTieCount)) bad();
  const records = [...r.candidates, ...r.exclusions];
  const identities = new Map<string, typeof r.candidates[number]['identity']>();
  for (const identity of [...records.map(item => item.identity), ...r.candidates.flatMap(item => item.plan)]) {
    const previous = identities.get(identity.revisionId);
    if (previous && !same(previous, identity)) bad();
    else identities.set(identity.revisionId, identity);
  }
  if (new Set(records.map(item => item.identity.packageId)).size !== records.length || new Set(records.map(item => item.identity.revisionId)).size !== records.length) bad();
  for (const record of records) if (!r.input.candidateRevisionIds.includes(record.identity.revisionId) || record.identity.revisionId !== `skr_${record.identity.treeSha256}`) bad();
  if (r.exclusions.reduce((sum, item) => sum + item.diagnostics.length, 0) > 128) bad();
  for (const c of r.candidates) {
    const m = c.matches, s = c.score;
    if (s.exactIntents !== m.exactIntents.length || s.exactCategories !== m.exactCategories.length
      || m.exactIntents.some(id => !r.input.intents.includes(id)) || m.exactCategories.some(id => !r.input.categories.includes(id))
      || (r.input.intents.length && !s.exactIntents) || (r.input.categories.length && !s.exactCategories && !s.descendantCategories)
      || m.descendantCategories.some(pair => !r.input.categories.includes(pair.requested) || !pair.declared.startsWith(`${pair.requested}.`))
      || new Set(m.descendantCategories.map(pair => `${pair.requested}/${pair.declared}`)).size !== m.descendantCategories.length) bad();
    const matched = new Set(m.descendantCategories.map(pair => pair.requested)).size;
    if (s.descendantCategories > r.input.categories.length || (m.rationaleTruncated ? m.descendantCategories.length !== 32 || s.descendantCategories < matched : s.descendantCategories !== matched)) bad();
    if (!same(c.plan.at(-1), c.identity) || new Set(c.plan.map(item => item.packageId)).size !== c.plan.length) bad();
    for (const p of c.plan) if (p.revisionId !== `skr_${p.treeSha256}` || (p.packageId !== c.identity.packageId && r.input.pins[p.packageId] !== p.revisionId)) bad();
  }
  const cmp = (a: typeof r.candidates[number], b: typeof r.candidates[number]) => b.score.exactIntents - a.score.exactIntents || b.score.exactCategories - a.score.exactCategories
    || b.score.descendantCategories - a.score.descendantCategories || (a.identity.packageId < b.identity.packageId ? -1 : a.identity.packageId > b.identity.packageId ? 1 : a.identity.revisionId.localeCompare(b.identity.revisionId));
  if (r.candidates.some((item, index) => index > 0 && cmp(r.candidates[index - 1]!, item) > 0)) bad();
  if (r.candidates.length) {
    const shownTies = r.candidates.filter(c => same(c.score, r.candidates[0]!.score)).length;
    if (shownTies !== Math.min(r.topTieCount, r.candidates.length)) bad();
  }
}, shape.schema);
