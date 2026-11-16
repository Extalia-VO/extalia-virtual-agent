import { useSyncExternalStore } from 'react';
const snapshot = () => document.visibilityState === 'visible' && document.hasFocus();
function subscribe(change: () => void) {
  window.addEventListener('focus', change); window.addEventListener('blur', change);
  document.addEventListener('visibilitychange', change);
  return () => { window.removeEventListener('focus', change); window.removeEventListener('blur', change); document.removeEventListener('visibilitychange', change); };
}
/** A background Office may notify, but never takes foreground keyboard focus. */
export const useOfficeForeground = () => useSyncExternalStore(subscribe, snapshot, () => false);

/** Existing dialogs and open pickers keep their keyboard/focus ownership. */
export function officeAttentionOverlayOpen(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open], [role="listbox"]')]
    .some(element => !element.hidden && element.getClientRects().length > 0);
}
