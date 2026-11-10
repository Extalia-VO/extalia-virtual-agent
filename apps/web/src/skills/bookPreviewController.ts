export interface BookPreviewPoint { id: string; clientX: number; clientY: number; origin: 'pointer' | 'focus' }
export interface BookPreviewSnapshot extends BookPreviewPoint { exiting: boolean }
export interface PreviewFrames { request(callback: () => void): number; cancel(frame: number): void }
export const BOOK_PREVIEW_FADE_MS = 120;

/** A trailing pointer sample per frame, with Escape held until the next entry. */
export function createBookPreviewController(scope: string | { key: string; context?: object }, frames: PreviewFrames, reducedMotion: () => boolean = () => false) {
  let active: BookPreviewSnapshot | null = null;
  let pending: BookPreviewPoint | null = null;
  let blocked: string | null = null;
  let frame: number | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: BookPreviewSnapshot | null) => {
    if (active === next) return;
    active = next; listeners.forEach(listener => listener());
  };
  const cancel = () => { if (frame !== null) frames.cancel(frame); frame = null; pending = null; };
  const cancelExit = () => { if (exitTimer !== null) clearTimeout(exitTimer); exitTimer = null; };
  const exit = () => {
    cancel();
    if (reducedMotion()) { cancelExit(); publish(null); return; }
    if (!active || active.exiting) return;
    publish({ ...active, exiting: true });
    exitTimer = setTimeout(() => { exitTimer = null; publish(null); }, BOOK_PREVIEW_FADE_MS);
  };
  const clear = () => { cancel(); cancelExit(); blocked = null; publish(null); };
  return {
    scope,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => active,
    show(point: BookPreviewPoint) {
      if (!Number.isFinite(point.clientX) || !Number.isFinite(point.clientY) || blocked === point.id) return;
      blocked = null;
      pending = point;
      if (frame === null) frame = frames.request(() => {
        frame = null; const next = pending; pending = null;
        if (next) { cancelExit(); publish({ ...next, exiting: false }); }
      });
    },
    leave(origin: BookPreviewPoint['origin']) { if ((pending ?? active)?.origin === origin || blocked) { blocked = null; exit(); } },
    dismiss(immediate = false) {
      blocked = (pending ?? active)?.id ?? blocked;
      if (immediate) { cancel(); cancelExit(); publish(null); } else exit();
    },
    clear,
  };
}

export function bookPreviewPosition(point: Pick<BookPreviewPoint, 'clientX' | 'clientY'>, size: { width: number; height: number }, viewport: { width: number; height: number }) {
  const gap = 18, edge = 12;
  const x = point.clientX + gap + size.width > viewport.width - edge ? point.clientX - size.width - gap : point.clientX + gap;
  const y = point.clientY + gap + size.height > viewport.height - edge ? point.clientY - size.height - gap : point.clientY + gap;
  return { x: Math.max(edge, Math.min(x, viewport.width - size.width - edge)), y: Math.max(edge, Math.min(y, viewport.height - size.height - edge)) };
}

/** Shared lifecycle stays attached only while this catalog/reader scope is mounted. */
export function bindBookPreviewEvents(controller: ReturnType<typeof createBookPreviewController>, windowTarget: EventTarget, documentTarget: EventTarget & { hidden: boolean }) {
  const dismiss = () => controller.dismiss();
  const immediate = () => controller.dismiss(true);
  const hidden = () => { if (documentTarget.hidden) controller.clear(); };
  const escape = (event: Event) => {
    const preview = controller.getSnapshot();
    if ((event as KeyboardEvent).key === 'Escape' && preview && !preview.exiting) {
      event.preventDefault(); event.stopPropagation(); controller.dismiss();
    }
  };
  windowTarget.addEventListener('scroll', immediate, true);
  windowTarget.addEventListener('resize', immediate);
  windowTarget.addEventListener('blur', dismiss);
  windowTarget.addEventListener('keydown', escape, true);
  documentTarget.addEventListener('visibilitychange', hidden);
  return () => {
    controller.clear();
    windowTarget.removeEventListener('scroll', immediate, true);
    windowTarget.removeEventListener('resize', immediate);
    windowTarget.removeEventListener('blur', dismiss);
    windowTarget.removeEventListener('keydown', escape, true);
    documentTarget.removeEventListener('visibilitychange', hidden);
  };
}
