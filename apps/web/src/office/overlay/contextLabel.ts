import { contextPercent, contextTone } from '@extalia/core';
import type { SessionContextUsage } from '@extalia/platform';
import type { Messages } from '../../i18n';

export type ContextTone = 'normal' | 'warning' | 'danger';

/** A token count as a short figure: 950, 124k, 1.1M. */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

export interface ContextLabel {
  /** "62% · 124k / 200k", or "124k tokens" when the model's window is unknown; "≈" marks an estimate. */
  value: string;
  tone: ContextTone;
  /** Share of the window in use; absent without a window. */
  percent?: number;
  /** Tooltip: what the figure means and what to do about it. */
  title: string;
}

/** The context figure of a session, in the language of `t`. */
export function contextLabel(context: SessionContextUsage, t: Messages): ContextLabel {
  const c = t.context;
  const mark = context.estimated ? c.estimateMark : '';
  const percent = contextPercent(context.usedTokens, context.windowTokens);
  const tone = contextTone(percent);
  const used = `${mark}${formatTokenCount(context.usedTokens)}`;
  const value = context.windowTokens && percent !== undefined
    ? c.usage(`${mark}${percent}%`, used, formatTokenCount(context.windowTokens))
    : c.tokens(used);
  const notes = [
    tone === 'danger' ? c.danger : tone === 'warning' ? c.warning : undefined,
    context.estimated ? c.estimated : undefined,
    context.windowTokens ? undefined : c.unknownWindow,
    context.compactions > 0 ? c.compactions(context.compactions) : undefined,
  ].filter((note): note is string => Boolean(note));
  return { value, tone, ...(percent !== undefined ? { percent } : {}), title: notes.join(' · ') };
}
