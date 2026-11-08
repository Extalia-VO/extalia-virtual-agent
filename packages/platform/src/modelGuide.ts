import type { ModelSelectionGuide, ModelSelectionGuideInput } from '@extalia/core';
export { modelPlanningBasis, modelSelectionGuidePrompt } from '@extalia/core';
export type { ModelSelectionGuide, ModelSelectionGuideInput, ModelPlanningBasis } from '@extalia/core';

export const MODEL_SELECTION_GUIDE_LIMITS = { title: 120, revision: 80, text: 24_000 } as const;
export const MODEL_SELECTION_GUIDE_METHODS = ['getModelSelectionGuide', 'saveModelSelectionGuide'] as const;

/** Strict inbound data; updatedAt is assigned only by the host. null clears the guide. */
export function normalizeModelSelectionGuideInput(raw: unknown): ModelSelectionGuideInput | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('Invalid Model Selection Guide.');
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !['title', 'revision', 'text'].includes(key))) throw new Error('Invalid Model Selection Guide field.');
  for (const field of ['title', 'revision', 'text'] as const) {
    const item = value[field];
    if (typeof item !== 'string' || item.length > MODEL_SELECTION_GUIDE_LIMITS[field] || item.includes('\0') || (field !== 'text' && /[\r\n]/.test(item)) || (field !== 'revision' && !item.trim())) throw new Error(`Model Selection Guide ${field}: invalid or longer than ${MODEL_SELECTION_GUIDE_LIMITS[field]} characters.`);
  }
  return { title: (value.title as string).trim(), revision: (value.revision as string).trim(), text: value.text as string };
}

export function normalizeModelSelectionGuide(raw: unknown): ModelSelectionGuide {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid saved Model Selection Guide.');
  const { updatedAt, ...input } = raw as Record<string, unknown>;
  if (typeof updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid Model Selection Guide timestamp.');
  return { ...normalizeModelSelectionGuideInput(input)!, updatedAt };
}
