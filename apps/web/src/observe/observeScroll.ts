export interface ObserveScrollUpdate {
  sessionKey: string;
  /** False while a refresh has replaced the transcript with incomplete/error content. */
  contentReady: boolean;
  onPinnedChange?: ((pinned: boolean) => void) | undefined;
}

interface Anchor { id: string; offset: number }
interface Geometry { height: number; viewport: number }
const tolerance = 1;

/** Owns viewport intent only: no transcript contents survive a refresh. */
export function createObserveScroll({ onPinnedChange }: { onPinnedChange?: (pinned: boolean) => void } = {}) {
  let notify = onPinnedChange;
  let panel: HTMLElement | null = null;
  let sessionKey: string | undefined;
  let contentReady = true;
  let pinned = true;
  let savedTop = 0;
  let anchor: Anchor | undefined;
  let geometry: Geometry | undefined;
  let expectedTop: number | undefined;
  let mutation: MutationObserver | undefined;
  let resize: ResizeObserver | undefined;
  const resizedChildren = new Set<Element>();
  const visible = () => Boolean(panel && !panel.hidden && panel.clientHeight);
  const measure = (): Geometry => ({ height: panel!.scrollHeight, viewport: panel!.clientHeight });
  // Root rows have ordered bounds; nested worker previews must not become parent anchors.
  const anchors = () => panel!.querySelectorAll<HTMLElement>(':scope > .transcript > [data-transcript-id]');
  const setPinned = (value: boolean) => {
    if (pinned === value) return;
    pinned = value;
    notify?.(value);
  };
  const remember = () => {
    if (!panel) return;
    savedTop = panel.scrollTop;
    anchor = undefined;
    const top = panel.getBoundingClientRect().top;
    const rows = anchors();
    let start = 0, end = rows.length;
    // A long imported transcript still needs only logarithmic layout reads per scroll.
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (rows[middle]!.getBoundingClientRect().bottom <= top) start = middle + 1;
      else end = middle;
    }
    const element = rows[start];
    if (element) {
      anchor = { id: element.dataset.transcriptId!, offset: element.getBoundingClientRect().top - top };
    }
  };
  const observeChildren = () => {
    if (!panel || !resize) return;
    for (const child of resizedChildren) if (child.parentElement !== panel) {
      resize.unobserve(child); resizedChildren.delete(child);
    }
    for (const child of panel.children) if (!resizedChildren.has(child)) {
      resizedChildren.add(child); resize.observe(child);
    }
  };
  const refresh = () => {
    if (!panel) return;
    observeChildren();
    if (!visible()) return;
    let target = pinned ? panel.scrollHeight : savedTop;
    if (!pinned && contentReady && anchor) {
      for (const element of anchors()) if (element.dataset.transcriptId === anchor.id) {
        target = panel.scrollTop + element.getBoundingClientRect().top - panel.getBoundingClientRect().top - anchor.offset;
        savedTop = Math.max(0, target);
        break;
      }
    }
    target = Math.max(0, Math.min(target, panel.scrollHeight - panel.clientHeight));
    expectedTop = target;
    geometry = measure();
    if (Math.abs(panel.scrollTop - target) > tolerance) panel.scrollTop = target;
  };
  const onScroll = () => {
    if (!panel || !visible()) return;
    const next = measure();
    if (expectedTop !== undefined && Math.abs(panel.scrollTop - expectedTop) <= tolerance) {
      geometry = next;
      return;
    }
    // Browser clamping and layout changes are not a request to leave the latest output.
    if (!contentReady || geometry?.height !== next.height || geometry?.viewport !== next.viewport) {
      refresh();
      return;
    }
    expectedTop = undefined;
    geometry = next;
    setPinned(panel.scrollHeight - panel.scrollTop - panel.clientHeight < 100);
    remember();
  };
  const onInput = (event: Event) => {
    if (!contentReady) return;
    if ((event as WheelEvent).deltaY < 0) {
      setPinned(false);
      remember();
    }
  };
  const detach = () => {
    mutation?.disconnect(); resize?.disconnect(); resizedChildren.clear();
    if (panel) {
      panel.removeEventListener('scroll', onScroll);
      panel.removeEventListener('wheel', onInput);
    }
    panel = null; geometry = undefined; expectedTop = undefined;
  };
  const mountPanel = (next: HTMLElement | null) => {
    if (next === panel) return;
    detach();
    panel = next;
    if (!panel) return;
    panel.addEventListener('scroll', onScroll, { passive: true });
    panel.addEventListener('wheel', onInput, { passive: true });
    if (typeof MutationObserver !== 'undefined') {
      mutation = new MutationObserver(refresh);
      mutation.observe(panel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    }
    if (typeof ResizeObserver !== 'undefined') {
      resize = new ResizeObserver(refresh);
      resize.observe(panel);
    }
    refresh();
  };
  return {
    mountPanel,
    update(next: ObserveScrollUpdate) {
      if ('onPinnedChange' in next) notify = next.onPinnedChange;
      if (sessionKey !== next.sessionKey) {
        sessionKey = next.sessionKey; savedTop = 0; anchor = undefined;
        setPinned(true);
      }
      contentReady = next.contentReady;
      refresh();
    },
    refresh,
    jumpToLatest() { setPinned(true); anchor = undefined; refresh(); },
    dispose: detach,
  };
}
