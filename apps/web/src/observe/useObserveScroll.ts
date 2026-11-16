import { useLayoutEffect, useMemo, type RefObject } from 'react';
import { createObserveScroll } from './observeScroll';

/** Keep viewport ownership outside the replaceable transcript/file-preview content. */
export function useObserveScroll({ region, selector, owner, sessionKey, contentReady, onPinnedChange }: {
  region: RefObject<HTMLElement | null>;
  selector?: string;
  owner?: unknown;
  sessionKey: string;
  contentReady: boolean;
  onPinnedChange?: (pinned: boolean) => void;
}) {
  const { controller } = useMemo(() => ({ owner, controller: createObserveScroll() }), [owner]);
  useLayoutEffect(() => {
    controller.update({ sessionKey, contentReady, onPinnedChange });
    controller.mountPanel(selector ? region.current?.querySelector<HTMLElement>(selector) ?? null : region.current);
  });
  useLayoutEffect(() => () => controller.dispose(), [controller]);
  return controller;
}
