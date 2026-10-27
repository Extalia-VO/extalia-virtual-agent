import { describe, expect, it } from 'vitest';
import { contextPercent, contextTone, contextWindowOf, estimateTokens, isContextUsage } from '../src/index.js';

describe('context window table', () => {
  it('knows the Claude, GPT and Gemini families', () => {
    expect(contextWindowOf('claude-sonnet-4-5')).toBe(200_000);
    expect(contextWindowOf('claude-opus-5-5-20260101')).toBe(200_000);
    expect(contextWindowOf('gpt-5-codex')).toBe(400_000);
    expect(contextWindowOf('gpt-4.1-mini')).toBe(1_047_576);
    expect(contextWindowOf('gpt-4o-2024-08-06')).toBe(128_000);
    expect(contextWindowOf('gpt-4-0613')).toBe(8_192);
    expect(contextWindowOf('o3-mini')).toBe(200_000);
    expect(contextWindowOf('gemini-2.5-pro')).toBe(1_048_576);
  });

  it('recognises 1M Claude variants by name, and by a prompt that outgrows 200k', () => {
    expect(contextWindowOf('claude-sonnet-4-5[1m]')).toBe(1_000_000);
    expect(contextWindowOf('claude-sonnet-4-5', 250_000)).toBe(1_000_000);
    expect(contextWindowOf('claude-sonnet-4-5', 150_000)).toBe(200_000);
  });

  it('reads the last segment of a routed model id and ignores case', () => {
    expect(contextWindowOf('anthropic/Claude-Sonnet-4-5')).toBe(200_000);
    expect(contextWindowOf('openrouter/google/gemini-2.5-flash')).toBe(1_048_576);
  });

  it('has no window for unknown or missing models', () => {
    expect(contextWindowOf(undefined)).toBeUndefined();
    expect(contextWindowOf('')).toBeUndefined();
    expect(contextWindowOf('  ')).toBeUndefined();
    expect(contextWindowOf('mistral-large')).toBeUndefined();
    expect(contextWindowOf('gpt-4.5-preview')).toBeUndefined();
  });
});

describe('context estimation and presentation', () => {
  it('estimates one token per four characters, rounding up and never below zero', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(-10)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(40_000)).toBe(10_000);
  });

  it('computes the share of the window and the warning tones', () => {
    expect(contextPercent(124_000, 200_000)).toBe(62);
    expect(contextPercent(124_000, undefined)).toBeUndefined();
    expect(contextPercent(124_000, 0)).toBeUndefined();
    expect(contextPercent(210_000, 200_000)).toBe(105);
    expect(contextTone(undefined)).toBe('normal');
    expect(contextTone(79)).toBe('normal');
    expect(contextTone(80)).toBe('warning');
    expect(contextTone(94)).toBe('warning');
    expect(contextTone(95)).toBe('danger');
  });

  it('accepts only well-formed stored context records', () => {
    const good = { usedTokens: 124_000, windowTokens: 200_000, estimated: false, compactions: 0, updatedAt: '2026-10-08T00:00:00.000Z' };
    expect(isContextUsage(good)).toBe(true);
    expect(isContextUsage({ ...good, windowTokens: undefined })).toBe(true);
    expect(isContextUsage({ ...good, usedTokens: -1 })).toBe(false);
    expect(isContextUsage({ ...good, usedTokens: 1.5 })).toBe(false);
    expect(isContextUsage({ ...good, compactions: '2' })).toBe(false);
    expect(isContextUsage({ ...good, estimated: 'yes' })).toBe(false);
    expect(isContextUsage({ ...good, updatedAt: 'soon' })).toBe(false);
    expect(isContextUsage(null)).toBe(false);
  });
});
