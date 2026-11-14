import { useEffect, useMemo } from 'react';
import { useApprovals } from '../approvals/context';
import { approvalKey, type PendingApproval } from '../approvals/model';
import { useObservedInputs } from '../observe/ObservedInputProvider';
import { observedInputKey, type ObservedInputView } from '../observe/observedInputModel';
import { createOfficeAttentionQueue, type OfficeAttentionRequest } from './officeAttentionQueue';
import type { OfficeAttentionOutcome } from './officeInputFocus';
import { officeAttentionOverlayOpen, useOfficeForeground } from './useOfficeForeground';

/** Eligible live requests only. Read-only, uncertain and history-only cards stay manual. */
export function officeAttentionRequests(approvals: readonly PendingApproval[], entries: ObservedInputView['entries']): OfficeAttentionRequest[] {
  return [
    ...approvals.filter(item => item.choices.length > 0).map(item => ({
      key: `approval:${approvalKey(item)}`, kind: 'approval' as const, sessionId: item.sessionId,
      requestId: item.id, requestedAt: item.requestedAt,
    })),
    ...Object.entries(entries).flatMap(([sessionId, entry]) => entry.phase !== 'ready' ? [] : entry.requests
      .filter(request => request.state === 'pending' && request.canAnswer && request.identityVerified !== false)
      .map(request => ({ key: `input:${observedInputKey(sessionId, entry.source, request)}`, kind: 'input' as const,
        sessionId, requestId: request.id, ...(request.askedAt ? { requestedAt: request.askedAt } : {}) }))),
  ];
}

const attentive = () => typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus();

/** Remains mounted across pages, so dismissing a request does not reopen it on each poll. */
export function OfficeAutoAttention({ active, scope, busy, onLocate }: {
  active: boolean; scope: string; busy: boolean; onLocate(request: OfficeAttentionRequest, onSettled: (outcome: OfficeAttentionOutcome) => void): void;
}) {
  const approvals = useApprovals(), inputs = useObservedInputs();
  const owner = useMemo(() => ({ scope, queue: createOfficeAttentionQueue() }), [scope]);
  const queue = owner.queue;
  const requests = officeAttentionRequests(approvals.pending, inputs?.view.entries ?? {});
  const requestKey = JSON.stringify(requests);
  const foreground = useOfficeForeground();
  useEffect(() => {
    if (!foreground) return;
    const current = JSON.parse(requestKey) as OfficeAttentionRequest[];
    // The inbox already presents the complete Native approval list.
    if (approvals.inboxOpen) {
      const shown = current.filter(request => request.kind === 'approval');
      while (queue.take(shown, { active: true, blocked: false })) { /* Already presented. */ }
    }
    if (!active || busy || !current.length) return;
    const attempt = () => {
      if (!attentive()) return false;
      const blocked = officeAttentionOverlayOpen();
      const next = queue.take(current, { active: true, blocked });
      if (next) { onLocate(next, outcome => { if (outcome === 'retry') queue.release(next.key); }); return false; }
      return blocked;
    };
    // Only poll while another dialog blocks an outstanding request. No permanent observer/frame work.
    if (!attempt()) return;
    const timer = window.setInterval(() => { if (!attempt()) window.clearInterval(timer); }, 400);
    return () => window.clearInterval(timer);
  }, [active, foreground, busy, requestKey, queue, onLocate, approvals.inboxOpen]);
  return null;
}
