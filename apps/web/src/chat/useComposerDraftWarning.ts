import { useEffect, useId, useSyncExternalStore } from 'react';
import type { AgentHostApi } from '@extalia/platform';
import { useUnsavedDraft } from '../restart/unsavedDrafts';
import { composerDraftStore } from './composerDrafts';

const empty = () => false;
const noSubscription = () => () => undefined;
/** Retained text still protects restart/navigation when no composer is mounted. */
export function useComposerDraftWarning(agents?: AgentHostApi): void {
  const store = agents ? composerDraftStore(agents) : undefined;
  const dirty = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.hasDrafts ?? empty, empty);
  const owner = useId();
  useUnsavedDraft(owner, dirty);
  useEffect(() => {
    if (!store || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!store.hasDrafts()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [store, dirty]);
}
