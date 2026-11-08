import type { AgentHostApi } from '@extalia/platform';
import { useEffect, useId, useSyncExternalStore } from 'react';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { memoryDraftStore } from './workspaceMemoryModel';

const noDrafts = () => 0;
const noSubscription = () => () => undefined;

/** Mount once in the application shell so retained drafts protect navigation away from Chat. */
export function useWorkspaceMemoryDraftWarning(agents: AgentHostApi | undefined): void {
  const store = agents ? memoryDraftStore(agents) : undefined;
  const count = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.dirtyCount ?? noDrafts, noDrafts);
  const owner = useId();
  useUnsavedDraft(owner, count > 0);
  useEffect(() => {
    if (!store || count === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (store.dirtyCount() === 0) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [store, count]);
}
