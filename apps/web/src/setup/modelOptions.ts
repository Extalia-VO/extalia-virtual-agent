import type { ComboOption } from '../ui/ComboBox';

/**
 * Options for a model field: ids grouped by their provider prefix (`provider/model`). Groups keep the
 * order the endpoint listed them in, and ids without a prefix form the `otherGroup`, listed last.
 * Blank and duplicate ids are dropped; the id equal to `defaultModel` gets `defaultBadge`.
 */
export function groupedModelOptions(models: readonly string[], { otherGroup, defaultModel, defaultBadge }: {
  otherGroup: string;
  defaultModel?: string;
  defaultBadge?: string;
}): ComboOption[] {
  const groups = new Map<string, string[]>();
  for (const model of new Set(models.map(item => item.trim()).filter(Boolean))) {
    const slash = model.indexOf('/');
    const group = slash > 0 ? model.slice(0, slash) : otherGroup;
    groups.set(group, [...(groups.get(group) ?? []), model]);
  }
  const ordered = [...groups].sort(([a], [b]) => Number(a === otherGroup) - Number(b === otherGroup));
  return ordered.flatMap(([group, ids]) => ids.map((model): ComboOption => ({
    value: model,
    label: model,
    group,
    ...(defaultBadge && model === defaultModel ? { badge: defaultBadge } : {}),
  })));
}

/** Options for a task tier: the first entry, the main model, stores an empty tier (the connection's own model runs). */
export function tierModelOptions(models: readonly string[], labels: { mainModel: string; otherGroup: string }): ComboOption[] {
  return [{ value: '', label: labels.mainModel }, ...groupedModelOptions(models, { otherGroup: labels.otherGroup })];
}

/** The limits offered for "Max delegations per turn"; 0 turns delegation off. */
export const DELEGATION_CHOICES: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/**
 * Select options for the delegation limit. A stored value outside the list (up to the host's 20) is kept
 * as an extra choice, so opening the form never changes it silently.
 */
export function delegationLimitOptions(current: string, offLabel: string): { value: string; label: string }[] {
  const text = current.trim();
  const value = Number(text);
  const extra = /^\d{1,2}$/.test(text) && value <= 20 && !DELEGATION_CHOICES.includes(value) ? [value] : [];
  return [...DELEGATION_CHOICES, ...extra]
    .sort((a, b) => a - b)
    .map(limit => ({ value: String(limit), label: limit === 0 ? offLabel : String(limit) }));
}
