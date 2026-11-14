import { useEffect, useMemo, type RefObject } from 'react';
import type { AgentHostApi } from '@extalia/platform';
import { errorMessage } from '../host/remote';
import { observedReadCandidate } from './observedRead';

/** Acknowledge only the source revision whose latest assistant output reached this viewport. */
export function useObservedRead({ agents, sessionId, revision, loadedRevision, unread, latestAssistant, renderedAssistant, active, viewKey, region, follow }: {
  agents: AgentHostApi; sessionId?: string; revision?: string; loadedRevision?: string; unread?: boolean;
  latestAssistant?: string; renderedAssistant?: string; active: boolean; viewKey?: string; region: RefObject<HTMLDivElement | null>;
  follow: RefObject<{ sessionId: string; pinned: boolean }>;
}) {
  const receipts = useMemo(() => ({ agents, pending: new Set<string>(), acknowledged: undefined as string | undefined, unsupported: false }), [agents]);
  useEffect(() => {
    if (!agents.markObservedRead || receipts.unsupported || !sessionId || !revision || !unread || !active) return;
    const panel = region.current?.querySelector<HTMLElement>(':scope > .conversation-panel');
    if (!panel) return;
    let alive = true;
    const acknowledge = () => {
      if (!alive) return;
      const assistants = panel.querySelectorAll<HTMLElement>('.msg.assistant');
      const assistant = assistants.item(assistants.length - 1);
      const bounds = panel.getBoundingClientRect(), outputBounds = assistant?.getBoundingClientRect();
      const candidate = observedReadCandidate({ sessionId, revision, loadedRevision, unread, latestAssistant, renderedAssistant,
        visible: !document.hidden && document.hasFocus() && !panel.hidden && panel.clientHeight > 0 && bounds.width > 0 && bounds.bottom > 0 && bounds.top < window.innerHeight,
        pinned: follow.current?.sessionId === sessionId && follow.current.pinned,
        atLatest: panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100,
        assistantVisible: Boolean(outputBounds && outputBounds.bottom > Math.max(bounds.top, 0) && outputBounds.top < Math.min(bounds.bottom, window.innerHeight)),
      });
      if (!candidate) return;
      const key = JSON.stringify([candidate.sessionId, candidate.revision]);
      if (receipts.pending.has(key) || receipts.acknowledged === key) return;
      receipts.pending.add(key);
      void agents.markObservedRead!(candidate.sessionId, candidate.revision).then(() => { if (alive) receipts.acknowledged = key; }, failure => {
        const message = errorMessage(failure);
        if (['Unknown method.', 'This host does not support this action.'].includes(message)
          || /^No handler registered for '[^']*markObservedRead[^']*'$/.test(message)) receipts.unsupported = true;
      }).finally(() => receipts.pending.delete(key));
    };
    const frame = requestAnimationFrame(acknowledge);
    const visibility = new MutationObserver(acknowledge);
    visibility.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    panel.addEventListener('scroll', acknowledge, { passive: true });
    document.addEventListener('visibilitychange', acknowledge);
    window.addEventListener('resize', acknowledge);
    window.addEventListener('focus', acknowledge);
    return () => { alive = false; cancelAnimationFrame(frame); visibility.disconnect(); panel.removeEventListener('scroll', acknowledge); document.removeEventListener('visibilitychange', acknowledge); window.removeEventListener('resize', acknowledge); window.removeEventListener('focus', acknowledge); };
  }, [agents, sessionId, revision, loadedRevision, unread, latestAssistant, renderedAssistant, active, viewKey, region, follow, receipts]);
}
