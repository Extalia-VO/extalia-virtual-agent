import { useEffect, useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import type { PromptQueueView } from './promptQueueModel';
import './promptQueue.css';

export type PromptDeliveryPhase = 'submitting' | 'accepted' | 'unknown' | 'failed';
export interface PromptDeliveryStatusProps {
  t: Messages;
  queueView?: PromptQueueView;
  phase?: PromptDeliveryPhase;
  observed?: boolean;
  onRecheck?: () => void;
  rechecking?: boolean;
  /** Only offered after a fresh read excludes sending/unknown host receipts. */
  onRetryConfirmed?: () => void;
}

/** Always outside queue details: a CLI receipt never claims that Codex read a message. */
export function PromptDeliveryStatus({ t, queueView, phase, observed = false, onRecheck, rechecking = false, onRetryConfirmed }: PromptDeliveryStatusProps) {
  const c = t.promptDelivery, items = queueView?.status?.items ?? [];
  const unknown = phase === 'unknown' || queueView?.delivery === 'unknown' || items.some(item => item.state === 'unknown');
  const submitting = phase === 'submitting' || queueView?.delivery === 'submitting';
  const sending = items.some(item => item.state === 'sending');
  const failed = phase === 'failed' || queueView?.delivery === 'failed';
  const waiting = !unknown && !failed && (submitting || sending);
  const [slow, setSlow] = useState(false);
  if (!waiting && slow) setSlow(false);
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(timer);
  }, [waiting]);
  const text = unknown ? c.unknown : submitting ? slow ? c.stillWaiting : c.submitting
    : failed ? c.failed
      : sending ? slow ? c.stillWaiting : observed ? c.sendingCodex : c.sending
        : items.some(item => item.state === 'pending') ? c.queued
        : items.some(item => item.state === 'sent') ? observed ? c.codexSubmitted : c.accepted
          : phase === 'accepted' || queueView?.delivery === 'accepted' ? queueView ? c.queued : observed ? c.codexQueued : c.accepted
          : undefined;
  if (!text) return null;
  return <div className={`prompt-delivery-status${unknown ? ' prompt-delivery-uncertain' : ''}`}>
    <p role="status" aria-live="polite" aria-atomic="true">
      {waiting && <Icon name="refresh" className="spin" />}<span>{text}</span>
    </p>
    {unknown && onRecheck && <button type="button" disabled={rechecking} onClick={onRecheck}>{c.recheck}</button>}
    {unknown && !items.some(item => item.state === 'sending' || item.state === 'unknown') && onRetryConfirmed
      && <button type="button" disabled={rechecking} onClick={onRetryConfirmed}>{c.allowRetry}</button>}
  </div>;
}
