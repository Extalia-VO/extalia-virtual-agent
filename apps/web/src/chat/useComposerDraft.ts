import { useMemo, useSyncExternalStore } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import { composerDraftKey, composerDraftStore } from './composerDrafts';

export function useComposerDraft(agents: AgentHostApi, session?: SessionSummary, workspaceId?: string) {
  const key = composerDraftKey(session, workspaceId);
  const store = useMemo(() => composerDraftStore(agents), [agents]);
  const getSnapshot = () => store.entry(key).getSnapshot();
  const snapshot = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  return { ...snapshot,
    setText: (next: string | ((current: string) => string)) => store.entry(key).setText(next),
    beginSend: () => store.entry(key).beginSend(), allowRetry: () => store.entry(key).allowRetry(),
    bindSession: (id: string) => !session && !!workspaceId && store.bindSession(workspaceId, id),
  };
}
