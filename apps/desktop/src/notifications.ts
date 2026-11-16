/**
 * Validation for native notifications requested by the renderer (v0.0.48). Pure
 * and free of Electron so the rules can be unit tested; `notificationIpc.ts`
 * connects it to IPC. The renderer redacts the text before it gets here; this
 * layer bounds the text and accepts only the closed navigation target contract.
 */
import { parseNotificationTarget, type NotificationTarget } from '@extalia/platform';
import { isTrustedSender } from './security';

export interface NativeNotification {
  title: string;
  body?: string;
  target?: NotificationTarget;
}

export const NOTIFICATION_TITLE_LIMIT = 80;
export const NOTIFICATION_BODY_LIMIT = 200;
const FIELDS = ['title', 'body', 'target'];
/** Longer input is cut before cleaning, so a huge payload costs little time. */
const INPUT_LIMIT = 2_000;

/** Single-line text: control characters become spaces, whitespace collapses, the length is bounded with an ellipsis. */
function clean(value: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  const single = value.slice(0, INPUT_LIMIT).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1).trimEnd()}…`;
}

/** Accept only bounded text and an optional closed navigation target. */
export function parseNotification(value: unknown): NativeNotification {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Notification must be an object.');
  // Own keys only: a key such as `__proto__` or an extra `url` or `approvalId` is refused.
  if (Object.keys(value).some(key => !FIELDS.includes(key))) throw new Error('Unknown notification field.');
  const { title, body, target } = value as { title?: unknown; body?: unknown; target?: unknown };
  if (typeof title !== 'string') throw new Error('Notification title must be text.');
  if (body !== undefined && typeof body !== 'string') throw new Error('Notification body must be text.');
  const cleanTitle = clean(title, NOTIFICATION_TITLE_LIMIT);
  if (!cleanTitle) throw new Error('Notification title is empty.');
  const cleanBody = body === undefined ? '' : clean(body, NOTIFICATION_BODY_LIMIT);
  return { title: cleanTitle, ...(cleanBody ? { body: cleanBody } : {}), ...(target !== undefined ? { target: parseNotificationTarget(target) } : {}) };
}

/** Only the app's own pages may raise notifications; the payload is parsed only after the sender is trusted. */
export function acceptNotification(senderUrl: string | undefined, devServer: URL | undefined, value: unknown): NativeNotification {
  if (!isTrustedSender(senderUrl, devServer)) throw new Error('Untrusted sender.');
  return parseNotification(value);
}
