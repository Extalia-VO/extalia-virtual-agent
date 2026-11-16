import { describe, expect, it } from 'vitest';
import { isCodexSuggestionOnlyMessages, isCodexSuggestionPrompt } from '../src/codexSuggestionSessions.js';

const header = 'This is an app-generated request for a suggested next user message. The user did not write this message.';
const helper = `${header}\nReturn a concise suggestion based on the preceding conversation.`;
const user = (content: string) => ({ role: 'user', content });

describe('Codex suggestion-session classification', () => {
  it('matches the canonical prefix followed by instructions or whitespace/end', () => {
    expect(isCodexSuggestionPrompt(header)).toBe(true);
    expect(isCodexSuggestionPrompt(helper)).toBe(true);
    expect(isCodexSuggestionPrompt(` \n${helper.replaceAll(' ', ' \t ')}\n`)).toBe(true);
    expect(isCodexSuggestionOnlyMessages('codex', [user(helper), { role: 'assistant', content: 'Run tests' }])).toBe(true);
  });

  it.each([
    `Please inspect this helper prompt: ${helper}`,
    `> ${helper}`,
    `"${helper}"`,
    `\`\`\`\n${helper}\n\`\`\``,
    'This is an app-generated request for a suggested next user message.',
    'The user did not write this message.',
    header.replace('suggested next', 'suggested previous'),
    `${header}Extra`,
    header.toLowerCase(),
  ])('keeps quoted, mentioned or near-match text visible: %s', content => {
    expect(isCodexSuggestionPrompt(content)).toBe(false);
    expect(isCodexSuggestionOnlyMessages('codex', [user(content)], header)).toBe(false);
  });

  it('bounds prompt inspection without treating a clipped prefix as a complete header', () => {
    expect(isCodexSuggestionPrompt(`${header} ${'instruction '.repeat(20_000)}`)).toBe(true);
    expect(isCodexSuggestionPrompt(`${' '.repeat(4096 - header.length)}${header}Extra`)).toBe(false);
    expect(isCodexSuggestionPrompt(`${' '.repeat(4096)}${header}`)).toBe(false);
  });

  it('requires every noninjected user prompt to be a helper', () => {
    expect(isCodexSuggestionOnlyMessages('codex', [user('<environment_context>example</environment_context>'), user(helper), user(header)])).toBe(true);
    expect(isCodexSuggestionOnlyMessages('codex', [user(helper), user('Now implement this change')], header)).toBe(false);
    expect(isCodexSuggestionOnlyMessages('codex', [user('Fix tests'), user(helper)], header)).toBe(false);
    expect(isCodexSuggestionOnlyMessages('codex', [{ role: 'tool', content: helper }])).toBe(false);
  });

  it('uses only the full original header as a fallback when no user prompt is readable', () => {
    expect(isCodexSuggestionOnlyMessages('codex', [], header)).toBe(true);
    expect(isCodexSuggestionOnlyMessages('codex', [user('<INSTRUCTIONS>context</INSTRUCTIONS>')], helper)).toBe(true);
    expect(isCodexSuggestionOnlyMessages('codex', [], 'This is an app-generated request')).toBe(false);
    expect(isCodexSuggestionOnlyMessages('codex', [], 'A suggested next user message')).toBe(false);
    expect(isCodexSuggestionOnlyMessages('codex', [])).toBe(false);
  });

  it.each(['claude-code', 'gemini-cli', 'hermes', 'antigravity'])('preserves the %s source', sourceId => {
    expect(isCodexSuggestionOnlyMessages(sourceId, [user(helper)], header)).toBe(false);
    expect(isCodexSuggestionOnlyMessages(sourceId, [], header)).toBe(false);
  });
});
