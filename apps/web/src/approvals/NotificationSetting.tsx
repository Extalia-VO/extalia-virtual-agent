import type { NotificationCapability } from '@extalia/platform';
import { useState } from 'react';
import type { Messages } from '../i18n';
import { browserNotificationPermission } from './browserNotifications';
import { approvalNotificationsEnabled, saveApprovalNotifications } from './notify';

/**
 * Settings toggle for approval notifications. Turning it on in the browser asks
 * for notification permission first; a refusal leaves it off with the reason shown.
 */
export function ApprovalNotificationSetting({ t, hostKind, notifier }: { t: Messages; hostKind: 'desktop' | 'web'; notifier?: NotificationCapability | undefined }) {
  const copy = t.approvalInbox.settings;
  const [enabled, setEnabled] = useState(() => approvalNotificationsEnabled(hostKind));
  const [note, setNote] = useState<string>();
  const unsupported = !notifier;

  const toggle = async () => {
    setNote(undefined);
    if (enabled) {
      saveApprovalNotifications(false);
      setEnabled(false);
      return;
    }
    if (hostKind === 'web') {
      const permission = browserNotificationPermission();
      if (permission === 'unsupported') { setNote(copy.unsupported); return; }
      if (permission === 'default') {
        const answer = await Notification.requestPermission().catch(() => 'denied' as NotificationPermission);
        if (answer !== 'granted') { setNote(copy.blocked); return; }
      } else if (permission !== 'granted') {
        setNote(copy.blocked);
        return;
      }
    }
    saveApprovalNotifications(true);
    setEnabled(true);
  };

  return <div className="approval-notify-setting">
    <p><strong>{copy.toggle}</strong></p>
    <p className="muted">{copy.hint}</p>
    <div className="actions">
      <button type="button" aria-pressed={enabled && !unsupported} disabled={unsupported} onClick={() => void toggle()}>{enabled && !unsupported ? copy.on : copy.off}</button>
    </div>
    {unsupported && <p className="muted">{copy.unsupported}</p>}
    {note && <p role="alert" className="form-error">{note}</p>}
  </div>;
}
