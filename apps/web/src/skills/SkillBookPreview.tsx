import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { bindBookPreviewEvents, bookPreviewPosition, createBookPreviewController, type BookPreviewSnapshot } from './bookPreviewController';
import type { SkillBook } from './skillLibraryModel';
import type { ShelfHover } from './skillShelfRenderer';

const emptyPreview = () => null;

export function useSkillBookPreview(scope: string, context?: object) {
  const controller = useMemo(() => createBookPreviewController({ key: scope, context }, {
    request: callback => requestAnimationFrame(callback), cancel: frame => cancelAnimationFrame(frame),
  }, () => window.matchMedia('(prefers-reduced-motion: reduce)').matches), [scope, context]);
  const preview = useSyncExternalStore(controller.subscribe, controller.getSnapshot, emptyPreview);
  const id = useId();
  useEffect(() => bindBookPreviewEvents(controller, window, document), [controller]);
  const onHover = useCallback((hover: ShelfHover | null) => {
    if (hover) controller.show({ ...hover, origin: 'pointer' }); else controller.leave('pointer');
  }, [controller]);
  const onFocus = useCallback((event: FocusEvent<HTMLButtonElement>) => {
    // Touch/click focus already exposes the persistent button label.
    const bookId = event.currentTarget.dataset.bookId;
    if (!bookId || !event.currentTarget.matches(':focus-visible')) return;
    const rect = event.currentTarget.getBoundingClientRect();
    controller.show({ id: bookId, clientX: rect.left, clientY: rect.bottom, origin: 'focus' });
  }, [controller]);
  const onPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const bookId = event.currentTarget.dataset.bookId;
    if (event.pointerType === 'mouse' && bookId) controller.show({ id: bookId, clientX: event.clientX, clientY: event.clientY, origin: 'pointer' });
  }, [controller]);
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    const active = controller.getSnapshot();
    if (event.key === 'Escape' && active && !active.exiting) {
      event.preventDefault(); event.stopPropagation(); controller.dismiss();
    }
  }, [controller]);
  return { preview, id, onHover, onFocus, onPointerMove, onKeyDown, onBlur: () => controller.leave('focus'), clear: controller.clear };
}

export function SkillBookPreview({ preview, book, category, originLabel, id }: { preview: BookPreviewSnapshot; book: SkillBook; category: string; originLabel?: string; id: string }) {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tooltip = element.current;
    if (!tooltip) return;
    const { width, height } = tooltip.getBoundingClientRect();
    const position = bookPreviewPosition(preview, { width, height }, { width: window.innerWidth, height: window.innerHeight });
    tooltip.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
    tooltip.style.visibility = 'visible';
  }, [preview, book.title, category, originLabel]);
  return createPortal(<div ref={element} id={id} role="tooltip" aria-hidden={preview.exiting || undefined} data-exiting={preview.exiting} className="skill-book-preview" style={{ visibility: 'hidden' }}>
    <span className="skill-preview-sigil" aria-hidden="true">✦</span><div><strong>{book.title}</strong><span>{category}</span>{originLabel && <span className="skill-origin-badge" data-origin={book.origin ?? book.source}>{originLabel}</span>}</div>
  </div>, document.body);
}
