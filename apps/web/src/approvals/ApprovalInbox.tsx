import { useEffect, useId, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { useApprovals } from './context';
import { approvalKey, type ApprovalChoice, type PendingApproval } from './model';

/** Topbar button with the number of approvals waiting, on every page. */
export function ApprovalInboxButton({ t }: { t: Messages }) {
  const { pending, inboxOpen, openInbox, closeInbox } = useApprovals();
  const copy = t.approvalInbox;
  const count = pending.length;
  return <button type="button" className="icon-button approval-inbox-button" data-count={count || undefined}
    aria-label={count ? copy.buttonCount(count) : copy.button} aria-haspopup="dialog" aria-expanded={inboxOpen} title={`${copy.button} · ${copy.shortcut}`}
    onClick={() => (inboxOpen ? closeInbox() : openInbox())}>
    <Icon name="shield" />
    {count > 0 && <span className="approval-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
  </button>;
}

/**
 * Answer buttons for one approval. The same handlers serve the inbox, the
 * Office board row and the avatar card. Only the choices the host supports appear.
 */
export function ApprovalActions({ t, approval, compact = false }: { t: Messages; approval: PendingApproval; compact?: boolean }) {
  const { busy, decide } = useApprovals();
  if (!approval.choices.length) return null;
  const working = busy(approval);
  const offers = (choice: ApprovalChoice) => approval.choices.includes(choice);
  return <div className={`actions approval-actions${compact ? ' compact' : ''}`} role="group" aria-label={`${t.approval.title}: ${approval.action}`}>
    {offers('allow-once') && <button type="button" className="primary" disabled={working} onClick={() => void decide(approval, 'allow-once')}><Icon name="check" />{t.approval.allowOnce}</button>}
    {offers('allow-session') && <button type="button" disabled={working} onClick={() => void decide(approval, 'allow-session')}>{t.approval.allowSession}</button>}
    {offers('deny') && <button type="button" className="danger" disabled={working} onClick={() => void decide(approval, 'deny')}><Icon name="close" />{t.approval.deny}</button>}
  </div>;
}

/**
 * The inbox: every approval that waits, oldest first, with its agent, session,
 * action (redacted) and answers. Modal: focus stays inside, Escape closes it
 * and focus returns to the button that opened it.
 */
export function ApprovalInboxDialog({ t, onClose }: { t: Messages; onClose(): void }) {
  const { pending, error } = useApprovals();
  const copy = t.approvalInbox;
  const titleId = useId();
  const leadId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [opener] = useState<HTMLElement | null>(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [opener]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        // Captured on window: the Office card underneath must not also close on this press.
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && panel.current.contains(active);
      if (event.shiftKey && (!inside || active === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || active === last)) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const time = (value: string) => new Date(value).toLocaleTimeString(document.documentElement.lang || undefined, { hour: '2-digit', minute: '2-digit' });
  return <div className="approval-inbox-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="approval-inbox card" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={leadId}>
      <header className="approval-inbox-head">
        <div>
          <h2 id={titleId}>{copy.title}</h2>
          <p id={leadId} className="muted">{copy.lead}</p>
        </div>
        <button type="button" className="icon-button small" data-autofocus aria-label={copy.close} onClick={onClose}><Icon name="close" /></button>
      </header>
      {error && <p role="alert" className="form-error">{error}</p>}
      {pending.length === 0 ? <p className="approval-inbox-empty">{copy.empty}</p> : <ol className="approval-list">
        {pending.map(item => <li key={approvalKey(item)} className={`approval-item risk-${item.risk}`}>
          <div className="approval-item-head">
            <strong>{item.agentName || copy.unnamedAgent}</strong>
            {item.sessionTitle && <span className="approval-session">{item.sessionTitle}</span>}
            <span className="approval-source">{copy.sources[item.source]}</span>
            <span className={`risk ${item.risk}`}>{t.approval.risk[item.risk]}</span>
          </div>
          <p className="approval-item-action">{item.action}</p>
          {item.detail && <pre className="approval-item-detail">{item.detail}</pre>}
          <p className="approval-item-meta"><time dateTime={item.requestedAt}>{copy.asked(time(item.requestedAt))}</time></p>
          <ApprovalActions t={t} approval={item} />
        </li>)}
      </ol>}
    </div>
  </div>;
}
