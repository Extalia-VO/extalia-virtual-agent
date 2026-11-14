import type { NotificationCapability } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { browserNotificationPermission } from './browserNotifications';
import { approvalNotificationsEnabled, saveApprovalNotifications } from './notify';

/**
 * Settings toggle for approval notifications. Turning it on in the browser asks
 * for notification permission first; a refusal leaves it off with the reason shown.
 */
type Props = { t: Messages; hostKind: 'desktop' | 'web'; notifier?: NotificationCapability | undefined };
export function ApprovalNotificationSetting(props: Props) {
  const [scope, setScope] = useState({ hostKind: props.hostKind, notifier: props.notifier, key: 0 });
  const changed = scope.hostKind !== props.hostKind || scope.notifier !== props.notifier;
  const key = scope.key + (changed ? 1 : 0);
  if (changed) setScope({ hostKind: props.hostKind, notifier: props.notifier, key });
  return <NotificationSetting key={key} {...props} />;
}
function NotificationSetting({ t, hostKind, notifier }: Props) {
  const copy = t.approvalInbox.settings;
  const [enabled, setEnabled] = useState(() => approvalNotificationsEnabled(hostKind));
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);
  const owner = useRef({ active: true, pending: false });
  useEffect(() => {
    const operation = { active: true, pending: false }; owner.current = operation;
    return () => { operation.active = false; };
  }, []);
  const unsupported = !notifier;

  const toggle = async () => {
    const operation = owner.current;
    if (unsupported || !operation.active || operation.pending) return;
    setNote(undefined);
    if (enabled) {
      saveApprovalNotifications(false);
      setEnabled(false);
      return;
    }
    operation.pending = true; setBusy(true);
    try {
      if (hostKind === 'web') {
        const permission = browserNotificationPermission();
        if (permission === 'unsupported') { setNote(copy.unsupported); return; }
        if (permission === 'default') {
          const answer = await Notification.requestPermission();
          if (!operation.active) return;
          if (answer !== 'granted') { setNote(copy.blocked); return; }
        } else if (permission !== 'granted') {
          setNote(copy.blocked);
          return;
        }
      }
      if (!operation.active) return;
      saveApprovalNotifications(true);
      setEnabled(true);
    } catch {
      if (operation.active) setNote(copy.blocked);
    } finally {
      operation.pending = false;
      if (operation.active) setBusy(false);
    }
  };

  return <div className="approval-notify-setting">
    <p><strong>{copy.toggle}</strong></p>
    <p className="muted">{copy.hint}</p>
    <div className="actions">
      <button type="button" aria-pressed={enabled && !unsupported} aria-busy={busy || undefined} disabled={unsupported || busy} onClick={() => void toggle()}>{busy ? t.common.loading : enabled && !unsupported ? copy.on : copy.off}</button>
    </div>
    {unsupported && <p className="muted">{copy.unsupported}</p>}
    {note && <p role="alert" className="form-error">{note}</p>}
  </div>;
}
