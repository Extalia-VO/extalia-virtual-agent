import { safeText, type PortableSession } from '@extalia/core';
import type { ModelMessage } from '@extalia/runtime';

/** Total characters of earlier conversation carried into the new session (roughly 15k tokens). */
export const CONTINUATION_BUDGET = 60_000;
/** Longest single message carried over; longer ones keep their start and end. */
export const CONTINUATION_MESSAGE_LIMIT = 8_000;

export interface CarriedMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface Continuation {
  /** The carried messages in order, as the new session shows them. */
  messages: CarriedMessage[];
  /** Model history for the new session: alternating user/assistant text, starting with the user. */
  history: ModelMessage[];
  /** Conversation messages left out to stay within the budget. */
  omitted: number;
}

function clip(text: string): string {
  const clean = safeText(text, 200_000).trim();
  if (clean.length <= CONTINUATION_MESSAGE_LIMIT) return clean;
  const half = Math.floor((CONTINUATION_MESSAGE_LIMIT - 40) / 2);
  return `${clean.slice(0, half)}\n[… ${clean.length - half * 2} characters left out …]\n${clean.slice(-half)}`;
}

/**
 * Carry a conversation from another agent (Codex, Claude Code, …) into a new
 * Extalia session. Only user and assistant text is kept: the other agent's
 * tool calls cannot be replayed, and tool output is usually large and stale.
 * The first request is always kept because it states the task; the rest is
 * filled from the most recent messages backwards.
 */
export function buildContinuation(session: Pick<PortableSession, 'messages'>, budget = CONTINUATION_BUDGET): Continuation {
  const conversation = session.messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({ role: message.role as CarriedMessage['role'], text: clip(message.content), at: message.createdAt }))
    .filter(message => message.text);

  const firstUser = conversation.findIndex(message => message.role === 'user');
  const kept = new Set<number>();
  let used = 0;
  if (firstUser !== -1) { kept.add(firstUser); used += conversation[firstUser]!.text.length; }
  for (let index = conversation.length - 1; index > firstUser; index--) {
    const size = conversation[index]!.text.length;
    if (used + size > budget) break;
    kept.add(index);
    used += size;
  }
  const messages = conversation.filter((_, index) => kept.has(index));
  const omitted = conversation.length - messages.length;
  const tailStart = [...kept].filter(index => index > firstUser).sort((a, b) => a - b)[0] ?? conversation.length;
  const gap = firstUser === -1 ? 0 : tailStart - firstUser - 1;

  // Providers expect the history to start with the user; neighbours with the same role are merged.
  const history: ModelMessage[] = [];
  messages.forEach((message, index) => {
    const last = history.at(-1);
    if (message.role === 'user') {
      if (last?.role === 'user') last.text += `\n\n${message.text}`;
      else history.push({ role: 'user', text: message.text });
    } else if (!last) {
      history.push({ role: 'user', text: '(The conversation continues from an earlier part that is not shown.)' }, { role: 'assistant', text: message.text, toolCalls: [] });
    } else if (last.role === 'assistant') last.text += `\n\n${message.text}`;
    else history.push({ role: 'assistant', text: message.text, toolCalls: [] });
    const tail = history.at(-1);
    if (index === 0 && gap > 0 && tail?.role === 'user') tail.text += `\n\n[${gap} later messages are left out here.]`;
  });
  return { messages, history, omitted };
}
