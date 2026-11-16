import type { AgentHostApi, HostState, NotificationCapability } from '@extalia/platform';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import { approvalNotificationsEnabled } from '../approvals/notify';
import { createObservedInputControl, createObservedInputNoticeTracker, observedInputSource, watchedInputSessions, type ObservedInputControl, type ObservedInputView } from './observedInputModel';

export interface ObservedInputContextValue {
  control: ObservedInputControl;
  view: ObservedInputView;
  locate: (sessionId: string, requestId?: string) => void;
}
export const ObservedInputContext = createContext<ObservedInputContextValue | null>(null);
export const useObservedInputs = () => useContext(ObservedInputContext);

export function ObservedInputProvider({ t, hostKind, agents, state, notifier, onLocate, children }: {
  t: Messages; hostKind: 'desktop' | 'web'; agents: AgentHostApi | undefined; state: HostState | null;
  notifier?: NotificationCapability | undefined; onLocate: (sessionId: string, requestId?: string) => void; children: ReactNode;
}) {
  const read = agents?.observedUserInputStatus, answer = agents?.answerObservedUserInput;
  const profileId = state?.profile.id, dataDirectory = state?.dataDirectory ?? state?.storage.dataDirectory;
  // Profile switches may retain the API object and session IDs. Discard their UI owner too.
  // Hosts may replace a capability on the same API object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const control = useMemo(() => createObservedInputControl(agents), [agents, read, answer, profileId, dataDirectory]);
  const snapshot = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot);
  useLayoutEffect(() => control.start(), [control]);
  useLayoutEffect(() => { control.setSessions(state?.sessions ?? []); }, [control, state?.sessions]);
  // Mask source replacement/pausing synchronously, before layout effects run.
  const view = useMemo<ObservedInputView>(() => {
    const current = new Map(watchedInputSessions(state?.sessions ?? []).map(session => [session.id, observedInputSource(session)]));
    return { ...snapshot, entries: Object.fromEntries(Object.entries(snapshot.entries).filter(([id, entry]) => current.get(id) === entry.source)) };
  }, [snapshot, state?.sessions]);
  const latest = useRef({ view, onLocate });
  useLayoutEffect(() => { latest.current = { view, onLocate }; });
  const notificationState = useRef({ control, take: createObservedInputNoticeTracker() });
  useEffect(() => {
    if (notificationState.current.control !== control) notificationState.current = { control, take: createObservedInputNoticeTracker() };
    const fresh = notificationState.current.take(view.entries);
    if (!notifier || notifier.supportsTargets !== true || !approvalNotificationsEnabled(hostKind)) return;
    const attentive = typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();
    if (attentive) return;
    for (const target of fresh) void notifier.notify({ title: t.observedInput.notifyTitle, body: t.observedInput.notifyBody, target }).catch(() => undefined);
  }, [view, control, notifier, hostKind, t]);
  useEffect(() => notifier?.onActivate(target => {
    if (target?.kind !== 'observed-input') return;
    const { view: currentView, onLocate: locate } = latest.current;
    if (currentView.entries[target.sessionId]?.requests.some(request => request.id === target.requestId)) locate(target.sessionId, target.requestId);
  }), [notifier]);
  return <ObservedInputContext value={{ control, view, locate: onLocate }}>{children}</ObservedInputContext>;
}
