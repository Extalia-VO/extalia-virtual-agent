import { isInjectedContext } from '@extalia/importers';

const SUGGESTION_HEADER = 'This is an app-generated request for a suggested next user message. The user did not write this message.';

/** Match the complete app-generated header at the start, allowing only whitespace normalization. */
export function isCodexSuggestionPrompt(text: string): boolean {
  const normalized = text.slice(0, 4096).replace(/\s+/g, ' ').trimStart();
  return normalized.startsWith(SUGGESTION_HEADER)
    && (normalized[SUGGESTION_HEADER.length] === ' '
      || normalized.length === SUGGESTION_HEADER.length && text.length <= 4096);
}

/** Source-specific classification; conversation content and original source titles only. No I/O. */
export function isCodexSuggestionOnlyMessages(
  sourceId: string,
  messages: readonly { role: string; content: string }[],
  fallbackTitle?: string,
): boolean {
  if (sourceId !== 'codex') return false;
  const prompts = messages.filter(message => message.role === 'user' && message.content.trim() && !isInjectedContext(message.content));
  return prompts.length > 0
    ? prompts.every(message => isCodexSuggestionPrompt(message.content))
    : typeof fallbackTitle === 'string' && isCodexSuggestionPrompt(fallbackTitle);
}
