import { approvalKey, type PendingApproval } from './model';

/**
 * Notification rules for approval requests (v0.0.48). Pure: the provider feeds
 * it the current list and the page state. A notice is sent only for an approval
 * that appeared while the app ran, never for ones already waiting when it
 * opened, and only when the user turned the notification on and Extalia is
 * not in front of them.
 */

const STORAGE_KEY = 'extalia.approvalNotifications';

/** Per-device choice. Desktop shows native notifications by default; the browser needs an explicit opt-in and a permission. */
export function approvalNotificationsEnabled(hostKind: 'desktop' | 'web'): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch {
    // Storage can be blocked; fall back to the default.
  }
  return hostKind === 'desktop';
}

export function saveApprovalNotifications(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Without storage the choice lasts for this page only.
  }
}

/** Approvals that were not in `seen` yet. */
export function freshApprovals(seen: ReadonlySet<string>, current: readonly PendingApproval[]): PendingApproval[] {
  return current.filter(item => !seen.has(approvalKey(item)));
}

/** Notify only when turned on, when Extalia is not visible and focused, and when something new arrived. */
export function shouldNotify(input: { enabled: boolean; attentive: boolean; fresh: number }): boolean {
  return input.enabled && !input.attentive && input.fresh > 0;
}

/** Title and body for the new approvals. Text is already redacted by the model; secrets never reach it. */
export function notificationContent(fresh: readonly PendingApproval[], copy: { one(name: string): string; many(count: number): string; unnamed: string }): { title: string; body: string } {
  const names = fresh.map(item => item.agentName || copy.unnamed);
  if (fresh.length === 1) {
    const [only] = fresh;
    return { title: copy.one(names[0] ?? copy.unnamed), body: only?.action ?? '' };
  }
  return { title: copy.many(fresh.length), body: [...new Set(names)].slice(0, 3).join(', ') };
}
