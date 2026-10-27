import type { AgentHostApi, HostState, NotificationCapability } from '@extalia/platform';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { ApprovalInboxDialog } from './ApprovalInbox';
import { ApprovalsContext, type ApprovalsValue } from './context';
import { approvalKey, decisionFor, dedupeApprovals, derivePendingApprovals, type ApprovalChoice, type PendingApproval } from './model';
import { approvalNotificationsEnabled, freshApprovals, notificationContent, shouldNotify } from './notify';

/** Events of one waiting session, derived once per approval request. */
interface Loaded {
  approvalId: string;
  loading: boolean;
  items: PendingApproval[];
}

/**
 * Pending approvals of every managed session. A session that waits (its
 * summary names a pending approval) has its events read once for that request;
 * the summary alone is not enough because it carries no action or detail.
 */
function useWaitingApprovals(agents: AgentHostApi | undefined, state: HostState | null) {
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const cache = useRef<Record<string, Loaded>>({});
  const update = useCallback((change: (previous: Record<string, Loaded>) => Record<string, Loaded>) => {
    cache.current = change(cache.current);
    setLoaded(cache.current);
  }, []);
  const sessions = state?.sessions;
  const waiting = useMemo(() => (sessions ?? []).filter(session => session.control === 'managed' && session.pendingApprovalId), [sessions]);

  useEffect(() => {
    const keep = new Set(waiting.map(session => session.id));
    if (Object.keys(cache.current).some(id => !keep.has(id))) update(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => keep.has(id))));
    if (!agents) return;
    for (const session of waiting) {
      const approvalId = session.pendingApprovalId ?? '';
      if (!approvalId || cache.current[session.id]?.approvalId === approvalId) continue;
      update(previous => ({ ...previous, [session.id]: { approvalId, loading: true, items: [] } }));
      agents.sessionEvents(session.id).then(
        events => update(previous => ({ ...previous, [session.id]: { approvalId, loading: false, items: derivePendingApprovals(session, events).filter(item => item.id === approvalId) } })),
        // Without events the request has no action to show; the Office still shows that the agent waits.
        () => update(previous => ({ ...previous, [session.id]: { approvalId, loading: false, items: [] } })),
      );
    }
  }, [agents, waiting, update]);

  const pending = useMemo(() => dedupeApprovals(waiting.flatMap(session => {
    const entry = loaded[session.id];
    return entry && !entry.loading && entry.approvalId === session.pendingApprovalId ? entry.items : [];
  })), [waiting, loaded]);
  const ready = waiting.every(session => {
    const entry = loaded[session.id];
    return Boolean(entry && !entry.loading && entry.approvalId === session.pendingApprovalId);
  });
  const remove = useCallback((approval: PendingApproval) => update(previous => {
    const entry = previous[approval.sessionId];
    if (!entry) return previous;
    return { ...previous, [approval.sessionId]: { ...entry, items: entry.items.filter(item => item.id !== approval.id) } };
  }), [update]);
  return { pending, ready, remove };
}

/**
 * Provides the approval inbox state to the whole shell and shows the inbox
 * dialog. It also raises notifications for new requests while Extalia is in
 * the background, and Alt+A opens or closes the inbox from anywhere.
 */
export function ApprovalProvider({ t, hostKind, agents, state, notifier, children }: {
  t: Messages;
  hostKind: 'desktop' | 'web';
  agents: AgentHostApi | undefined;
  state: HostState | null;
  notifier?: NotificationCapability | undefined;
  children: ReactNode;
}) {
  const { pending, ready, remove } = useWaitingApprovals(agents, state);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string>();
  const [inboxOpen, setInboxOpen] = useState(false);

  const decide = useCallback(async (approval: PendingApproval, choice: ApprovalChoice) => {
    if (!agents) return;
    const key = approvalKey(approval);
    setBusy(previous => new Set(previous).add(key));
    setError(undefined);
    try {
      await agents.resolveApproval(approval.sessionId, approval.id, decisionFor(choice));
      remove(approval);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(previous => { const next = new Set(previous); next.delete(key); return next; });
    }
  }, [agents, remove]);

  // Notifications: the first settled list is the baseline; only later arrivals notify.
  const seen = useRef(new Set<string>());
  const baselined = useRef(false);
  useEffect(() => {
    // Nothing is compared before the host state has loaded, or the approvals already waiting would count as new.
    if (!ready || !state) return;
    if (!baselined.current) {
      baselined.current = true;
      for (const item of pending) seen.current.add(approvalKey(item));
      return;
    }
    const fresh = freshApprovals(seen.current, pending);
    for (const item of fresh) seen.current.add(approvalKey(item));
    if (!notifier || !fresh.length) return;
    const attentive = document.visibilityState === 'visible' && document.hasFocus();
    if (!shouldNotify({ enabled: approvalNotificationsEnabled(hostKind), attentive, fresh: fresh.length })) return;
    const content = notificationContent(fresh, {
      one: name => t.approvalInbox.notify.one(name),
      many: count => t.approvalInbox.notify.many(count),
      unnamed: t.approvalInbox.unnamedAgent,
    });
    void notifier.notify(content).catch(() => undefined);
  }, [pending, ready, state, notifier, hostKind, t]);

  useEffect(() => notifier?.onActivate(() => setInboxOpen(true)), [notifier]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== 'KeyA' || event.repeat) return;
      event.preventDefault();
      setInboxOpen(open => !open);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const value = useMemo<ApprovalsValue>(() => ({
    pending,
    busy: approval => busy.has(approvalKey(approval)),
    decide,
    error,
    inboxOpen,
    openInbox: () => setInboxOpen(true),
    closeInbox: () => setInboxOpen(false),
  }), [pending, busy, decide, error, inboxOpen]);

  return <ApprovalsContext value={value}>
    {children}
    {inboxOpen && <ApprovalInboxDialog t={t} onClose={() => setInboxOpen(false)} />}
  </ApprovalsContext>;
}
