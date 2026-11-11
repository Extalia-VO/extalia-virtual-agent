import { CONTROL_FREE_PATTERN, type JsonSchema } from './jsonSchema.js';

/** Host preparation receipts, never proof that a model followed a procedure. */
export const SKILL_LOAD_REASONS = ['default-memory', 'configured-team', 'explicit-request', 'current-context', 'recent-context', 'dependency'] as const;
export type SkillLoadReason = typeof SKILL_LOAD_REASONS[number];
export const SKILL_LOAD_STATUSES = ['loaded', 'budget', 'unavailable', 'not-configured'] as const;
export type SkillLoadStatus = typeof SKILL_LOAD_STATUSES[number];
export const SKILL_LOAD_INTENTS = ['planning', 'debugging', 'testing', 'review', 'security', 'documentation', 'design', 'refactoring', 'delivery'] as const;
export type SkillLoadIntent = typeof SKILL_LOAD_INTENTS[number];
export const SKILL_LOAD_LIMITS = { entries: 8, characters: 24_000 } as const;

export interface SkillLoadEntry {
  name: string;
  source: 'builtin' | 'registry';
  reason: SkillLoadReason;
  status: SkillLoadStatus;
  /** Full instruction characters included; zero for skipped entries. */
  characters: number;
  intent?: SkillLoadIntent;
  revisionId?: string;
}

export interface SkillLoadReport {
  skills: SkillLoadEntry[];
  /** Bounded skipped candidates omitted from the receipt; loaded entries are never hidden. */
  omitted?: number;
  /** Includes the escaped source envelope and its host-owned guidance. */
  characters: number;
  budgetCharacters: number;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REVISION_PATTERN = /^skr_[0-9a-f]{64}$/;
const ENTRY_FIELDS = new Set(['name', 'source', 'reason', 'status', 'characters', 'intent', 'revisionId']);
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= SKILL_LOAD_LIMITS.characters;

/** Bounded metadata only. Free-form reasons and instruction bodies do not belong in receipts. */
export function skillLoadEntryErrors(value: unknown, path = 'skills'): string[] {
  if (!Array.isArray(value) || value.length > SKILL_LOAD_LIMITS.entries) return [`${path}: expected up to ${SKILL_LOAD_LIMITS.entries} skill entries.`];
  const errors: string[] = [], names = new Set<string>();
  value.forEach((item, index) => {
    const at = `${path}[${index}]`;
    if (!record(item)) { errors.push(`${at}: expected an object.`); return; }
    for (const key of Object.keys(item)) if (!ENTRY_FIELDS.has(key)) errors.push(`${at}.${key}: unknown field.`);
    if (typeof item.name !== 'string' || SKILL_NAME_PATTERN.exec(item.name)?.[0] !== item.name) errors.push(`${at}.name: expected a lowercase skill name of at most 64 characters.`);
    else if (names.has(item.name)) errors.push(`${at}.name: duplicate skill name.`);
    else names.add(item.name);
    if (item.source !== 'builtin' && item.source !== 'registry') errors.push(`${at}.source: expected builtin or registry.`);
    if (typeof item.reason !== 'string' || !(SKILL_LOAD_REASONS as readonly string[]).includes(item.reason)) errors.push(`${at}.reason: unknown skill-load reason.`);
    if (typeof item.status !== 'string' || !(SKILL_LOAD_STATUSES as readonly string[]).includes(item.status)) errors.push(`${at}.status: unknown skill-load status.`);
    if (!count(item.characters)) errors.push(`${at}.characters: expected an integer from 0 to ${SKILL_LOAD_LIMITS.characters}.`);
    else if (item.status === 'loaded' ? item.characters === 0 : item.characters !== 0) errors.push(`${at}.characters: loaded entries need a positive count; skipped entries must be zero.`);
    if (item.intent !== undefined && (typeof item.intent !== 'string' || !(SKILL_LOAD_INTENTS as readonly string[]).includes(item.intent))) errors.push(`${at}.intent: unknown skill intent.`);
    if (item.revisionId !== undefined && (item.source !== 'registry' || typeof item.revisionId !== 'string' || item.revisionId.length !== 68 || !REVISION_PATTERN.test(item.revisionId))) errors.push(`${at}.revisionId: only registry entries may carry a skill revision identifier.`);
  });
  return errors;
}

/** Cross-field invariants beyond standard JSON Schema: unique names and bounded accounting. */
export function skillLoadReportErrors(value: Record<string, unknown>, path = 'body'): string[] {
  const errors: string[] = [];
  if (count(value.characters) && count(value.budgetCharacters) && value.characters > value.budgetCharacters) errors.push(`${path}.characters: exceeds the context budget.`);
  if (Array.isArray(value.skills) && value.skills.length <= SKILL_LOAD_LIMITS.entries && count(value.characters)) {
    const loadedCharacters = value.skills.reduce((total, item: unknown) => total + (record(item) && item.status === 'loaded' && count(item.characters) ? item.characters : 0), 0);
    if (loadedCharacters > value.characters) errors.push(`${path}.characters: cannot be smaller than the loaded instruction total.`);
  }
  return errors;
}

export function skillLoadEntriesJsonSchema(): JsonSchema {
  return {
    type: 'array', maxItems: SKILL_LOAD_LIMITS.entries, uniqueItems: true,
    items: {
      type: 'object', additionalProperties: false,
      required: ['name', 'source', 'reason', 'status', 'characters'],
      properties: {
        name: { type: 'string', maxLength: 64, pattern: SKILL_NAME_PATTERN.source, allOf: [{ pattern: CONTROL_FREE_PATTERN }] },
        source: { type: 'string', enum: ['builtin', 'registry'] },
        reason: { type: 'string', enum: [...SKILL_LOAD_REASONS] },
        status: { type: 'string', enum: [...SKILL_LOAD_STATUSES] },
        characters: { type: 'integer', minimum: 0, maximum: SKILL_LOAD_LIMITS.characters },
        intent: { type: 'string', enum: [...SKILL_LOAD_INTENTS] },
        revisionId: { type: 'string', minLength: 68, maxLength: 68, pattern: REVISION_PATTERN.source },
      },
      allOf: [
        { if: { properties: { status: { const: 'loaded' } }, required: ['status'] }, then: { properties: { characters: { minimum: 1 } } } },
        { if: { properties: { status: { not: { const: 'loaded' } } }, required: ['status'] }, then: { properties: { characters: { const: 0 } } } },
        { if: { properties: { source: { const: 'builtin' } }, required: ['source'] }, then: { not: { required: ['revisionId'] } } },
      ],
    },
  };
}
