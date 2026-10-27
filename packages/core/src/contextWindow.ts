/**
 * Context window sizes (tokens) of the model families Extalia knows. Unknown models have no
 * window: the UI then shows the tokens in use without a percentage. Values are the families'
 * published defaults; a 1M variant is recognised by its name or by a prompt larger than the default.
 */
interface WindowRule {
  pattern: RegExp;
  tokens: number;
}

const CLAUDE_1M = /\[1m\]|-1m(?:$|[^a-z0-9])|\b1m[-_]context\b/i;

const RULES: readonly WindowRule[] = [
  { pattern: /^claude-/i, tokens: 200_000 },
  { pattern: /^gpt-5/i, tokens: 400_000 },
  { pattern: /^gpt-4\.1/i, tokens: 1_047_576 },
  { pattern: /^gpt-4o|^chatgpt-4o/i, tokens: 128_000 },
  { pattern: /^gpt-4-turbo/i, tokens: 128_000 },
  { pattern: /^gpt-4-32k/i, tokens: 32_768 },
  { pattern: /^gpt-4(?:-\d{4}|$)/i, tokens: 8_192 },
  { pattern: /^gpt-3\.5-turbo/i, tokens: 16_385 },
  { pattern: /^o[134](?:-|$)/i, tokens: 200_000 },
  { pattern: /^gemini-/i, tokens: 1_048_576 },
];

/** Characters per token used when a provider reports no usage (a conservative estimate for English and code). */
export const CONTEXT_CHARS_PER_TOKEN = 4;

/** Upper bound of a sane token count, so a corrupt record never shows an absurd percentage. */
export const MAX_CONTEXT_TOKENS = 100_000_000;

/**
 * The context window of a model, in tokens; `undefined` when the model is unknown. `usedTokens`
 * lets a Claude model whose name does not say so use its 1M window once a prompt outgrows 200k.
 */
export function contextWindowOf(model: string | undefined, usedTokens?: number): number | undefined {
  const name = (model ?? '').trim().toLowerCase().split('/').pop() ?? '';
  if (!name) return undefined;
  if (name.startsWith('claude-')) {
    if (CLAUDE_1M.test(name) || (usedTokens !== undefined && usedTokens > 200_000)) return 1_000_000;
    return 200_000;
  }
  return RULES.find(rule => rule.pattern.test(name))?.tokens;
}

/** Estimated tokens of text, used only when no provider usage is reported. Never negative. */
export function estimateTokens(chars: number): number {
  return Math.max(0, Math.ceil(chars / CONTEXT_CHARS_PER_TOKEN));
}

/** Whether a stored context record is well formed (counts are non-negative integers, a window is positive). */
export function isContextUsage(value: unknown): value is { usedTokens: number; windowTokens?: number; estimated: boolean; compactions: number; updatedAt: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const count = (item: unknown, min: number) => typeof item === 'number' && Number.isSafeInteger(item) && item >= min && item <= MAX_CONTEXT_TOKENS;
  return count(record.usedTokens, 0) && (record.windowTokens === undefined || count(record.windowTokens, 1))
    && typeof record.estimated === 'boolean' && count(record.compactions, 0)
    && typeof record.updatedAt === 'string' && Number.isFinite(Date.parse(record.updatedAt));
}

/** Share of the window in use, in percent (may exceed 100 when the prompt outgrew the stated window). */
export function contextPercent(usedTokens: number, windowTokens: number | undefined): number | undefined {
  if (!windowTokens || windowTokens <= 0) return undefined;
  return Math.round((usedTokens / windowTokens) * 100);
}

/** Warning from 80% of the window, danger from 95%. */
export function contextTone(percent: number | undefined): 'normal' | 'warning' | 'danger' {
  if (percent === undefined) return 'normal';
  if (percent >= 95) return 'danger';
  if (percent >= 80) return 'warning';
  return 'normal';
}
