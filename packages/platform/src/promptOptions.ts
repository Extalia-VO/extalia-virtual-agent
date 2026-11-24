const REQUEST_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Optional client UUID for fail-closed idempotent prompt retries. */
export function normalizePromptClientRequestId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid prompt options.');
  if (!Object.hasOwn(raw, 'clientRequestId')) return undefined;
  const value = (raw as { clientRequestId?: unknown }).clientRequestId;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !REQUEST_ID_UUID.test(value)) throw new Error('The request id must be a valid UUID.');
  return value.toLowerCase();
}
