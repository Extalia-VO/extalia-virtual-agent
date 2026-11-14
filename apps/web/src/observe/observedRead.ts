/** A read receipt describes visible output, never activity or merely opening a session. */
export function observedReadCandidate(input: {
  sessionId?: string; revision?: string; loadedRevision?: string; unread?: boolean;
  latestAssistant?: string; renderedAssistant?: string; visible: boolean; pinned: boolean; atLatest: boolean; assistantVisible: boolean;
}): { sessionId: string; revision: string } | undefined {
  if (!input.sessionId || !input.revision || !input.unread || input.loadedRevision !== input.revision
    || !input.latestAssistant?.trim() || input.latestAssistant !== input.renderedAssistant
    || !input.visible || !input.pinned || !input.atLatest || !input.assistantVisible) return undefined;
  return { sessionId: input.sessionId, revision: input.revision };
}
