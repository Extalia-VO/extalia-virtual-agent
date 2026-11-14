import { errorMessage } from '../host/remote';

/** Downgrade only a missing capability; network, auth and server failures stay visible. */
export function missingSessionBrowserCapability(error: unknown): boolean {
  const message = errorMessage(error);
  return ['Unknown method.', 'This host does not support this action.'].includes(message)
    || /^No handler registered for '[^']*sessionBrowser(?:Groups|Sessions)[^']*'$/.test(message);
}
