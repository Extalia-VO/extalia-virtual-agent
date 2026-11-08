import { MAX_GOAL_DOCUMENT_BYTES, MAX_GOAL_DOCUMENT_CHARS } from '@extalia/core';
import type { GoalDocument } from '@extalia/core';
import { useEffect, useMemo } from 'react';

export function goalDocumentFromText(text: string, name = 'goal.txt'): GoalDocument | undefined {
  if (!text.trim() || text.length > MAX_GOAL_DOCUMENT_CHARS) return undefined;
  let bytes = 0;
  for (const character of text) { const code = character.codePointAt(0)!; bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4; }
  return bytes <= MAX_GOAL_DOCUMENT_BYTES ? { name, text } : undefined;
}

export function goalReference(name: string): string {
  return `Full goal attached: ${name}`;
}

export function useGoalDocumentUrl(document: GoalDocument | undefined): string | undefined {
  const url = useMemo(() => document ? URL.createObjectURL(new Blob([document.text], { type: 'text/plain;charset=utf-8' })) : undefined, [document]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

/** Repeated imports extend the retained document rather than replacing its hidden contents. */
export function extendGoalDocument(document: GoalDocument | undefined, text: string): string {
  return document ? `${document.text}\n\n${text}` : text;
}
