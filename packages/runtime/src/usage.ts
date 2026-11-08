import type { Usage } from '@extalia/protocol';

const KEYS = ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const;
type UsageKey = typeof KEYS[number];

export const tokenCount = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
export function tokenSum(left: number, right: number): number | undefined {
  return tokenCount(left) !== undefined && tokenCount(right) !== undefined ? tokenCount(left + right) : undefined;
}

/** Validate fields without replacing missing or contradictory reports with invented counts. */
export function normalizeUsage(raw: Partial<Record<UsageKey, unknown>> | undefined): Usage | undefined {
  if (!raw) return undefined;
  const usage: Usage = {};
  for (const key of KEYS) {
    const value = tokenCount(raw[key]);
    if (value !== undefined) usage[key] = value;
  }
  if (usage.inputTokens !== undefined && usage.cachedInputTokens !== undefined && usage.cachedInputTokens > usage.inputTokens) delete usage.cachedInputTokens;
  return Object.keys(usage).length ? usage : undefined;
}

/** Reported subtotals only. An overflowed field stays unknown for the rest of this aggregation. */
export class UsageAccumulator {
  readonly total: Usage = {};
  private readonly unavailable = new Set<UsageKey>();
  get incomplete(): boolean { return this.unavailable.size > 0; }

  add(usage: Usage | undefined): void {
    if (!usage) return;
    for (const key of KEYS) {
      if (usage[key] === undefined || this.unavailable.has(key)) continue;
      const next = tokenCount(usage[key]);
      const sum = next === undefined ? undefined : tokenSum(this.total[key] ?? 0, next);
      if (sum === undefined) { this.unavailable.add(key); delete this.total[key]; }
      else this.total[key] = sum;
    }
    if (this.total.inputTokens !== undefined && this.total.cachedInputTokens !== undefined && this.total.cachedInputTokens > this.total.inputTokens) {
      this.unavailable.add('cachedInputTokens'); delete this.total.cachedInputTokens;
    }
  }
}
