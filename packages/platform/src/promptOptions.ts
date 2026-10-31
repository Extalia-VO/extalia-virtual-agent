/** Explicit, per-message skill-learning opt-in; attachment options remain independent. */
export function normalizePromptLearnSkill(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid prompt options.');
  if (!Object.hasOwn(raw, 'learnSkill')) return false;
  const value = (raw as { learnSkill?: unknown }).learnSkill;
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('Skill learning must be explicitly enabled or disabled.');
  return value;
}
