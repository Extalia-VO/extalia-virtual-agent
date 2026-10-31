/**
 * Workspace skill consent (W0). A project's `.extalia/skills/<skill>/SKILL.md` files reach
 * the model only after the user allows them for that workspace; consent is bound to each
 * file's SHA-256, so an edited or new skill waits for the user again. Pure functions only:
 * the host, the Bridge, Desktop and the Web client all use this module.
 */

/** Skill names: lowercase letters, numbers and hyphens, up to 64 characters. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SKILL_SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Skills one allow or revoke call may name. */
export const MAX_SKILL_CONSENT_ITEMS = 100;

/** `not-allowed`: never allowed for this workspace. `changed`: the file differs from the allowed version. */
export type PendingSkillReason = 'not-allowed' | 'changed';

export interface WorkspaceSkill {
  name: string;
  /** From the skill's front matter. Project text: show it as plain text. */
  description: string;
  /** SHA-256 (hex) of the SKILL.md bytes. */
  sha256: string;
}

export interface PendingWorkspaceSkill extends WorkspaceSkill {
  source: 'workspace';
  reason: PendingSkillReason;
}

export interface WorkspaceSkills {
  workspaceId: string;
  /** Allowed and unchanged: offered to the model. */
  allowed: WorkspaceSkill[];
  /** Found in the project but not offered to the model until the user allows them. */
  pending: PendingWorkspaceSkill[];
  /** Skill files that were skipped, with the reason. */
  warnings: string[];
}

/** A skill the user allows, named with the hash they reviewed (the host refuses it when the file has changed since). */
export interface SkillConsentInput {
  name: string;
  sha256: string;
}

/** Validate an allow request. Throws a message safe to show. */
export function normalizeSkillConsent(value: unknown): SkillConsentInput[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Choose the skills to allow.');
  if (value.length > MAX_SKILL_CONSENT_ITEMS) throw new Error(`Allow at most ${MAX_SKILL_CONSENT_ITEMS} skills at once.`);
  const byName = new Map<string, SkillConsentInput>();
  for (const item of value) {
    const { name, sha256 } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) throw new Error('Invalid skill name.');
    if (typeof sha256 !== 'string' || !SKILL_SHA256_PATTERN.test(sha256)) throw new Error(`Invalid hash for skill "${name}".`);
    byName.set(name, { name, sha256 });
  }
  return [...byName.values()];
}

/** Validate a revoke request: skill names, or `undefined` for every skill of the workspace. Throws a message safe to show. */
export function normalizeSkillNames(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('Skill names must be a list.');
  if (value.length > MAX_SKILL_CONSENT_ITEMS) throw new Error(`Revoke at most ${MAX_SKILL_CONSENT_ITEMS} skills at once.`);
  for (const name of value) if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) throw new Error('Invalid skill name.');
  return [...new Set(value as string[])];
}

/** Catalog categories for bundled skills; unknown host values remain uncategorized. */
export const BUILTIN_SKILL_CATEGORIES = ['planning', 'development', 'quality', 'security', 'documentation', 'delivery'] as const;
export type BuiltinSkillCategory = typeof BUILTIN_SKILL_CATEGORIES[number];

/** A skill that ships with Extalia (read-only; updated with app releases). */
export interface BuiltinSkillInfo {
  name: string;
  description: string;
  /** Optional so clients can still list older hosts' catalogs. */
  category?: BuiltinSkillCategory;
  /** Bundled instructions for plain-text inspection only; never an execution or permission grant. */
  body?: string;
}

/** Built-in skills a host may list. */
export const MAX_BUILTIN_SKILLS = 200;
/** Longest built-in skill description a client shows. */
export const MAX_BUILTIN_SKILL_DESCRIPTION = 1000;
/** Longest bundled instruction body a client accepts for inspection. */
export const MAX_BUILTIN_SKILL_BODY = 16_000;

/**
 * Validate a host's built-in skill list before showing it, de-duplicated and sorted by name. Legacy name/description
 * lists remain valid. Unknown categories and malformed optional bodies are omitted, without dropping the skill.
 * This validates presentation data only; instruction text must be rendered as plain text. Throws a message safe to show.
 */
export function normalizeBuiltinSkills(value: unknown): BuiltinSkillInfo[] {
  if (!Array.isArray(value)) throw new Error('Invalid built-in skill list.');
  if (value.length > MAX_BUILTIN_SKILLS) throw new Error(`At most ${MAX_BUILTIN_SKILLS} built-in skills are listed.`);
  const byName = new Map<string, BuiltinSkillInfo>();
  for (const item of value) {
    const { name, description, category, body } = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) throw new Error('Invalid built-in skill name.');
    if (typeof description !== 'string' || description.length > MAX_BUILTIN_SKILL_DESCRIPTION) throw new Error(`Invalid description for built-in skill "${name}".`);
    const normalized: BuiltinSkillInfo = { name, description: description.trim() };
    if (typeof category === 'string' && BUILTIN_SKILL_CATEGORIES.some(value => value === category)) normalized.category = category as BuiltinSkillCategory;
    // Permit ordinary multiline text but omit terminal controls and oversized values instead of truncating instructions.
    if (typeof body === 'string' && body.length <= MAX_BUILTIN_SKILL_BODY && body.trim()
      && !Array.from(body).some(character => {
        const code = character.charCodeAt(0);
        return (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159);
      })) normalized.body = body.trim();
    byName.set(name, normalized);
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
