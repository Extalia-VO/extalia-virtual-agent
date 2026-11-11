import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentHostApi, SessionSummary } from '@extalia/platform';
import { supportsObservedPromptQueue } from '../observe/observedCodexPromptModel';
import { createPromptQueueControl } from './promptQueueModel';

/** One queue subscription shared by the composer and its list. */
export function usePromptQueue(agents: AgentHostApi, session?: SessionSummary, disabled = false) {
  const control = useMemo(() => createPromptQueueControl(agents, session?.id ?? ''),
    // Source rebinding invalidates pending operations and discards the old editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, session?.id, session?.observation?.sourceId, session?.observation?.nativeSessionId]);
  const view = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  const locked = disabled || !session || session.control === 'observed' && (!supportsObservedPromptQueue(session.observation?.sourceId)
    || !session.observation.watching || session.observation.status !== 'watching');
  useLayoutEffect(() => { control.setDisabled(locked); }, [control, locked]);
  const available = !!session && (session.control !== 'observed' || supportsObservedPromptQueue(session.observation?.sourceId));
  useLayoutEffect(() => { if (available) return control.start(); }, [control, available]);
  return { control, view, locked };
}
